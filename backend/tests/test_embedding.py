"""The embedding service. Everything here runs against FakeEmbedder or the
pure functions — the real HTTP call is exercised once, live, in Task 13.

FakeEmbedder is a real implementation of the interface rather than a mock, so
the code under test runs unchanged, and it is built so shared words mean
shared dimensions — which is what lets the recall tests assert on RANKING
without the network.
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from yuri.services.embedding import (EMBED_DIMS, EmbeddingUnavailable,  # noqa: E402
                                     FakeEmbedder, GeminiEmbedder, cosine, pack, unpack)


class PackTests(unittest.TestCase):
    def test_pack_and_unpack_round_trip(self):
        blob = pack([1.0] + [0.0] * (EMBED_DIMS - 1))
        self.assertEqual(len(blob), EMBED_DIMS * 4)
        self.assertAlmostEqual(unpack(blob)[0], 1.0, places=6)

    def test_stored_vectors_are_normalised(self):
        # cosine() is a bare dot product and depends on this.
        blob = pack([3.0, 4.0] + [0.0] * (EMBED_DIMS - 2))
        v = unpack(blob)
        self.assertAlmostEqual(v[0], 0.6, places=6)
        self.assertAlmostEqual(v[1], 0.8, places=6)

    def test_a_wrong_length_vector_is_refused(self):
        # A 3072-dim reply silently stored would score against 768-dim rows
        # and produce rankings that look plausible and mean nothing.
        with self.assertRaises(EmbeddingUnavailable) as ctx:
            pack([1.0] * 3072)
        self.assertIn("3072", str(ctx.exception))

    def test_a_zero_vector_is_refused(self):
        with self.assertRaises(EmbeddingUnavailable) as ctx:
            pack([0.0] * EMBED_DIMS)
        self.assertIn("matches everything", str(ctx.exception))

    def test_a_truncated_blob_is_refused_rather_than_scored(self):
        with self.assertRaises(EmbeddingUnavailable):
            unpack(b"\x00\x00")
        with self.assertRaises(EmbeddingUnavailable):
            unpack(None)


class CosineTests(unittest.TestCase):
    def test_a_vector_with_itself_is_one(self):
        a = FakeEmbedder.vector("the cycle detector hangs")
        self.assertAlmostEqual(cosine(a, a), 1.0, places=5)

    def test_orthogonal_vectors_are_zero(self):
        a = pack([1.0] + [0.0] * (EMBED_DIMS - 1))
        b = pack([0.0, 1.0] + [0.0] * (EMBED_DIMS - 2))
        self.assertAlmostEqual(cosine(a, b), 0.0, places=6)


class FakeEmbedderTests(unittest.IsolatedAsyncioTestCase):
    async def test_it_is_deterministic_and_the_right_shape(self):
        f = FakeEmbedder()
        [a] = await f.embed(["hello"])
        [b] = await f.embed(["hello"])
        self.assertEqual(a, b)
        self.assertEqual(len(a), EMBED_DIMS * 4)

    async def test_similar_text_scores_higher_than_unrelated_text(self):
        # The property the recall tests rely on.
        f = FakeEmbedder()
        a, b, c = await f.embed(["the cycle detector hangs",
                                 "the cycle detector is hanging",
                                 "my favourite colour is blue"])
        self.assertGreater(cosine(a, b), cosine(a, c))

    async def test_it_records_its_calls(self):
        # So a test can assert the cheap path did NOT embed.
        f = FakeEmbedder()
        await f.embed(["one", "two"])
        self.assertEqual(f.calls, [["one", "two"]])

    async def test_embedding_nothing_returns_nothing(self):
        self.assertEqual(await FakeEmbedder().embed([]), [])


class GeminiEmbedderTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_missing_key_raises_the_named_type_with_an_actionable_message(self):
        # Mirrors own/search.py: naming the key and where to put it is
        # something the user can act on; "embedding failed" is not. It points
        # at SETUP rather than backend/.env, which is the lowest-precedence
        # source now -- sending someone to edit a file that loses to the one
        # Setup writes is worse than saying nothing.
        with self.assertRaises(EmbeddingUnavailable) as ctx:
            await GeminiEmbedder(api_key="").embed(["anything"])
        msg = str(ctx.exception)
        self.assertIn("GEMINI_API_KEY", msg)
        self.assertIn("Setup", msg)
        self.assertNotIn("backend/.env", msg)
        # It MUST ask for a restart, unlike own/search.py's equivalent:
        # __init__ captures the key once and yuri/app.py builds the embedder a
        # single time, so a key saved in Setup reaches os.environ immediately
        # and this object still holds "" until the process restarts. Without
        # this sentence the user saves the key, sees no change, and concludes
        # Setup is broken.
        self.assertIn("restart", msg.lower())
        # And it says what still works, so she does not report total failure.
        self.assertIn("still findable", msg)

    async def test_an_upstream_error_body_is_never_relayed(self):
        # The same test shape that caught the search tool relaying a 403 body.
        # An embedding request CONTAINS the memory, so an echoed error body is
        # a memory leak.
        import httpx
        secret = "planted-secret-do-not-relay"

        async def handler(request):
            return httpx.Response(403, json={"error": {"message": secret}})

        embedder = GeminiEmbedder(api_key="k")
        transport = httpx.MockTransport(handler)
        real = httpx.AsyncClient

        class Patched(real):
            def __init__(self, *a, **kw):
                kw["transport"] = transport
                super().__init__(*a, **kw)

        httpx.AsyncClient = Patched
        try:
            with self.assertRaises(EmbeddingUnavailable) as ctx:
                await embedder.embed(["a memory about something private"])
        finally:
            httpx.AsyncClient = real
        self.assertNotIn(secret, str(ctx.exception))
        self.assertIn("403", str(ctx.exception))
