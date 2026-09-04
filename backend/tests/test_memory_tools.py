"""The two memory voice tools (spec §5.1).

Replaces test_remember_tool.py, whose assertions were about a markdown file
that is no longer the store. Every behaviour it checked is checked here — the
definition's shape, a user fact, a project fact, the soft errors, the event and
the journal line — plus everything the row-backed version adds.

The first test is the one that protects her responsiveness: `remember` must
not embed.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import config  # noqa: E402
import tools  # noqa: E402
from yuri import app as yapp  # noqa: E402
from yuri.providers.fake import FakeAgentProvider  # noqa: E402
from yuri.services.embedding import FakeEmbedder  # noqa: E402


class Base(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.mkdir(os.path.join(self.tmp.name, "proj"))
        self.patches = [mock.patch.dict(os.environ, {"ALLOWED_PROJECT_ROOTS": self.tmp.name}),
                        mock.patch.object(config, "YURI_HOME", os.path.join(self.tmp.name, "Yuri"))]
        [p.start() for p in self.patches]
        self.c = yapp.test_container(os.path.join(self.tmp.name, "Yuri"), FakeAgentProvider())
        # A real embedder implementation, so the code under test runs
        # unchanged and a test can assert it was NOT called.
        self.embedder = FakeEmbedder()
        self.c.memories.embedder = self.embedder
        self.q = self.c.bus.subscribe()

    def tearDown(self):
        yapp.set_container(None)
        self.c.store.close()
        [p.stop() for p in self.patches]
        self.tmp.cleanup()

    def _types(self):
        out = []
        while not self.q.empty():
            out.append(self.q.get_nowait().type)
        return out


class RememberTests(Base):
    def test_the_definition_still_takes_a_fact_and_a_project(self):
        d = next(t for t in tools.TOOL_DEFINITIONS if t["name"] == "remember")
        self.assertEqual(d["parameters"]["required"], ["fact"])
        for p in ("project", "kind", "replaces", "inferred"):
            self.assertIn(p, d["parameters"]["properties"], p)

    async def test_remembering_never_embeds(self):
        # THE test for spec §7.2. An inline embedding is 1.37s of silence
        # before she says "Noted."
        await tools.dispatch_tool("remember", {"fact": "prefers dark mode"})
        self.assertEqual(self.embedder.calls, [], "remember embedded inline")

    async def test_a_user_fact_is_stored_and_announced(self):
        out = await tools.dispatch_tool("remember", {"fact": "prefers dark mode"})
        self.assertTrue(out["remembered"])
        self.assertEqual(out["kind"], "fact")
        self.assertIsNone(out["replaced"])
        [m] = self.c.memories.current()
        self.assertEqual((m.body, m.kind, m.subject, m.source, m.origin),
                         ("prefers dark mode", "fact", "user", "stated", "voice"))
        self.assertIn("memory.remembered", self._types())
        self.assertIn("remembered", self.c.journal.read_today())

    async def test_a_preference_is_stored_as_a_preference(self):
        # It matters: preferences are exempt from the core-tier budget, so a
        # rule filed as a fact can be crowded out of her prompt.
        await tools.dispatch_tool("remember", {"fact": "always ask before cancelling",
                                               "kind": "preference"})
        [m] = self.c.memories.current()
        self.assertEqual(m.kind, "preference")

    async def test_a_project_fact_is_filed_under_the_slug(self):
        out = await tools.dispatch_tool("remember", {"fact": "uses uv", "project": "proj"})
        self.assertTrue(out["remembered"])
        [m] = self.c.memories.current()
        self.assertEqual((m.kind, m.subject), ("project", "proj"))
        self.assertIn("proj", out["message"])

    async def test_a_project_wins_over_a_kind_she_also_passed(self):
        # The core tier selects project memories BY SLUG; a `preference` under
        # a slug would never be selected at all.
        await tools.dispatch_tool("remember", {"fact": "uses uv", "project": "proj",
                                               "kind": "preference"})
        [m] = self.c.memories.current()
        self.assertEqual(m.kind, "project")

    async def test_inferred_marks_the_source_and_not_the_body(self):
        out = await tools.dispatch_tool("remember", {"fact": "prefers short answers late at night",
                                                     "inferred": True})
        [m] = self.c.memories.current()
        self.assertEqual(m.source, "inferred")
        self.assertNotIn("I think", m.body)
        self.assertIn("guess", out["message"])

    async def test_remembering_the_same_sentence_twice_is_a_no_op_that_says_so(self):
        await tools.dispatch_tool("remember", {"fact": "prefers dark mode"})
        out = await tools.dispatch_tool("remember", {"fact": "prefers   dark mode"})
        self.assertFalse(out["remembered"])
        self.assertIn("word for word", out["message"])
        self.assertEqual(len(self.c.memories.current()), 1)

    async def test_an_empty_fact_is_a_soft_error(self):
        with self.assertRaises(ValueError):
            await tools.dispatch_tool("remember", {"fact": "   "})

    async def test_a_project_outside_the_sandbox_is_a_soft_error(self):
        with self.assertRaises(ValueError):
            await tools.dispatch_tool("remember", {"fact": "x", "project": "/etc"})

    # --- superseding --------------------------------------------------------

    async def test_replaces_supersedes_the_named_memory_and_says_which(self):
        await tools.dispatch_tool("remember", {"fact": "Always communicate in English or Gujarati",
                                               "kind": "preference"})
        out = await tools.dispatch_tool("remember", {"fact": "Always communicate in Gujarati",
                                                     "kind": "preference",
                                                     "replaces": "English or Gujarati"})
        self.assertTrue(out["remembered"])
        self.assertIn("English or Gujarati", out["replaced"])
        # Named in the message too, so a wrong resolution is audible.
        self.assertIn("English or Gujarati", out["message"])
        current = [m.body for m in self.c.memories.current()]
        self.assertEqual(current, ["Always communicate in Gujarati"])

    async def test_an_ambiguous_replaces_is_a_soft_error_listing_what_matched(self):
        for body in ("Always communicate in English or Gujarati",
                     "Do not mix English and Gujarati"):
            await tools.dispatch_tool("remember", {"fact": body, "kind": "preference"})
        with self.assertRaises(ValueError) as ctx:
            await tools.dispatch_tool("remember", {"fact": "Gujarati only",
                                                   "replaces": "Gujarati"})
        msg = str(ctx.exception)
        self.assertIn("matches several", msg)
        self.assertIn("ask which", msg.lower())
        # And nothing was written, so a retry is clean.
        self.assertEqual(len(self.c.memories.current()), 2)

    async def test_a_replaces_that_matches_nothing_is_a_soft_error(self):
        await tools.dispatch_tool("remember", {"fact": "something"})
        with self.assertRaises(ValueError):
            await tools.dispatch_tool("remember", {"fact": "new thing",
                                                   "replaces": "deployment pipelines"})


class RecallTests(Base):
    async def _remember(self, fact, **kw):
        return await tools.dispatch_tool("remember", {"fact": fact, **kw})

    async def test_recall_returns_attributed_results(self):
        await self._remember("the cycle detector hangs on self-reference")
        out = await tools.dispatch_tool("recall", {"query": "cycle detector"})
        self.assertTrue(out["results"])
        self.assertIn("you told me", out["results"][0]["said"])

    async def test_recall_with_a_project_answers_without_embedding(self):
        await self._remember("uses uv", project="proj")
        self.embedder.calls.clear()
        out = await tools.dispatch_tool("recall", {"query": "uv", "project": "proj"})
        self.assertEqual(out["how"], "filtered")
        self.assertEqual(self.embedder.calls, [])

    async def test_recall_with_no_matches_says_so_rather_than_returning_nothing(self):
        await self._remember("something entirely different")
        out = await tools.dispatch_tool("recall", {"query": "deployment pipelines"})
        self.assertEqual(out["results"], [])
        self.assertIn("do not invent", out["message"])

    async def test_recall_finds_a_memory_that_is_not_embedded_yet(self):
        # Findable immediately, semantically searchable a second later.
        await self._remember("just written", project="proj")
        out = await tools.dispatch_tool("recall", {"query": "written", "project": "proj"})
        self.assertTrue(out["results"])

    async def test_a_bad_project_is_a_soft_error(self):
        with self.assertRaises(ValueError):
            await tools.dispatch_tool("recall", {"query": "x", "project": "/etc"})


class TheToolContractTests(Base):
    def test_both_tools_declare_tier_and_category(self):
        for name in ("remember", "recall"):
            d = next(t for t in tools.TOOL_DEFINITIONS if t["name"] == name)
            self.assertEqual(d.get("tier"), "safe", name)
            self.assertEqual(d.get("category"), "herself", name)

    def test_neither_tool_reaches_the_model_carrying_our_own_fields(self):
        for d in tools.tools_for_model():
            if d["name"] in ("remember", "recall"):
                self.assertEqual(set(d) - {"type", "name", "description", "parameters"}, set())

    def test_no_voice_tool_can_delete_a_memory(self):
        # Losing a memory on a mishearing is not recoverable. Same shape as
        # the no-voice-tool-creates-a-specialist guard.
        forbidden = ("forget", "delete_memory", "remove_memory", "clear_memory",
                     "unremember", "forget_memory")
        names = {d["name"] for d in tools.TOOL_DEFINITIONS}
        self.assertEqual(names & set(forbidden), set())

    def test_remember_keeps_the_one_sentence_rule_it_was_given(self):
        # A rule that was deliberately moved onto this description.
        d = next(t for t in tools.TOOL_DEFINITIONS if t["name"] == "remember")
        self.assertIn("One sentence", d["description"])
