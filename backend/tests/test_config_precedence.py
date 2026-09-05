"""`.env` precedence. The real process environment must win, because the
desktop app injects credentials that way (spec §6.3) and a leftover
development backend/.env would otherwise silently beat them.

Tests the loader directly rather than through `importlib.reload`: `_BACKEND_ENV`
is computed from `__file__` at import, so a patched value does not survive a
reload and such a test would pass whether or not the fix is present.

    cd backend && .venv/bin/python -m unittest tests.test_config_precedence
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import config  # noqa: E402

PROBE = "PRECEDENCE_PROBE"


class _Harness(unittest.TestCase):
    """Setup only, NO tests. Subclassing a class that carries its own tests
    makes unittest re-run every one of them under the subclass's name."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(lambda: os.environ.pop(PROBE, None))
        os.environ.pop(PROBE, None)

    def plant(self, name: str, value: str) -> str:
        """Write a one-key .env and return its path."""
        path = os.path.join(self.tmp.name, name)
        with open(path, "w") as f:
            f.write(f"{PROBE}={value}\n")
        return path

    def load_in_config_order(self, config_env: str | None, backend_env: str | None) -> None:
        """The exact sequence config.py performs, in the same order."""
        if config_env:
            config._load_env_file(config_env, override=False, label="config dir")
        if backend_env:
            config._load_env_file(backend_env, override=False, label="backend/.env")


class Precedence(_Harness):
    def test_the_real_environment_is_not_clobbered_by_either_file(self):
        # The regression this whole task exists for: backend/.env used to load
        # with override=True, which overwrote a value the parent process set.
        os.environ[PROBE] = "from-real-env"
        self.load_in_config_order(self.plant("cfg.env", "from-config-dir"),
                                  self.plant("backend.env", "from-backend-env"))
        self.assertEqual(os.environ[PROBE], "from-real-env")

    def test_the_config_dir_beats_backend_env(self):
        self.load_in_config_order(self.plant("cfg.env", "from-config-dir"),
                                  self.plant("backend.env", "from-backend-env"))
        self.assertEqual(os.environ[PROBE], "from-config-dir")

    def test_backend_env_applies_when_nothing_else_does(self):
        self.load_in_config_order(None, self.plant("backend.env", "from-backend-env"))
        self.assertEqual(os.environ[PROBE], "from-backend-env")

    def test_provenance_is_recorded_for_whichever_file_won(self):
        self.load_in_config_order(self.plant("cfg.env", "from-config-dir"),
                                  self.plant("backend.env", "from-backend-env"))
        self.assertEqual(config.ENV_SOURCES.get(PROBE), "config dir")


class CallSites(_Harness):
    """The loader having the right semantics is not enough — config.py's own
    two calls must use them. This pins the observable outcome at import order,
    which is what a future reordering would break."""

    def test_neither_call_site_overrides(self):
        import inspect
        src = inspect.getsource(config)
        head = src[:src.index("VOICE_KEY_VARS")]
        self.assertNotIn("override=True", head,
                         "a .env file must never override the real environment")
        self.assertEqual(head.count("_load_env_file(_CONFIG_ENV, override=False"), 1)
        self.assertEqual(head.count("_load_env_file(_BACKEND_ENV, override=False"), 1)
        # And the config dir is consulted FIRST, so it wins over backend/.env.
        self.assertLess(head.index("_load_env_file(_CONFIG_ENV"),
                        head.index("_load_env_file(_BACKEND_ENV"))
