"""The `/session/handoff/opencode` endpoint itself (main.py), against a fake
OpenCode server — no real `opencode serve` needed. `tests/test_opencode_handoff.py`
pins `handoff.pick()` in isolation; this pins that the endpoint actually wires
it up: the reachability/config error paths, and above all the two invariants
that matter most --

  * a stopped/unconfigured OpenCode reports why, as a 400, not a 500;
  * two sessions in one directory adopt NEITHER (409, nothing recorded) --
    the same refusal `provider.py`'s `rehydrate(known=...)` makes for a
    restart, made here for a live handoff.

    backend/.venv/bin/python -m unittest tests.test_opencode_handoff_route -v
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
import main  # noqa: E402
from fake_opencode import FakeOpenCode  # noqa: E402
from yuri import app as yuri_app  # noqa: E402
from yuri.providers.opencode.provider import OpenCodeProvider  # noqa: E402
from yuri.providers.opencode.server import OpenCodeServer  # noqa: E402
from yuri.providers.registry import AgentRegistry  # noqa: E402

UNREACHABLE = "http://127.0.0.1:1"      # nothing listens on port 1


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = os.path.realpath(self.tmp.name)
        self.proj = os.path.join(self.root, "proj")
        os.makedirs(self.proj, exist_ok=True)

        self._env = mock.patch.dict(os.environ, {"ALLOWED_PROJECT_ROOTS": self.root})
        self._env.start()
        self.addCleanup(self._env.stop)
        self._home = mock.patch.object(config, "YURI_HOME", os.path.join(self.root, "Yuri"))
        self._home.start()
        self.addCleanup(self._home.stop)

        self.addCleanup(lambda: yuri_app.set_container(None))

    def _container(self, provider):
        reg = AgentRegistry()
        if provider is not None:
            reg.register(provider)
        home = os.path.join(self.root, "yuri-home")
        c = yuri_app.build_container(yuri_app.Home(home), reg, bridge=None,
                                     default_agent=provider.id if provider else "claude-code")
        yuri_app.set_container(c)
        self.addAsyncCleanup(c.registry.shutdown)
        self.addCleanup(c.store.close)
        return c

    async def _call(self, cwd, session_id=None):
        req = main.OpenCodeHandoffRequest(cwd=cwd, session_id=session_id)
        return await main.handoff_session_opencode(req)


class NotConfigured(Base):
    async def test_opencode_not_in_the_registry_is_a_400_not_a_500(self):
        self._container(None)      # only claude-code would be registered in prod
        with self.assertRaises(Exception) as cm:
            await self._call(self.proj)
        # FastAPI's HTTPException
        self.assertEqual(cm.exception.status_code, 400)
        self.assertIn("YURI_AGENTS", cm.exception.detail)


class NotReachable(Base):
    async def test_a_stopped_opencode_is_a_400_naming_it_not_running(self):
        provider = OpenCodeProvider(OpenCodeServer(UNREACHABLE, spawn=False))
        self._container(provider)
        with self.assertRaises(Exception) as cm:
            await self._call(self.proj)
        self.assertEqual(cm.exception.status_code, 400)
        self.assertIn("not running", cm.exception.detail)


class Resolution(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.fake = FakeOpenCode()
        self.fake.__enter__()
        self.addCleanup(lambda: self.fake.__exit__(None, None, None))
        self.provider = OpenCodeProvider(OpenCodeServer(self.fake.url, spawn=False))
        self.c = self._container(self.provider)

    async def test_no_session_here_is_a_400_naming_the_directory(self):
        with self.assertRaises(Exception) as cm:
            await self._call(self.proj)
        self.assertEqual(cm.exception.status_code, 400)
        self.assertIn("no OpenCode session", cm.exception.detail)

    async def test_one_session_here_is_adopted_and_named_by_title(self):
        sid = self.fake.state.new_session(self.proj, title="api refactor")
        out = await self._call(self.proj)
        self.assertEqual(out["session_id"], sid)
        self.assertEqual(out["title"], "api refactor")
        self.assertIn("api refactor", out["message"])
        # Yuri now lists it, exactly like any other session.
        listed = self.c.sessions.list()
        self.assertEqual([s["session_id"] for s in listed], [sid])
        self.assertEqual(listed[0]["name"], "api refactor")

    async def test_a_cwd_outside_the_allowed_roots_fails_closed(self):
        with self.assertRaises(Exception) as cm:
            await self._call("/etc")
        self.assertEqual(cm.exception.status_code, 400)

    async def test_two_sessions_here_adopts_neither(self):
        a = self.fake.state.new_session(self.proj, title="api")
        b = self.fake.state.new_session(self.proj, title="ui")
        resp = await self._call(self.proj)
        # A JSONResponse, not a raised exception: 409 with both named.
        self.assertEqual(resp.status_code, 409)
        import json
        body = json.loads(resp.body)
        ids = {s["id"] for s in body["sessions"]}
        self.assertEqual(ids, {a, b})
        self.assertIn("api", body["message"])
        self.assertIn("ui", body["message"])
        # Neither was recorded -- the whole point of the invariant.
        self.assertEqual(self.c.sessions.list(), [])

    async def test_the_ambiguous_case_is_recovered_with_an_explicit_session_id(self):
        a = self.fake.state.new_session(self.proj, title="api")
        self.fake.state.new_session(self.proj, title="ui")
        out = await self._call(self.proj, session_id=a)
        self.assertEqual(out["session_id"], a)
        self.assertEqual(out["title"], "api")

    async def test_adopting_the_same_session_twice_reports_already_rather_than_duplicating(self):
        sid = self.fake.state.new_session(self.proj, title="api")
        await self._call(self.proj)
        out = await self._call(self.proj, session_id=sid)
        self.assertEqual(out["session_id"], sid)
        self.assertEqual(len(self.c.sessions.list()), 1)


if __name__ == "__main__":
    unittest.main()
