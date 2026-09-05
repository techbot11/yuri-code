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
from yuri import doctor, setup_store  # noqa: E402

SECRET = "sk-proj-do-not-leak-me-9f31"


class _Harness(unittest.TestCase):
    """Setup only, NO tests. Subclassing a class that carries its own tests
    makes unittest re-run every one of them under the subclass's name.

    Builds its own app rather than importing `main.app`, matching every other
    API test here (see tests/test_phase7_api.py:29-55). Importing the real app
    would boot the real container against the developer's own YURI_HOME."""

    #: Every route this suite is about. The auth-gate test asserts all three
    #: are in the router's table, so a rename cannot quietly empty the loop.
    SETUP_ROUTES = (("GET", "/yuri/doctor"), ("GET", "/yuri/config"),
                    ("PUT", "/yuri/config"))

    def setUp(self):
        from fastapi import FastAPI, HTTPException
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
        # PUT /yuri/config stamps config.ENV_SOURCES[name] = "Setup". That dict
        # is MODULE-LEVEL state and mock.patch.dict(os.environ) does not touch
        # it, so without this a PUT here leaks a bogus provenance into every
        # later test -- `_source_of` would answer "Setup" for a key the next
        # test set in the real environment, quietly turning a provenance
        # assertion into a false pass.
        _sources = dict(config.ENV_SOURCES)

        def _restore_sources():
            config.ENV_SOURCES.clear()
            config.ENV_SOURCES.update(_sources)
        self.addCleanup(_restore_sources)

        self.c = yapp.test_container(home, FakeAgentProvider())

        self.denied = False

        async def guard():
            if self.denied:
                raise HTTPException(status_code=401, detail="nope")
        self.router = build_router(guard)
        app = FastAPI()
        app.include_router(self.router)
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
        """The distinguishing case, constructed rather than derived.

        This used to compute `expected` from the same response body, so it
        passed whether the endpoint returned `all(required)` or `all(checks)`
        -- it could not fail on the thing it named. `yuri doctor`'s CLI side
        of the same split IS properly pinned (tests/test_doctor.py's
        test_main_reports_every_failure_but_required_gates_the_app); this
        mirrors it: every REQUIRED check passing with a non-required one
        failing must still be ok=True, or a missing tmux gates the whole app.
        """
        rows = [
            doctor.Check("home", True, "/x", True),
            doctor.Check("database", True, "/x.db", True),
            doctor.Check("claude", True, "/usr/bin/claude", True),
            doctor.Check("voice keys", True, "GEMINI_API_KEY", True),
            doctor.Check("tmux", False, "not on PATH", False),
        ]
        with mock.patch.object(doctor, "checks", lambda: rows):
            body = self.client.get("/yuri/doctor").json()
        self.assertTrue(body["ok"],
                        "a failing OPTIONAL check must not gate the app")
        self.assertFalse(next(c for c in body["checks"] if c["name"] == "tmux")["ok"],
                         "and it must still be REPORTED as failing")

    def test_a_failing_required_check_makes_it_not_ok(self):
        # The other half: proves the test above is about `required`, not about
        # the endpoint answering True unconditionally.
        rows = [doctor.Check("claude", False, "not on PATH", True),
                doctor.Check("tmux", True, "/usr/bin/tmux", False)]
        with mock.patch.object(doctor, "checks", lambda: rows):
            self.assertFalse(self.client.get("/yuri/doctor").json()["ok"])

    def test_a_failing_check_carries_the_action_that_fixes_it(self):
        """Spec §6.2: each failing check carries its fix, as data. Parsing it
        back out of `detail` in the UI is what this replaces."""
        with mock.patch.object(doctor.shutil, "which", lambda n: None):
            checks = {c["name"]: c for c in self.client.get("/yuri/doctor").json()["checks"]}
        self.assertEqual(checks["claude"]["fix"],
                         {"kind": "url", "payload": doctor.CLAUDE_INSTALL_URL,
                          "label": "How to install Claude Code"})
        self.assertEqual(checks["tmux"]["fix"]["kind"], "command")
        self.assertEqual(checks["tmux"]["fix"]["payload"], "brew install tmux")

    def test_a_check_without_a_fix_omits_the_field_entirely(self):
        """`fix` is optional: a passing check has none, and neither does a
        failing one with no single action that fixes it (a broken database is
        not a link). Omitted rather than null so nothing has to be taught to
        ignore an empty one."""
        with mock.patch.object(doctor.shutil, "which", lambda n: "/usr/bin/" + n):
            checks = {c["name"]: c for c in self.client.get("/yuri/doctor").json()["checks"]}
        self.assertNotIn("fix", checks["claude"], "a PASSING check offers no fix")
        self.assertNotIn("fix", checks["tmux"])
        self.assertNotIn("fix", checks["database"])

    def test_a_userinfo_bearing_opencode_url_never_reaches_a_detail(self):
        """Ruling 9. OPENCODE_SERVER_PASSWORD is not the only way a password
        reaches doctor -- `https://user:token@host` is an ordinary way to
        write one, and every detail here is returned verbatim over HTTP."""
        with mock.patch.object(config, "OPENCODE_URL",
                               f"http://user:{SECRET}@127.0.0.1:4096"):
            r = self.client.get("/yuri/doctor")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(SECRET, r.text)
        self.assertNotIn("user:", r.text)
        # And the URL is still IDENTIFIED, or the masking made the line useless.
        line = next(c["detail"] for c in r.json()["checks"] if c["name"] == "opencode")
        self.assertIn("127.0.0.1:4096", line)


