"""Recall: cheap path, then semantic, then honestly degraded (spec §4.2).

The first two tests are the performance guarantee expressed as tests: a query
carrying a subject or a date window must never touch the embedder, because
that is 0.22ms of SQL against a 1,370ms network call.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from yuri.domain.memory import Memory  # noqa: E402
from yuri.services import recollection  # noqa: E402
from yuri.services.embedding import EmbeddingUnavailable, FakeEmbedder  # noqa: E402
from yuri.services.recollection import (FILTERED, KEYWORD, RECALL_BODY_MAX,  # noqa: E402
                                        RECALL_MAX, SEMANTIC, recall)
from yuri.store.sqlite import SqliteStore  # noqa: E402


class Broken:
    """An embedder that always refuses — the no-key case."""

    async def embed(self, texts):
        raise EmbeddingUnavailable("no key")


class RecallTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = SqliteStore(os.path.join(self.tmp.name, "y.db"))
        self.store.migrate()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.store.close)
        self.repo = self.store.memories
        self.embedder = FakeEmbedder()

    async def _add(self, body, embed=True, day=4, **over) -> Memory:
        m = Memory(body=body, **{"kind": "fact", **over})
        m.created_at = f"2026-09-{day:02d}T12:00:00+00:00"
        if embed:
            [m.embedding] = await self.embedder.embed([body])
            self.embedder.calls.clear()
        self.repo.insert(m)
        return m

    # --- the cheap path, which is the performance guarantee -----------------

    async def test_a_subject_filter_answers_without_embedding(self):
        await self._add("the frontend has no jsdom harness", kind="project", subject="yuri-code")
        out = await recall(self.repo, self.embedder, "jsdom", subject="yuri-code")
        self.assertEqual(out["how"], FILTERED)
        self.assertEqual(self.embedder.calls, [], "the cheap path embedded anyway")
        self.assertEqual(out["results"][0]["body"], "the frontend has no jsdom harness")

    async def test_a_since_filter_answers_without_embedding(self):
        await self._add("old news", day=1)
        await self._add("recent news", day=20)
        out = await recall(self.repo, self.embedder, "news", since="2026-09-10")
        self.assertEqual(out["how"], FILTERED)
        self.assertEqual(self.embedder.calls, [])
        self.assertEqual([r["body"] for r in out["results"]], ["recent news"])

    async def test_an_empty_query_returns_the_most_recent_without_embedding(self):
        await self._add("something", day=1)
        out = await recall(self.repo, self.embedder, "")
        self.assertEqual(self.embedder.calls, [])
        self.assertTrue(out["results"])

    # --- the semantic path --------------------------------------------------

    async def test_a_fuzzy_query_uses_the_semantic_path(self):
        await self._add("the cycle detector hangs on a self-referencing graph")
        await self._add("my favourite colour is blue")
        out = await recall(self.repo, self.embedder, "cycle detector hanging")
        self.assertEqual(out["how"], SEMANTIC)
        self.assertEqual(len(self.embedder.calls), 1)
        self.assertIn("cycle detector", out["results"][0]["body"])

    async def test_an_unembedded_row_is_still_findable_by_the_cheap_path(self):
        # The §7.2 promise: findable immediately, semantically searchable a
        # second later.
        await self._add("just written", embed=False, kind="project", subject="p")
        out = await recall(self.repo, self.embedder, "written", subject="p")
        self.assertEqual([r["body"] for r in out["results"]], ["just written"])

    async def test_a_malformed_stored_vector_does_not_sink_the_search(self):
        good = await self._add("a good memory about testing")
        bad = await self._add("a bad row", embed=False)
        bad.embedding = b"\x00\x00"          # truncated
        self.repo.update(bad)
        out = await recall(self.repo, self.embedder, "testing")
        self.assertEqual(out["how"], SEMANTIC)
        self.assertIn(good.body, [r["body"] for r in out["results"]])

    # --- degrading honestly -------------------------------------------------

    async def test_no_embedder_falls_back_to_keyword_and_says_it_is_degraded(self):
        await self._add("the cycle detector hangs", embed=False)
        out = await recall(self.repo, Broken(), "cycle detector")
        self.assertEqual(out["how"], KEYWORD)
        self.assertTrue(out["degraded"])
        self.assertIn("could not search by meaning", out["message"])
        self.assertTrue(out["results"], "degraded must still find things")

    async def test_a_none_embedder_degrades_rather_than_raising(self):
        await self._add("something findable", embed=False)
        out = await recall(self.repo, None, "findable")
        self.assertEqual(out["how"], KEYWORD)
        self.assertTrue(out["degraded"])

    # --- what the answer says ----------------------------------------------

    async def test_results_are_capped_and_report_the_true_total(self):
        for i in range(40):
            await self._add(f"a memory about testing number {i}")
        out = await recall(self.repo, self.embedder, "testing")
        self.assertEqual(len(out["results"]), RECALL_MAX)
        self.assertEqual(out["matched"], 40)
        self.assertIn("40 in total", out["message"])

    async def test_a_long_body_is_clipped(self):
        await self._add("x" * 900)
        out = await recall(self.repo, self.embedder, "x" * 900)
        self.assertLessEqual(len(out["results"][0]["body"]), RECALL_BODY_MAX)

    async def test_each_result_is_attributed_by_its_source(self):
        await self._add("you said this", source="stated")
        await self._add("this happened", source="observed", kind="observation", subject="p")
        await self._add("she thought this", source="inferred")
        out = await recall(self.repo, self.embedder, "this")
        said = {r["said"].split(" on ")[0] for r in out["results"]}
        self.assertEqual(len(said), 3, f"two sources share a phrasing: {said}")

    async def test_no_match_says_so_rather_than_returning_nothing_quietly(self):
        await self._add("something entirely different")
        out = await recall(self.repo, Broken(), "deployment pipelines")
        self.assertEqual(out["results"], [])
        self.assertIn("do not invent", out["message"])

    async def test_superseded_memories_never_appear(self):
        gone = await self._add("the retired rule about testing")
        gone.superseded_by = "x"
        self.repo.update(gone)
        out = await recall(self.repo, self.embedder, "retired rule about testing")
        self.assertEqual(out["results"], [])

    async def test_the_semantic_scan_is_bounded_and_says_when_it_was(self):
        for i in range(8):
            await self._add(f"a memory about testing number {i}")
        original = recollection.SEMANTIC_SCAN_MAX
        recollection.SEMANTIC_SCAN_MAX = 3
        try:
            out = await recall(self.repo, self.embedder, "testing")
        finally:
            recollection.SEMANTIC_SCAN_MAX = original
        self.assertEqual(out["matched"], 3)
        self.assertIn("3 most recent", out["message"])

    async def test_a_write_is_never_refused_for_being_the_ten_thousandth(self):
        # SEMANTIC_SCAN_MAX bounds the SCAN. Declining to remember something
        # because the store is full would be worse than a slower search.
        original = recollection.SEMANTIC_SCAN_MAX
        recollection.SEMANTIC_SCAN_MAX = 2
        try:
            for i in range(5):
                await self._add(f"memory {i}")
            self.assertEqual(self.repo.count(), 5)
        finally:
            recollection.SEMANTIC_SCAN_MAX = original

    async def test_a_fuzzy_query_still_finds_a_memory_written_seconds_ago(self):
        # Without this she says "Noted", is asked about it in the next breath,
        # and finds nothing — the worker has not run yet and the query carries
        # no project or date for the cheap path to use.
        await self._add("the deployment script needs sudo", embed=False)
        out = await recall(self.repo, self.embedder, "deployment script")
        self.assertTrue(out["results"], "a just-written memory was invisible")
        self.assertEqual(out["results"][0]["body"], "the deployment script needs sudo")

    async def test_ranked_results_still_come_before_unranked_ones(self):
        await self._add("a properly embedded memory about deployment")
        await self._add("an unembedded memory about deployment", embed=False)
        out = await recall(self.repo, self.embedder, "deployment")
        self.assertIn("properly embedded", out["results"][0]["body"])
