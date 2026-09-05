"""The managed-key registry the Setup UI renders. The binding rule for this
whole file: a secret value never appears in anything returned here.

    cd backend && .venv/bin/python -m unittest tests.test_managed_keys
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import config  # noqa: E402

SECRET = "sk-ant-super-secret-value-4f2a"


class Masking(unittest.TestCase):
    def test_a_long_secret_shows_only_its_last_four(self):
        self.assertEqual(config.masked_hint(SECRET), "…4f2a")

    def test_a_short_secret_is_masked_entirely(self):
        # Showing "…abcd" of an eight-character secret reveals half of it, so
        # anything at or below the threshold gets no hint at all.
        for short in ("a", "abcd", "abcdefg", "12345678"):
            self.assertEqual(config.masked_hint(short), "set", short)

    def test_an_empty_value_has_no_hint_at_all(self):
        # Nothing is set, so there is nothing to hint at — and "set" would be
        # a claim that something is.
        self.assertEqual(config.masked_hint(""), "")
        self.assertEqual(config.masked_hint("   "), "")

    def test_a_non_secret_is_shown_in_full(self):
        # ANTHROPIC_BASE_URL and ANTHROPIC_MODEL are configuration, not
        # credentials; masking them would make the UI useless.
        self.assertEqual(config.masked_hint("claude-opus-5", secret=False),
                         "claude-opus-5")

    def test_a_non_secret_url_still_hides_its_own_userinfo(self):
        # ANTHROPIC_BASE_URL is not secret, but a URL can carry a credential
        # in its own userinfo -- that part must never reach GET /yuri/config
        # regardless of which field it rode in on.
        self.assertEqual(
            config.masked_hint("https://user:token@gw/x", secret=False),
            "https://***@gw/x")

    def test_a_non_secret_url_without_userinfo_is_untouched(self):
        self.assertEqual(
            config.masked_hint("https://gw.example.com/x", secret=False),
            "https://gw.example.com/x")


class Registry(unittest.TestCase):
    def test_every_key_the_spec_names_is_managed(self):
        names = [k.name for k in config.MANAGED_KEYS]
        for expected in ("GEMINI_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY",
                         "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
                         "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
                         "ALLOWED_PROJECT_ROOTS"):
            self.assertIn(expected, names)

    def test_every_voice_key_var_is_managed(self):
        # The registry must not drift from the list the backend actually reads.
        names = {k.name for k in config.MANAGED_KEYS}
        for v in config.VOICE_KEY_VARS:
            self.assertIn(v, names)

    def test_effects_are_only_the_three_known_scopes(self):
        for k in config.MANAGED_KEYS:
            self.assertIn(k.effect, ("now", "next-session", "restart"), k.name)

    def test_voice_keys_take_effect_now_and_anthropic_next_session(self):
        by = {k.name: k for k in config.MANAGED_KEYS}
        self.assertEqual(by["GEMINI_API_KEY"].effect, "now")
        self.assertEqual(by["ANTHROPIC_MODEL"].effect, "next-session")

    def test_only_credentials_are_marked_secret(self):
        by = {k.name: k for k in config.MANAGED_KEYS}
        self.assertTrue(by["ANTHROPIC_AUTH_TOKEN"].secret)
        self.assertFalse(by["ANTHROPIC_BASE_URL"].secret)
        self.assertFalse(by["ANTHROPIC_MODEL"].secret)


class Status(unittest.TestCase):
    def test_status_reports_presence_and_never_the_value(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": SECRET}):
            rows = config.managed_status()
        row = next(r for r in rows if r["name"] == "GEMINI_API_KEY")
        self.assertTrue(row["set"])
        self.assertEqual(row["hint"], "…4f2a")
        blob = repr(rows)
        self.assertNotIn(SECRET, blob, "a secret value reached managed_status()")
        self.assertNotIn(SECRET[:12], blob)

    def test_an_unset_key_says_so_without_a_hint(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AZURE_OPENAI_API_KEY", None)
            rows = config.managed_status()
        row = next(r for r in rows if r["name"] == "AZURE_OPENAI_API_KEY")
        self.assertFalse(row["set"])
        self.assertEqual(row["hint"], "")
        self.assertEqual(row["source"], "not set")

    def test_status_covers_every_managed_key(self):
        rows = config.managed_status()
        self.assertEqual([r["name"] for r in rows],
                         [k.name for k in config.MANAGED_KEYS])
