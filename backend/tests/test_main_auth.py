"""Pins the access decision shared by HTTP and WebSocket paths, and the
degraded boot: the voice app must still serve when Yuri's storage cannot start.

    python -m unittest discover -s backend/tests
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from fastapi.testclient import TestClient  # noqa: E402

import config  # noqa: E402
import main  # noqa: E402
from yuri import app as yuri_app  # noqa: E402


class AccessOk(unittest.TestCase):
    def test_no_token_configured_loopback_only(self):
        with mock.patch.object(config, "AUTH_TOKEN", ""):
            self.assertTrue(main._access_ok("127.0.0.1", None)[0])
            self.assertTrue(main._access_ok("::1", None)[0])
            ok, reason = main._access_ok("192.168.1.5", None)
            self.assertFalse(ok)
            self.assertIn("VC_AUTH_TOKEN", reason)

    def test_token_configured_required_everywhere(self):
        with mock.patch.object(config, "AUTH_TOKEN", "secret"):
            self.assertFalse(main._access_ok("127.0.0.1", None)[0])
            self.assertFalse(main._access_ok("127.0.0.1", "wrong")[0])
            self.assertTrue(main._access_ok("10.0.0.2", "secret")[0])


class TokenFrom(unittest.TestCase):
    def test_bearer_header(self):
        self.assertEqual(main._token_from({"authorization": "Bearer abc"}, {}), "abc")

    def test_x_vc_token_header(self):
        self.assertEqual(main._token_from({"x-vc-token": " abc "}, {}), "abc")

    def test_query_param(self):
        self.assertEqual(main._token_from({}, {"token": "q"}), "q")

    def test_missing(self):
        self.assertIsNone(main._token_from({}, {}))


class OriginAllowed(unittest.TestCase):
    def test_localhost_dev(self):
        self.assertTrue(config.origin_allowed("http://localhost:3000"))

    def test_private_lan_any_port(self):
        self.assertTrue(config.origin_allowed("https://192.168.1.20:3000"))

    def test_public_rejected(self):
        self.assertFalse(config.origin_allowed("https://evil.example.com"))

    def test_empty_rejected(self):
        self.assertFalse(config.origin_allowed(None))
        self.assertFalse(config.origin_allowed(""))


class ExactOriginAllowed(unittest.TestCase):
    """The narrower rule the credential-writing Setup routes use. Deliberately
    does NOT consult ALLOWED_ORIGIN_REGEX: that regex admits loopback and
    every private-LAN address on ANY port, which is a convenience for
    legitimate same-network devices rather than a boundary -- and a route that
    persists a value into the .env read at every boot needs a boundary."""

    def test_an_exact_configured_origin_passes(self):
        for origin in config.ALLOWED_ORIGINS:
            self.assertTrue(config.exact_origin_allowed(origin), origin)

    def test_the_lan_regex_is_not_consulted(self):
        for origin in ("http://localhost:9999", "http://192.168.1.50:3000",
                       "http://10.0.0.4:8080", "http://127.0.0.1:5173"):
            # Both halves, so this test fails if either rule drifts into the
            # other: the broad rule must still admit these, and the exact one
            # must not.
            self.assertTrue(config.origin_allowed(origin), origin)
            self.assertFalse(config.exact_origin_allowed(origin), origin)

    def test_empty_and_null_rejected(self):
        # "null" is what a browser sends from an opaque origin (a sandboxed
        # iframe, a data: URL) -- it is a string, not an absence, so it has to
        # be refused rather than mistaken for "no Origin".
        self.assertFalse(config.exact_origin_allowed(None))
        self.assertFalse(config.exact_origin_allowed(""))
        self.assertFalse(config.exact_origin_allowed("null"))


class DegradedBoot(unittest.TestCase):
    """An ~/Yuri that exists as a FILE, or an unwritable home, must not take the
    whole voice app down — only bad config could stop the boot before this
    branch. The Yuri-dependent surfaces then say so, actionably: 503 from
    /yuri/*, a soft {ok: false, error} from a voice tool."""

    def setUp(self):
        yuri_app.set_container(None)
        yuri_app.note_startup_failure(None)

    def tearDown(self):
        yuri_app.set_container(None)
        yuri_app.note_startup_failure(None)

    def test_boots_and_degrades_when_yuri_storage_cannot_start(self):
        async def failing_startup():
            raise NotADirectoryError("[Errno 20] Not a directory: '/Users/x/Yuri/state.db'")

        with mock.patch.object(main.yuri_app, "startup", failing_startup), \
             mock.patch.object(main, "_LOOPBACK_HOSTS", {"testclient"}), \
             mock.patch.object(config, "AUTH_TOKEN", ""), \
             self.assertLogs("yapcode", level="ERROR") as logs:
            with TestClient(main.app) as client:
                self.assertEqual(client.get("/health").json(), {"status": "ok"})
                api = client.get("/yuri/sessions")
                self.assertEqual(api.status_code, 503)
                self.assertIn("Not a directory", api.json()["detail"])
                self.assertIn("YURI_HOME", api.json()["detail"])
                tool = client.post("/tools/execute",
                                   json={"name": "list_sessions", "arguments": {}})
                self.assertEqual(tool.status_code, 200)
                body = tool.json()
                self.assertFalse(body["ok"])
                self.assertIn("Not a directory", body["error"])
                self.assertNotIn("unexpectedly", body["error"])
        self.assertTrue(any("STARTUP FAILED" in m for m in logs.output))


if __name__ == "__main__":
    unittest.main()
