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

    async def test_an_explicit_session_id_files_the_session_under_its_OWN_directory_not_the_cwd(self):
        """The bug this guards: the `session_id` branch validated the
        TARGET session's own `location.directory` against
        ALLOWED_PROJECT_ROOTS, then threw that result away and adopted
        into `resolved_cwd` (computed from the caller's own `cwd`) instead.

        Both `foo` and `bar` here are real, independently-allowed
        subdirectories, so both containment checks pass on their own --
        this is not a sandbox escape, it's a mis-filed project. Session
        `sid` actually runs in `bar`; the caller reports `cwd=foo` (as it
        would if it were still sitting in its own shell in a different
        directory than the one it's asking about) and names `sid`
        explicitly. The adopted row -- and the project it's filed under --
        must follow `sid`'s own directory (`bar`), never the caller's
        `cwd` (`foo`).

        Before the fix this passed with the row filed under `foo` /
        working_directory=.../foo -- wrong, but the old version of this
        test never noticed because it always used a `cwd` that already
        matched the target session's own directory.
        """
        other = os.path.join(self.root, "bar")
        os.makedirs(other, exist_ok=True)
        # proj plays the role of "foo" here: allowed, but NOT where `sid` runs.
        sid = self.fake.state.new_session(other, title="from bar")
        out = await self._call(self.proj, session_id=sid)
        self.assertEqual(out["session_id"], sid)

        row = self.c.sessions.row_for(sid)
        self.assertIsNotNone(row)
        self.assertEqual(os.path.realpath(row.working_directory), other)
        project = self.c.projects.get(row.project_id)
        self.assertEqual(os.path.realpath(project.root_path), other)
        self.assertNotEqual(os.path.realpath(row.working_directory), self.proj)

    async def test_a_session_id_target_with_no_directory_is_refused_not_defaulted(self):
        """`session_manager.resolve_project_path("")` treats an empty
        directory as "vague" and silently defaults to the first allowed
        root rather than raising. Since the recovery path validates the
        TARGET session's own `location.directory`, a session with no
        directory metadata would sail through that check by default --
        the check would then assert nothing about the session it's
        supposed to be vetting, and file it under an unrelated project.
        It must be refused instead.
        """
        sid = self.fake.state.new_session("", title="no directory")
        with self.assertRaises(Exception) as cm:
            await self._call(self.proj, session_id=sid)
        self.assertEqual(cm.exception.status_code, 400)
        self.assertIn("no directory", cm.exception.detail)
        # Refused before adoption -- nothing recorded.
        self.assertEqual(self.c.sessions.list(), [])


if __name__ == "__main__":
    unittest.main()
