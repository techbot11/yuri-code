"""Turning text into a vector, behind an interface (spec §7.1).

MEASURED, on 2026-09-04, against the real GEMINI_API_KEY and a 1,000-row
table. Every number below is a run, not an estimate:

    gemini-embedding-001, outputDimensionality=768   works (3072 is default)
    one embedding call                             1,370 ms  <- the only slow thing
    batch of 10                                    2,200 ms
    loading 1,000 vectors from sqlite                  1.37 ms
    cosine over 1,000 x 768, pure Python              31 ms
    cosine over 5,000 x 768                          157 ms

So: **no vector database, no numpy, no new dependency.** sqlite BLOBs and a
dot product. That holds to roughly 10,000 memories, at which point recall
costs 300ms+ and the fix is numpy or sqlite-vec. Named here so the ceiling is
known rather than discovered.

768 rather than the default 3072: four times less storage and four times
faster search, for a store this size.

**Vectors are L2-normalised on the way IN**, which is what makes `cosine` a
bare dot product instead of two magnitudes per comparison.
"""
from __future__ import annotations

import array
import hashlib
import math
import os
import struct
from typing import Protocol

import httpx

EMBED_MODEL = "gemini-embedding-001"
EMBED_DIMS = 768
EMBED_TIMEOUT_S = 20.0
_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models"


class EmbeddingUnavailable(RuntimeError):
    """No key, or the service refused. A NAMED type because the caller's job
    is to degrade — recall falls back to keyword ranking and says so — rather
    than to fail. Same reason `SearchUnavailable` exists in yuri/own/search.py.
    """


def pack(values: list[float]) -> bytes:
    """Normalise and pack. Refuses a wrong-length vector rather than storing
    it: a 3072-dim reply silently stored would score against 768-dim rows and
    produce rankings that look plausible and mean nothing."""
    if len(values) != EMBED_DIMS:
        raise EmbeddingUnavailable(
            f"expected a {EMBED_DIMS}-dimension vector, got {len(values)}")
    norm = math.sqrt(sum(v * v for v in values))
    if norm == 0:
        raise EmbeddingUnavailable("refusing to store a zero vector: it matches everything")
    return struct.pack(f"<{EMBED_DIMS}f", *(v / norm for v in values))


def unpack(blob: bytes) -> array.array:
    if not blob or len(blob) != EMBED_DIMS * 4:
        raise EmbeddingUnavailable(
            f"a stored vector is {len(blob or b'')} bytes, expected {EMBED_DIMS * 4}")
    out = array.array("f")
    out.frombytes(blob)
    return out


def cosine(a: bytes, b: bytes) -> float:
    """A dot product, because both vectors were normalised by `pack`."""
    va, vb = unpack(a), unpack(b)
    return sum(x * y for x, y in zip(va, vb))


class Embedder(Protocol):
    async def embed(self, texts: list[str]) -> list[bytes]: ...


class GeminiEmbedder:
    """The one HTTP call. Batches, because a batch of 10 costs 2.2s and ten
    single calls cost 13.7s."""

    def __init__(self, api_key: str | None = None):
        self._key = (api_key if api_key is not None else os.getenv("GEMINI_API_KEY", "")).strip()

    async def embed(self, texts: list[str]) -> list[bytes]:
        if not self._key:
            # Names Setup, not backend/.env: that file is the lowest-
            # precedence source now, so pointing a user at it can send them
            # to edit something that has no effect.
            #
            # This one DOES need a restart, unlike own/search.py's message:
            # __init__ captures the key once, and the embedder is built a
            # single time when the container is built (yuri/app.py). So a key
            # saved in Setup reaches os.environ immediately and this object
            # still holds "" until the process restarts. Say so, or the user
            # saves the key, sees no change, and concludes Setup is broken.
            raise EmbeddingUnavailable(
                "I can't search my memory by meaning — GEMINI_API_KEY isn't set. "
                "Add it under Setup, then restart me. Everything I remember is "
                "still there and still findable by project or by date.")
        if not texts:
            return []
        one = len(texts) == 1
        path = f"{_ENDPOINT}/{EMBED_MODEL}:" + ("embedContent" if one else "batchEmbedContents")
        if one:
            body = {"model": f"models/{EMBED_MODEL}", "outputDimensionality": EMBED_DIMS,
                    "content": {"parts": [{"text": texts[0]}]}}
        else:
            body = {"requests": [
                {"model": f"models/{EMBED_MODEL}", "outputDimensionality": EMBED_DIMS,
                 "content": {"parts": [{"text": t}]}} for t in texts]}
        try:
            async with httpx.AsyncClient(timeout=EMBED_TIMEOUT_S) as client:
                r = await client.post(path, params={"key": self._key}, json=body)
        except httpx.HTTPError as exc:
            raise EmbeddingUnavailable(f"the embedding service was unreachable: {exc}") from exc
        if r.status_code != 200:
            # The status ONLY. An upstream error body can contain the request,
            # which contains the memory — and the same shape of leak was
            # caught in the search tool by a planted-secret test.
            raise EmbeddingUnavailable(
                f"the embedding service answered {r.status_code}")
        data = r.json()
        raw = ([data.get("embedding", {})] if one else data.get("embeddings", []))
        out: list[bytes] = []
        for item in raw:
            out.append(pack([float(v) for v in (item or {}).get("values") or []]))
        if len(out) != len(texts):
            raise EmbeddingUnavailable(
                f"asked for {len(texts)} vectors and got {len(out)}")
        return out


class FakeEmbedder:
    """A real implementation of the interface, not a mock — the code under
    test runs unchanged. Deterministic from the text, and built so that texts
    sharing words score higher than unrelated ones, which is what lets the
    recall tests assert on RANKING without the network."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    async def embed(self, texts: list[str]) -> list[bytes]:
        self.calls.append(list(texts))
        return [self.vector(t) for t in texts]

    @staticmethod
    def vector(text: str) -> bytes:
        # One dimension per word-hash, so shared words mean shared dimensions.
        values = [0.0] * EMBED_DIMS
        words = [w for w in "".join(
            c if c.isalnum() else " " for c in (text or "").lower()).split() if w]
        for w in words or ["\x00"]:
            slot = int(hashlib.sha256(w.encode()).hexdigest(), 16) % EMBED_DIMS
            values[slot] += 1.0
        return pack(values)
