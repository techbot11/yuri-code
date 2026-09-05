"""The Setup API. Its binding rule: no endpoint here ever returns a secret
value, in a body, a log or an error.

    cd backend && .venv/bin/python -m unittest tests.test_setup_api
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.dirname(__file__))

import config  # noqa: E402
from yuri import setup_store  # noqa: E402

SECRET = "sk-proj-do-not-leak-me-9f31"


class _Harness(unittest.TestCase):
    """Setup only, NO tests. Subclassing a class that carries its own tests
    makes unittest re-run every one of them under the subclass's name.

    Builds its own app rather than importing `main.app`, matching every other
    API test here (see tests/test_phase7_api.py:29-55). Importing the real app
    would boot the real container against the developer's own YURI_HOME."""

    def setUp(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from yuri import app as yapp
        from yuri.api.routes import build_router
        from yuri.providers.fake import FakeAgentProvider

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        home = os.path.join(self.tmp.name, "Yuri")
        self.patches = [
            mock.patch.dict(os.environ, {"ALLOWED_PROJECT_ROOTS": self.tmp.name}),
            mock.patch.object(config, "YURI_HOME", home),
        ]
        [p.start() for p in self.patches]
        self.addCleanup(lambda: [p.stop() for p in self.patches])
        self.c = yapp.test_container(home, FakeAgentProvider())

        async def guard():
            return None
        app = FastAPI()
        app.include_router(build_router(guard))
        self.client = TestClient(app)
        self.addCleanup(self.client.close)


class DoctorEndpoint(_Harness):
    def test_returns_every_check_with_its_required_flag(self):
        r = self.client.get("/yuri/doctor")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        names = [c["name"] for c in body["checks"]]
        for expected in ("home", "database", "claude", "tmux", "voice keys"):
            self.assertIn(expected, names)
        tmux = next(c for c in body["checks"] if c["name"] == "tmux")
        self.assertFalse(tmux["required"], "tmux must not gate the app")
        self.assertIsInstance(body["ok"], bool)

    def test_ok_reflects_required_checks_only(self):
        r = self.client.get("/yuri/doctor").json()
        expected = all(c["ok"] for c in r["checks"] if c["required"])
        self.assertEqual(r["ok"], expected)


class ConfigRead(_Harness):
    def test_never_returns_a_secret_value(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": SECRET,
                                          "ANTHROPIC_AUTH_TOKEN": SECRET}):
            r = self.client.get("/yuri/config")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(SECRET, r.text)
        self.assertNotIn(SECRET[:14], r.text)

    def test_reports_presence_and_a_hint_for_every_managed_key(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": SECRET}):
            body = self.client.get("/yuri/config").json()
        self.assertEqual([k["name"] for k in body["keys"]],
                         [k.name for k in config.MANAGED_KEYS])
        row = next(k for k in body["keys"] if k["name"] == "GEMINI_API_KEY")
        self.assertTrue(row["set"])
        self.assertEqual(row["hint"], "…9f31")


class ConfigWrite(_Harness):
    def test_an_unknown_key_is_refused(self):
        r = self.client.put("/yuri/config", json={"values": {"HOME": "/tmp/pwned"}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("HOME", r.json()["detail"])

    def test_a_write_lands_and_reports_its_effect_scope(self):
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name):
            r = self.client.put("/yuri/config",
                                json={"values": {"ANTHROPIC_MODEL": "claude-opus-5"}})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["written"], ["ANTHROPIC_MODEL"])
        self.assertEqual(body["effects"], ["next-session"])
        with open(os.path.join(self.tmp.name, ".env")) as f:
            self.assertIn("ANTHROPIC_MODEL=claude-opus-5", f.read())

    def test_the_written_file_is_not_world_readable(self):
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name):
            self.client.put("/yuri/config", json={"values": {"GEMINI_API_KEY": SECRET}})
        mode = os.stat(os.path.join(self.tmp.name, ".env")).st_mode & 0o777
        self.assertEqual(mode, 0o600, f"credentials file is mode {oct(mode)}")

    def test_a_write_reaches_this_process_not_just_the_file(self):
        # Voice keys and allowed roots are read live via os.getenv, so a file
        # write alone leaves the running backend unchanged -- "takes effect
        # straight away" would be a lie, and Setup's save-then-re-check could
        # never see the key it just saved.
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
             mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GEMINI_API_KEY", None)
            self.client.put("/yuri/config", json={"values": {"GEMINI_API_KEY": SECRET}})
            self.assertEqual(os.environ.get("GEMINI_API_KEY"), SECRET)
            # And the doctor must now agree that a voice key exists.
            found = [v for v, _ in config.voice_keys_found()]
            self.assertIn("GEMINI_API_KEY", found)

    def test_clearing_a_key_removes_it_from_this_process_too(self):
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
             mock.patch.dict(os.environ, {"ANTHROPIC_MODEL": "old"}, clear=False):
            self.client.put("/yuri/config", json={"values": {"ANTHROPIC_MODEL": ""}})
            self.assertIsNone(os.environ.get("ANTHROPIC_MODEL"))

    def test_the_response_does_not_echo_what_was_written(self):
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name):
            r = self.client.put("/yuri/config", json={"values": {"GEMINI_API_KEY": SECRET}})
        self.assertNotIn(SECRET, r.text)

    def test_an_empty_value_clears_the_key(self):
        # The only way to unset a wrong key from the UI.
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name):
            self.client.put("/yuri/config", json={"values": {"ANTHROPIC_MODEL": "x"}})
            self.client.put("/yuri/config", json={"values": {"ANTHROPIC_MODEL": ""}})
        with open(os.path.join(self.tmp.name, ".env")) as f:
            self.assertNotIn("ANTHROPIC_MODEL", f.read())

    def test_a_write_leaves_other_keys_alone(self):
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name):
            self.client.put("/yuri/config", json={"values": {"ANTHROPIC_MODEL": "m1"}})
            self.client.put("/yuri/config", json={"values": {"ANTHROPIC_BASE_URL": "u1"}})
        with open(os.path.join(self.tmp.name, ".env")) as f:
            text = f.read()
        self.assertIn("ANTHROPIC_MODEL=m1", text)
        self.assertIn("ANTHROPIC_BASE_URL=u1", text)


class StoreDirectly(unittest.TestCase):
    """Deliberately NOT a _Harness subclass: these touch the store alone and
    need no app, no container and no home."""

    def test_write_creates_the_file_at_0600_even_on_a_fresh_dir(self):
        with tempfile.TemporaryDirectory() as d:
            target = os.path.join(d, "nested")
            path = setup_store.write({"GEMINI_API_KEY": SECRET}, config_dir=target)
            self.assertTrue(os.path.isfile(path))
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_a_value_with_a_newline_cannot_forge_a_second_line(self):
        # A pasted value with a newline would otherwise inject a key.
        with tempfile.TemporaryDirectory() as d:
            setup_store.write({"ANTHROPIC_MODEL": "m\nVC_AUTH_TOKEN=hijacked"},
                              config_dir=d)
            with open(os.path.join(d, ".env")) as f:
                text = f.read()
            self.assertNotIn("VC_AUTH_TOKEN", text)
