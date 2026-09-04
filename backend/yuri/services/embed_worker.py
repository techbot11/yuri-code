"""Embedding in the background, so remembering never makes her pause.

Spec §7.2. An embedding call is 1.37s. Doing it inline in `remember` would
leave her silent for that long before saying "Noted." — on the single most
common memory interaction there is. So a row is written with
`embedding = NULL` and returns at sqlite speed (sub-millisecond), and this
worker fills it in.

The consequence, stated rather than hidden: a new memory is FINDABLE
immediately (the cheap path does not need a vector) and SEMANTICALLY
searchable a second or two later. Nobody notices the delay; everybody would
notice the pause.
"""
from __future__ import annotations

import asyncio
import logging

log = logging.getLogger("yuri.memory.embed")

# One request per batch rather than per row: a batch of 10 costs 2.2s where
# ten single calls cost 13.7s (measured, see embedding.py).
EMBED_BATCH = 10
EMBED_IDLE_S = 5.0


class EmbedWorker:
    """Drains `needing_embedding()` on a loop. Safe to stop having never
    started, like every other lifecycle object in this codebase."""

    def __init__(self, store, embedder, idle_s: float = EMBED_IDLE_S):
        self.store = store
        self.embedder = embedder
        self.idle_s = idle_s
        self._task: asyncio.Task | None = None
        self._stopping = False

    def start(self) -> None:
        if self._task is not None:
            return
        self._stopping = False
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._stopping = True
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):    # noqa: BLE001
            # Teardown never raises: a worker that fails to stop must not stop
            # the process from stopping.
            pass

    async def drain(self, limit: int = 50) -> int:
        """Embed up to `limit` rows. Returns how many were written.

        Never raises. An embedder failure leaves the rows at `NULL`, which is
        recoverable — the next drain retries them. A WRONG vector would not
        be, which is why nothing is written on a partial failure.
        """
        written = 0
        try:
            pending = self.store.memories.needing_embedding(limit=limit)
        except Exception:                              # noqa: BLE001
            log.exception("memory: could not list rows needing an embedding")
            return 0
        for i in range(0, len(pending), EMBED_BATCH):
            batch = pending[i: i + EMBED_BATCH]
            try:
                vectors = await self.embedder.embed([m.body for m in batch])
            except Exception as exc:                   # noqa: BLE001
                # Expected when GEMINI_API_KEY is absent. Logged once per
                # drain at info, not error: an installation with no key is a
                # supported configuration, and recall degrades honestly.
                log.info("memory: %d row(s) left unembedded (%s)", len(batch), exc)
                return written
            for m, vector in zip(batch, vectors):
                m.embedding = vector
                try:
                    self.store.memories.update(m)
                    written += 1
                except Exception:                      # noqa: BLE001
                    log.exception("memory: could not store an embedding for %s", m.id)
        return written

    async def _loop(self) -> None:
        while not self._stopping:
            try:
                await self.drain()
            except asyncio.CancelledError:
                raise
            except Exception:                          # noqa: BLE001
                log.exception("memory: the embed worker's drain raised")
            try:
                await asyncio.sleep(self.idle_s)
            except asyncio.CancelledError:
                raise
