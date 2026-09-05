"""The background embedder (spec §7.2).

Its whole reason is that `remember` must return at sqlite speed. The test that
proves the design works is in test_memory_tools.py (`remember` never calls the
embedder); these prove the worker itself is safe.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from yuri.domain.memory import Memory  # noqa: E402
from yuri.services.embed_worker import EmbedWorker  # noqa: E402
from yuri.services.embedding import EmbeddingUnavailable, FakeEmbedder  # noqa: E402
from yuri.store.sqlite import SqliteStore  # noqa: E402


class Broken:
    def __init__(self):
        self.calls = 0

    async def embed(self, texts):
        self.calls += 1
        raise EmbeddingUnavailable("no key")


class EmbedWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = SqliteStore(os.path.join(self.tmp.name, "y.db"))
        self.store.migrate()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.store.close)
        self.embedder = FakeEmbedder()
        self.worker = EmbedWorker(self.store, self.embedder, idle_s=0.01)

    def _add(self, body, **over) -> Memory:
        m = Memory(body=body, **{"kind": "fact", **over})
        self.store.memories.insert(m)
        return m

    async def test_it_embeds_rows_that_have_no_vector(self):
        m = self._add("something to remember")
        self.assertEqual(await self.worker.drain(), 1)
        self.assertIsNotNone(self.store.memories.get(m.id).embedding)

    async def test_it_batches_rather_than_calling_once_per_row(self):
        for i in range(10):
            self._add(f"memory {i}")
        await self.worker.drain()
        self.assertEqual(len(self.embedder.calls), 1, "one call per row, not per batch")

    async def test_draining_twice_does_nothing_the_second_time(self):
        self._add("once")
        self.assertEqual(await self.worker.drain(), 1)
        self.assertEqual(await self.worker.drain(), 0)

    async def test_an_embedder_failure_leaves_the_row_alone_and_retries(self):
        # A NULL embedding is recoverable; a WRONG one is not.
        m = self._add("will fail first")
        broken = Broken()
        worker = EmbedWorker(self.store, broken)
        self.assertEqual(await worker.drain(), 0)
        self.assertIsNone(self.store.memories.get(m.id).embedding)
        # And the row is still pending, so a later drain with a working
        # embedder picks it up.
        self.assertEqual(await self.worker.drain(), 1)
        self.assertIsNotNone(self.store.memories.get(m.id).embedding)

    async def test_a_failure_never_raises(self):
        # An installation with no GEMINI_API_KEY is supported; the worker must
        # not turn that into a crash on a background task.
        self._add("something")
        worker = EmbedWorker(self.store, Broken())
        self.assertEqual(await worker.drain(), 0)      # no exception

    async def test_a_superseded_row_is_not_embedded(self):
        gone = self._add("retired")
        gone.superseded_by = "x"
        self.store.memories.update(gone)
        self.assertEqual(await self.worker.drain(), 0)
        self.assertEqual(self.embedder.calls, [])

    async def test_stop_is_safe_when_it_was_never_started(self):
        await self.worker.stop()      # no exception

    async def test_start_twice_runs_one_loop(self):
        self.worker.start()
        first = self.worker._task
        self.worker.start()
        self.assertIs(self.worker._task, first)
        await self.worker.stop()

    async def test_the_loop_embeds_without_being_asked(self):
        import asyncio
        m = self._add("the loop should get this")
        self.worker.start()
        try:
            for _ in range(50):
                if self.store.memories.get(m.id).embedding is not None:
                    break
                await asyncio.sleep(0.02)
        finally:
            await self.worker.stop()
        self.assertIsNotNone(self.store.memories.get(m.id).embedding)

    async def test_a_store_that_cannot_be_listed_returns_zero_not_a_crash(self):
        worker = EmbedWorker(object(), self.embedder)   # not a Store
        self.assertEqual(await worker.drain(), 0)