class ConfigRead(_Harness):
    def test_never_returns_a_secret_value(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": SECRET,
                                          "ANTHROPIC_AUTH_TOKEN": SECRET}):
            r = self.client.get("/yuri/config")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(SECRET, r.text)
        self.assertNotIn(SECRET[:14], r.text)

    def test_no_managed_key_value_ever_reaches_the_client(self):
        """Spec §10 asks for this against EVERY managed key, not the two
        someone happened to write a test for -- an eight-key registry checked
        two at a time is a leak nobody notices until a human reads the JSON.

        Two passes, because "value" means two different things here:

        * a SECRET's value must never appear at all;
        * a NON-secret's value is shown on purpose (a base URL or a model name
          with no hint is a field the user cannot verify) -- but a credential
          written into its userinfo is still a credential, so that must not
          appear for ANY key, secret or not.
        """
        for k in config.MANAGED_KEYS:
            secret = f"{SECRET}-{k.name.lower()}"
            with self.subTest(key=k.name, pass_="plain value"):
                with mock.patch.dict(os.environ, {k.name: secret}):
                    r = self.client.get("/yuri/config")
                self.assertEqual(r.status_code, 200)
                if k.secret:
                    self.assertNotIn(secret, r.text)
                    self.assertNotIn(secret[:14], r.text)
            with self.subTest(key=k.name, pass_="credential in url userinfo"):
                with mock.patch.dict(os.environ,
                                     {k.name: f"https://u:{secret}@gw.example/v1"}):
                    r = self.client.get("/yuri/config")
                self.assertEqual(r.status_code, 200)
                self.assertNotIn(secret, r.text)
                self.assertNotIn("u:", r.text)

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
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
             mock.patch.dict(os.environ, {}, clear=False):
            r = self.client.put("/yuri/config",
                                json={"values": {"ANTHROPIC_MODEL": "claude-opus-5"}})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["written"], ["ANTHROPIC_MODEL"])
        self.assertEqual(body["effects"], ["next-session"])
        with open(os.path.join(self.tmp.name, ".env")) as f:
            self.assertIn("ANTHROPIC_MODEL=claude-opus-5", f.read())

    def test_the_written_file_is_not_world_readable(self):
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
             mock.patch.dict(os.environ, {}, clear=False):
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
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
             mock.patch.dict(os.environ, {}, clear=False):
            r = self.client.put("/yuri/config", json={"values": {"GEMINI_API_KEY": SECRET}})
        self.assertNotIn(SECRET, r.text)

    def test_an_empty_value_clears_the_key(self):
        # The only way to unset a wrong key from the UI.
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
             mock.patch.dict(os.environ, {}, clear=False):
            self.client.put("/yuri/config", json={"values": {"ANTHROPIC_MODEL": "x"}})
            self.client.put("/yuri/config", json={"values": {"ANTHROPIC_MODEL": ""}})
        with open(os.path.join(self.tmp.name, ".env")) as f:
            self.assertNotIn("ANTHROPIC_MODEL", f.read())

    def test_a_write_leaves_other_keys_alone(self):
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
             mock.patch.dict(os.environ, {}, clear=False):
            self.client.put("/yuri/config", json={"values": {"ANTHROPIC_MODEL": "m1"}})
            self.client.put("/yuri/config", json={"values": {"ANTHROPIC_BASE_URL": "u1"}})
        with open(os.path.join(self.tmp.name, ".env")) as f:
            text = f.read()
        self.assertIn("ANTHROPIC_MODEL=m1", text)
        self.assertIn("ANTHROPIC_BASE_URL=u1", text)

    def test_a_newline_in_the_middle_of_a_value_is_refused(self):
        # Letting this through would either forge a second assignment (were
        # clean_value's truncation not there) or bury the attacker's payload
        # inside the legitimate value -- refusing it outright is simpler and
        # doesn't depend on clean_value's exact truncation point.
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
             mock.patch.dict(os.environ, {}, clear=False):
            r = self.client.put(
                "/yuri/config",
                json={"values": {"ANTHROPIC_MODEL": "m\nVC_AUTH_TOKEN=hijacked"}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("ANTHROPIC_MODEL", r.json()["detail"])
        self.assertNotIn("hijacked", r.text)
        self.assertFalse(os.path.isfile(os.path.join(self.tmp.name, ".env")))

    def test_a_value_that_only_becomes_empty_via_a_leading_newline_is_refused(self):
        # clean_value("\n" + SECRET) is "" (everything before the first
        # newline), and empty-clears-the-key would then silently DELETE
        # the key while this endpoint reports success -- the secret the
        # caller meant to save never lands anywhere, and nothing says so.
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
             mock.patch.dict(os.environ, {}, clear=False):
            r = self.client.put("/yuri/config",
                                json={"values": {"GEMINI_API_KEY": "\n" + SECRET}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("GEMINI_API_KEY", r.json()["detail"])
        self.assertNotIn(SECRET, r.text)
        self.assertFalse(os.path.isfile(os.path.join(self.tmp.name, ".env")))

    def test_a_single_trailing_newline_is_the_common_paste_case_and_still_saves(self):
        # The ordinary artifact of pasting a value out of a browser or
        # terminal -- must not be refused the way an embedded newline is.
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
             mock.patch.dict(os.environ, {}, clear=False):
            r = self.client.put("/yuri/config",
                                json={"values": {"GEMINI_API_KEY": SECRET + "\n"}})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(os.environ.get("GEMINI_API_KEY"), SECRET)

    def test_a_lowercase_name_is_refused(self):
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name):
            r = self.client.put("/yuri/config", json={"values": {"anthropic_model": "x"}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("anthropic_model", r.json()["detail"])
        self.assertFalse(os.path.isfile(os.path.join(self.tmp.name, ".env")))

    def test_a_name_with_surrounding_whitespace_is_refused(self):
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name):
            r = self.client.put("/yuri/config", json={"values": {" ANTHROPIC_MODEL ": "x"}})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(os.path.isfile(os.path.join(self.tmp.name, ".env")))

    def test_vc_auth_token_is_refused(self):
        # The name the whole "refuse an unknown key" guard exists to stop.
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name):
            r = self.client.put("/yuri/config", json={"values": {"VC_AUTH_TOKEN": "x"}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("VC_AUTH_TOKEN", r.json()["detail"])
        self.assertFalse(os.path.isfile(os.path.join(self.tmp.name, ".env")))

    def test_a_mixed_known_and_unknown_body_writes_nothing(self):
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name):
            r = self.client.put(
                "/yuri/config",
                json={"values": {"ANTHROPIC_MODEL": "m1", "HOME": "/tmp/pwned"}})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(os.path.isfile(os.path.join(self.tmp.name, ".env")))

    def test_clearing_a_hand_written_export_line_actually_clears_it(self):
        # `_read` used to mis-key `export FOO=old` as the key "export FOO",
        # so a clear of FOO never found it to remove -- the stale line, and
        # the old value, survived the "successful" clear.
        from dotenv import dotenv_values
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
             mock.patch.dict(os.environ, {}, clear=False):
            env_path = os.path.join(self.tmp.name, ".env")
            os.makedirs(self.tmp.name, exist_ok=True)
            with open(env_path, "w") as f:
                f.write("export OPENAI_API_KEY=old-leaked-key\n")
            r = self.client.put("/yuri/config", json={"values": {"OPENAI_API_KEY": ""}})
        self.assertEqual(r.status_code, 200, r.text)
        resolved = dotenv_values(env_path)
        self.assertFalse(resolved.get("OPENAI_API_KEY"))
        with open(env_path) as f:
            self.assertNotIn("old-leaked-key", f.read())


class SetupRouteAccess(_Harness):
    """Who may reach the three Setup routes at all.

    Everything else in this file drives them through a no-op guard, which is
    exactly why these two guarantees needed pinning: with the guard stubbed
    out, "the routes are protected" was a structural claim nothing tested."""

    def test_the_auth_dependency_applies_to_all_three_routes(self):
        # Enumerated from the router's own table rather than a hardcoded list,
        # and cross-checked against SETUP_ROUTES so a rename shows up as a
        # failure instead of an empty loop.
        table = {(m, rt.path) for rt in self.router.routes
                 for m in (rt.methods or set()) - {"HEAD", "OPTIONS"}}
        for method, path in self.SETUP_ROUTES:
            self.assertIn((method, path), table, f"{method} {path} is not routed")
        self.denied = True
        for method, path in self.SETUP_ROUTES:
            with self.subTest(route=f"{method} {path}"):
                r = self.client.request(method, path, json={"values": {}})
                self.assertEqual(r.status_code, 401, r.text)

    def test_no_origin_passes(self):
        """The legitimate case, and the ONLY one a browser produces: every REST
        call goes through the same-origin Next proxy (frontend/lib/api.ts),
        which deliberately does not forward Origin (frontend/lib/proxyAuth.ts)
        and rejects cross-site requests itself. That includes a LAN phone --
        the phone talks to Next, Next talks to the backend server-side."""
        self.assertEqual(self.client.get("/yuri/doctor").status_code, 200)
        self.assertEqual(self.client.get("/yuri/config").status_code, 200)

    def test_an_exactly_allowed_origin_passes(self):
        origin = config.ALLOWED_ORIGINS[0]
        for method, path in self.SETUP_ROUTES:
            with self.subTest(route=f"{method} {path}"), \
                 mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
                 mock.patch.dict(os.environ, {}, clear=False):
                r = self.client.request(method, path, headers={"Origin": origin},
                                        json={"values": {}})
                self.assertEqual(r.status_code, 200, r.text)

    def test_another_localhost_port_is_refused(self):
        """The whole point. `config.origin_allowed` -- what require_auth uses
        -- ADMITS this origin, because its default regex fullmatches loopback
        on any port. That was survivable while no endpoint could write a
        credential; PUT /yuri/config can, and it persists into the .env read
        at every boot. So a page on any other local port could have pointed
        ANTHROPIC_BASE_URL at its own host and collected the user's real
        Anthropic credential from the next agent session."""
        self.assertTrue(config.origin_allowed("http://localhost:9999"),
                        "the broad allowlist must still admit this, or this "
                        "test is not about the narrower rule")
        for method, path in self.SETUP_ROUTES:
            with self.subTest(route=f"{method} {path}"):
                r = self.client.request(method, path,
                                        headers={"Origin": "http://localhost:9999"},
                                        json={"values": {"ANTHROPIC_BASE_URL":
                                                         "https://attacker.example/"}})
                self.assertEqual(r.status_code, 403, r.text)

    def test_a_private_lan_origin_is_refused(self):
        """A LAN phone reaching the backend through the Next proxy sends no
        Origin at all, so refusing LAN origins here costs a real user nothing
        -- while the regex that admits them would otherwise let any page on
        any device on the network write a credential."""
        self.assertTrue(config.origin_allowed("http://192.168.1.50:3000"))
        for method, path in self.SETUP_ROUTES:
            with self.subTest(route=f"{method} {path}"):
                r = self.client.request(method, path,
                                        headers={"Origin": "http://192.168.1.50:3000"},
                                        json={"values": {"ALLOWED_PROJECT_ROOTS": "/"}})
                self.assertEqual(r.status_code, 403, r.text)

    def test_a_refused_origin_writes_nothing_and_changes_nothing(self):
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
             mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ANTHROPIC_BASE_URL", None)
            r = self.client.put("/yuri/config",
                                headers={"Origin": "http://localhost:9999"},
                                json={"values": {"ANTHROPIC_BASE_URL":
                                                 "https://attacker.example/"}})
            self.assertEqual(r.status_code, 403)
            self.assertIsNone(os.environ.get("ANTHROPIC_BASE_URL"))
        self.assertFalse(os.path.isfile(os.path.join(self.tmp.name, ".env")))

    def test_the_refusal_names_no_value(self):
        r = self.client.put("/yuri/config",
                            headers={"Origin": "http://localhost:9999"},
                            json={"values": {"GEMINI_API_KEY": SECRET}})
        self.assertEqual(r.status_code, 403)
        self.assertNotIn(SECRET, r.text)


class ConfigPathField(_Harness):
    def test_both_endpoints_report_the_same_field_meaning_the_same_thing(self):
        """`path` used to be the config DIRECTORY on GET and the .env FILE on
        PUT -- one field, two types, one resource, so a client showing
        "saved to {path}" named different things depending on which call it
        had made last."""
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
             mock.patch.dict(os.environ, {}, clear=False):
            got = self.client.get("/yuri/config").json()["path"]
            put = self.client.put("/yuri/config",
                                  json={"values": {"ANTHROPIC_MODEL": "m"}}).json()["path"]
        self.assertEqual(got, put)
        self.assertTrue(got.endswith("/.env"), got)


class ConfigWriteControlChars(_Harness):
    def test_a_nul_in_a_value_is_refused_rather_than_half_applied(self):
        """clean_value() strips whitespace and truncates at a newline; a NUL
        survives both. It then landed in the FILE and blew up on
        `os.environ[name] = clean` ("ValueError: embedded null byte") -- a 500
        after the write, with the corrupt value loading at the next boot and
        file and process permanently diverged."""
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
             mock.patch.dict(os.environ, {}, clear=False):
            r = self.client.put("/yuri/config",
                                json={"values": {"ANTHROPIC_MODEL": "a\x00b"}})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("ANTHROPIC_MODEL", r.json()["detail"])
        self.assertFalse(os.path.isfile(os.path.join(self.tmp.name, ".env")),
                         "nothing may be written before the refusal")

    def test_the_refusal_names_the_key_and_never_the_value(self):
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name):
            r = self.client.put("/yuri/config",
                                json={"values": {"GEMINI_API_KEY": SECRET + "\x00x"}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("GEMINI_API_KEY", r.json()["detail"])
        self.assertNotIn(SECRET, r.text)

    def test_other_control_characters_are_refused_too(self):
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name):
            for raw in ("a\tb", "a\x1bb", "a\x7fb"):
                with self.subTest(raw=repr(raw)):
                    r = self.client.put("/yuri/config",
                                        json={"values": {"ANTHROPIC_MODEL": raw}})
                    self.assertEqual(r.status_code, 400, r.text)

    def test_an_ordinary_value_still_saves(self):
        # Proves the guard is about control characters and not about anything
        # a real key or model name contains.
        with mock.patch.object(setup_store, "target_dir", lambda: self.tmp.name), \
             mock.patch.dict(os.environ, {}, clear=False):
            r = self.client.put("/yuri/config",
                                json={"values": {"ANTHROPIC_MODEL": "claude-opus-5"}})
        self.assertEqual(r.status_code, 200, r.text)


class StoreDirectly(unittest.TestCase):
    """Deliberately NOT a _Harness subclass: these touch the store alone and
    need no app, no container and no home."""

    def test_write_creates_the_file_at_0600_even_on_a_fresh_dir(self):
        with tempfile.TemporaryDirectory() as d:
            target = os.path.join(d, "nested")
            path = setup_store.write({"GEMINI_API_KEY": SECRET}, config_dir=target)
            self.assertTrue(os.path.isfile(path))
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_target_path_is_the_env_file_inside_target_dir(self):
        with mock.patch.object(setup_store, "target_dir", lambda: "/tmp/whatever"):
            self.assertEqual(setup_store.target_path(), "/tmp/whatever/.env")

    def test_an_already_loose_config_dir_is_tightened(self):
        """`mode=` on os.makedirs applies only to directories it CREATES, so
        an existing 0755 dir kept its permissions -- and while the .env inside
        is 0600, a group- or world-writable directory lets anyone who can
        write it swap the whole file out."""
        with tempfile.TemporaryDirectory() as d:
            target = os.path.join(d, "config")
            os.makedirs(target)
            os.chmod(target, 0o755)
            setup_store.write({"GEMINI_API_KEY": SECRET}, config_dir=target)
            self.assertEqual(os.stat(target).st_mode & 0o777, 0o700)

    def test_a_symlink_planted_at_the_env_path_is_not_followed_on_READ(self):
        """The read is not passive: whatever `_read` parses gets MERGED into
        the file this module rewrites at 0600, which the backend then loads as
        environment at every boot. A symlink at <dir>/.env would have had its
        target's `IDENT=...` lines copied straight into it."""
        with tempfile.TemporaryDirectory() as d:
            planted = os.path.join(d, "planted")
            with open(planted, "w") as f:
                f.write("VC_AUTH_TOKEN=hijacked\nOPENAI_API_KEY=stolen-from-elsewhere\n")
            target = os.path.join(d, "config")
            os.makedirs(target)
            os.symlink(planted, os.path.join(target, ".env"))

            path = setup_store.write({"ANTHROPIC_MODEL": "m"}, config_dir=target)

            with open(path) as f:
                text = f.read()
            self.assertNotIn("hijacked", text)
            self.assertNotIn("stolen-from-elsewhere", text)
            self.assertIn("ANTHROPIC_MODEL=m", text)
            # os.replace renames OVER the symlink rather than through it, so
            # the planted target is untouched too.
            self.assertFalse(os.path.islink(path))
            with open(planted) as f:
                self.assertIn("hijacked", f.read())

    def test_an_ordinary_existing_file_is_still_merged(self):
        # Proves the O_NOFOLLOW read did not turn every read into "no file".
        with tempfile.TemporaryDirectory() as d:
            setup_store.write({"ANTHROPIC_MODEL": "m1"}, config_dir=d)
            setup_store.write({"ANTHROPIC_BASE_URL": "u1"}, config_dir=d)
            with open(os.path.join(d, ".env")) as f:
                text = f.read()
            self.assertIn("ANTHROPIC_MODEL=m1", text)
            self.assertIn("ANTHROPIC_BASE_URL=u1", text)

    def test_a_value_with_a_newline_cannot_forge_a_second_line(self):
        # A pasted value with a newline would otherwise inject a key.
        with tempfile.TemporaryDirectory() as d:
            setup_store.write({"ANTHROPIC_MODEL": "m\nVC_AUTH_TOKEN=hijacked"},
                              config_dir=d)
            with open(os.path.join(d, ".env")) as f:
                text = f.read()
            self.assertNotIn("VC_AUTH_TOKEN", text)
            # And the legitimate part of the value actually survived --
            # this must be a truncation, not the whole write disappearing.
            self.assertIn("ANTHROPIC_MODEL=m", text)

    def test_a_stale_world_readable_tmp_file_is_never_written_through(self):
        # A fixed temp filename would let a leftover file's permissions
        # (os.open's mode argument applies only when CREATING a file) survive
        # into the write: the secret would sit in a 0644 file for the
        # duration of the write, before the final chmod fixed it up.
        with tempfile.TemporaryDirectory() as d:
            stale = os.path.join(d, ".env.tmp")
            with open(stale, "w") as f:
                f.write("leftover junk from a previous run")
            os.chmod(stale, 0o644)

            path = setup_store.write({"GEMINI_API_KEY": SECRET}, config_dir=d)

            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            with open(path) as f:
                self.assertIn(SECRET, f.read())
            # The stale file was never touched -- the secret was never
            # written through a world-readable name.
            self.assertEqual(os.stat(stale).st_mode & 0o777, 0o644)
            with open(stale) as f:
                self.assertNotIn(SECRET, f.read())

    def test_a_tmp_filename_that_is_a_symlink_is_never_followed(self):
        # A fixed temp filename also means a symlink planted at that name
        # (by anything else with write access to the config dir) would have
        # the secret written through it to wherever it points.
        with tempfile.TemporaryDirectory() as d, \
             tempfile.TemporaryDirectory() as outside:
            escape_target = os.path.join(outside, "escaped")
            with open(escape_target, "w"):
                pass
            os.chmod(escape_target, 0o600)
            os.symlink(escape_target, os.path.join(d, ".env.tmp"))

            path = setup_store.write({"GEMINI_API_KEY": SECRET}, config_dir=d)

            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            with open(path) as f:
                self.assertIn(SECRET, f.read())
            # The symlink was never followed -- nothing was written to its
            # target outside the config dir.
            with open(escape_target) as f:
                self.assertNotIn(SECRET, f.read())
