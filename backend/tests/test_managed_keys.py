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


class EnvFilesChecked(unittest.TestCase):
    """env_files_checked() / missing_key_detail() -- the diagnostic whose
    entire job is to say every place config.py actually looked. This had no
    coverage at all before round 2, which is how round 1 added a third .env
    source (the Setup-writable $YURI_HOME/config/.env) without this string
    ever being taught to mention it."""

    def test_a_plain_clone_names_backend_and_yuri_home_but_not_homebrew(self):
        with mock.patch.object(config, "_CONFIG_ENV", None), \
             mock.patch.object(config, "_CONFIG_ENV_DISPLAY", None):
            text = config.env_files_checked()
        self.assertIn("backend/.env", text)
        self.assertIn(config._YURI_HOME_ENV_DISPLAY, text)
        self.assertNotIn("yapcode", text.lower())

    def test_a_homebrew_install_names_all_three_in_load_order(self):
        with mock.patch.object(config, "_CONFIG_ENV", "/fake/homebrew/.env"), \
             mock.patch.object(config, "_CONFIG_ENV_DISPLAY", "~/.config/yapcode/.env"):
            text = config.env_files_checked()
        self.assertIn("~/.config/yapcode/.env", text)
        self.assertIn(config._YURI_HOME_ENV_DISPLAY, text)
        self.assertIn("backend/.env", text)
        # Load (and precedence) order: the out-of-tree config dir first,
        # then the dir PUT /yuri/config writes to, then backend/.env last.
        i_config_dir = text.index("~/.config/yapcode/.env")
        i_yuri_home = text.index(config._YURI_HOME_ENV_DISPLAY)
        i_backend = text.index("backend/.env")
        self.assertLess(i_config_dir, i_yuri_home)
        self.assertLess(i_yuri_home, i_backend)

    def test_missing_key_detail_names_the_var_and_every_location_no_secret(self):
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": SECRET}, clear=False), \
             mock.patch.object(config, "_CONFIG_ENV", "/fake/homebrew/.env"), \
             mock.patch.object(config, "_CONFIG_ENV_DISPLAY", "~/.config/yapcode/.env"):
            locations = config.env_files_checked()
            detail = config.missing_key_detail("GEMINI_API_KEY")
        self.assertIn("GEMINI_API_KEY", detail)
        # Every location env_files_checked() names must show up in the
        # detail text too -- it's built by embedding that string verbatim.
        self.assertIn(locations, detail)
        self.assertNotIn(SECRET, detail)

    def test_the_location_count_matches_the_number_of_env_files_actually_loaded(self):
        # Pins the two counts together: a fourth `_load_env_file(...)` call
        # site added to the loader without teaching this string about a
        # fourth location is exactly the bug this whole class exists to
        # catch -- this is the test that would have caught it.
        import inspect
        import re
        src = inspect.getsource(config)
        head = src[:src.index("VOICE_KEY_VARS")]
        call_sites = len(re.findall(r"_load_env_file\(_[A-Z]", head))
        with mock.patch.object(config, "_CONFIG_ENV", "/fake/homebrew/.env"), \
             mock.patch.object(config, "_CONFIG_ENV_DISPLAY", "~/.config/yapcode/.env"):
            text = config.env_files_checked()
        self.assertEqual(text.count(" and ") + 1, call_sites)
