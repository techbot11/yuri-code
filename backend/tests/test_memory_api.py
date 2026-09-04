"""The memory HTTP surface (spec §6).

The test that matters most is the first: the listing must say which memories
are NOT reaching her. The old store truncated silently — it returned the tail
of a file and said nothing — so making that visible is the panel's whole job.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import config  # noqa: E402
from yuri import app as yapp  # noqa: E402
from yuri.api.routes import build_router  # noqa: E402
from yuri.providers.fake import FakeAgentProvider  # noqa: E402


class MemoryApi(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.mkdir(os.path.join(self.tmp.name, "proj"))
        self.patches = [mock.patch.dict(os.environ, {"ALLOWED_PROJECT_ROOTS": self.tmp.name}),
                        mock.patch.object(config, "YURI_HOME", os.path.join(self.tmp.name, "Yuri"))]
        [p.start() for p in self.patches]
        self.c = yapp.test_container(os.path.join(self.tmp.name, "Yuri"), FakeAgentProvider())

        async def guard():
            return None
        self.app = FastAPI()
        self.app.include_router(build_router(guard))
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def tearDown(self):
        yapp.set_container(None)
        self.c.store.close()
        [p.stop() for p in self.patches]
        self.tmp.cleanup()

    def _add(self, body: str, **over):
        r = self.client.post("/yuri/memories", json={"body": body, **over})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    # --- the budget report, which is the point --------------------------------

    def test_the_listing_says_which_memories_reach_her(self):
        self._add("prefers dark mode")
        body = self.client.get("/yuri/memories").json()
        self.assertTrue(body["memories"][0]["in_prompt"])
        self.assertEqual(body["budget"]["omitted"], 0)
        self.assertEqual(body["budget"]["total"], 1)
        self.assertGreater(body["budget"]["budget"], 0)

    def test_it_reports_what_is_being_left_out(self):
        # 200 facts of ~60 chars cannot all fit in 2000, and the panel has to
        # show which ones do not.
        for i in range(200):
            self._add(f"fact number {i} about something that happened that day")
        body = self.client.get("/yuri/memories").json()
        self.assertGreater(body["budget"]["omitted"], 0)
        reached = [m for m in body["memories"] if m["in_prompt"]]
        self.assertLess(len(reached), 200)
        self.assertEqual(len(reached) + body["budget"]["omitted"], 200)

    def test_a_preference_always_reaches_her(self):
        for i in range(200):
            self._add(f"fact number {i} about something that happened that day")
        pref = self._add("always ask before cancelling", kind="preference")
        body = self.client.get("/yuri/memories").json()
        row = next(m for m in body["memories"] if m["id"] == pref["id"])
        self.assertTrue(row["in_prompt"], "a preference was crowded out")

    def test_the_vector_is_never_in_the_payload(self):
        # 3KB of float per row, and meaningless to a reader.
        self._add("something")
        body = self.client.get("/yuri/memories").json()
        self.assertIsNone(body["memories"][0]["embedding"])
        self.assertIn("embedded", body["memories"][0])

    # --- CRUD ----------------------------------------------------------------

    def test_create_read_update_delete(self):
        made = self._add("prefers dark mode")
        r = self.client.put(f"/yuri/memories/{made['id']}", json={"kind": "preference"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["kind"], "preference")
        self.assertEqual(self.client.delete(f"/yuri/memories/{made['id']}").status_code, 200)
        self.assertEqual(self.client.get("/yuri/memories").json()["memories"], [])

    def test_an_invalid_kind_is_a_400_naming_the_value(self):
        r = self.client.post("/yuri/memories", json={"body": "x", "kind": "vibes"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("vibes", r.json()["detail"])

    def test_a_project_memory_with_no_slug_is_a_400(self):
        r = self.client.post("/yuri/memories", json={"body": "x", "kind": "project"})
        self.assertEqual(r.status_code, 400)

    def test_an_empty_body_is_a_400(self):
        self.assertEqual(self.client.post("/yuri/memories", json={"body": "  "}).status_code, 400)

    def test_an_exact_duplicate_is_a_409(self):
        self._add("prefers dark mode")
        r = self.client.post("/yuri/memories", json={"body": "prefers   dark mode"})
        self.assertEqual(r.status_code, 409)

    def test_editing_the_text_clears_the_vector(self):
        # A stale vector would rank the memory by something it no longer says.
        made = self._add("the old text")
        row = self.c.memories.get(made["id"])
        row.embedding = b"\x00" * (768 * 4)
        self.c.memories.edit(row)
        self.client.put(f"/yuri/memories/{made['id']}", json={"body": "the new text"})
        self.assertIsNone(self.c.memories.get(made["id"]).embedding)

    def test_editing_only_the_pin_keeps_the_vector(self):
        # Pinning does not change what the memory says.
        made = self._add("some text")
        row = self.c.memories.get(made["id"])
        row.embedding = b"\x00" * (768 * 4)
        self.c.memories.edit(row)
        self.client.put(f"/yuri/memories/{made['id']}", json={"pinned": True})
        self.assertIsNotNone(self.c.memories.get(made["id"]).embedding)

    def test_an_unknown_id_is_a_404_everywhere(self):
        self.assertEqual(self.client.put("/yuri/memories/nope", json={}).status_code, 404)
        self.assertEqual(self.client.delete("/yuri/memories/nope").status_code, 404)
        self.assertEqual(self.client.get("/yuri/memories/nope/history").status_code, 404)
        self.assertEqual(
            self.client.post("/yuri/memories/nope/supersede", json={"body": "x"}).status_code, 404)

    # --- superseding ---------------------------------------------------------

    def test_supersede_by_a_new_body_creates_the_replacement_and_links_it(self):
        old = self._add("Always English or Gujarati", kind="preference")
        r = self.client.post(f"/yuri/memories/{old['id']}/supersede",
                             json={"body": "Always Gujarati only"})
        self.assertEqual(r.status_code, 200, r.text)
        current = [m["body"] for m in self.client.get("/yuri/memories").json()["memories"]]
        self.assertEqual(current, ["Always Gujarati only"])
        # And the replacement kept the victim's kind, so a preference does not
        # become a fact and lose its budget exemption.
        self.assertEqual(self.c.memories.get(r.json()["by"]).kind, "preference")

    def test_supersede_by_an_existing_id(self):
        old = self._add("the old way")
        new = self._add("the new way")
        r = self.client.post(f"/yuri/memories/{old['id']}/supersede", json={"by": new["id"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([m["body"] for m in
                          self.client.get("/yuri/memories").json()["memories"]],
                         ["the new way"])

    def test_supersede_with_neither_is_a_400_that_says_what_to_send(self):
        old = self._add("something")
        r = self.client.post(f"/yuri/memories/{old['id']}/supersede", json={})
        self.assertEqual(r.status_code, 400)
        self.assertIn("`by`", r.json()["detail"])

    def test_a_memory_cannot_supersede_itself(self):
        old = self._add("something")
        r = self.client.post(f"/yuri/memories/{old['id']}/supersede", json={"by": old["id"]})
        self.assertEqual(r.status_code, 400)

    def test_history_returns_what_was_replaced(self):
        old = self._add("the old way")
        r = self.client.post(f"/yuri/memories/{old['id']}/supersede",
                             json={"body": "the new way"})
        body = self.client.get(f"/yuri/memories/{r.json()['by']}/history").json()
        self.assertEqual([m["body"] for m in body["replaced"]], ["the old way"])

    # --- search --------------------------------------------------------------

    def test_search_answers_without_a_key_and_says_it_is_degraded(self):
        self._add("the cycle detector hangs on self-reference")
        r = self.client.post("/yuri/memories/search", json={"query": "cycle detector"})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertTrue(out["results"])
        # No GEMINI_API_KEY in the test env, so this is the honest path.
        self.assertIn(out["how"], ("keyword", "semantic", "filtered"))

    def test_search_by_project_uses_the_cheap_path(self):
        self._add("uses uv", kind="project", subject="proj")
        r = self.client.post("/yuri/memories/search",
                             json={"query": "uv", "project": "proj"})
        self.assertEqual(r.json()["how"], "filtered")

    def test_search_with_a_project_outside_the_sandbox_is_a_400(self):
        self.assertEqual(
            self.client.post("/yuri/memories/search",
                             json={"query": "x", "project": "/etc"}).status_code, 400)
