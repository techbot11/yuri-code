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
        # ENV_SOURCES is module-level and the loader now READS it (the
        # already-set-but-identical branch only stamps a key no
        # higher-precedence file has claimed), so a leftover entry from a
        # previous test would change the next test's outcome.
        _sources = dict(config.ENV_SOURCES)

        def _restore_sources():
            config.ENV_SOURCES.clear()
            config.ENV_SOURCES.update(_sources)
        self.addCleanup(_restore_sources)
        config.ENV_SOURCES.pop(PROBE, None)

    def plant(self, name: str, value: str) -> str:
        """Write a one-key .env and return its path."""
        path = os.path.join(self.tmp.name, name)
        with open(path, "w") as f:
            f.write(f"{PROBE}={value}\n")
        return path

    def load_in_config_order(self, config_env: str | None, backend_env: str | None,
                             yuri_home_env: str | None = None) -> None:
        """The exact sequence config.py performs, in the same order."""
        if config_env:
            config._load_env_file(config_env, override=False, label="config dir")
        if yuri_home_env:
            config._load_env_file(yuri_home_env, override=False, label="yuri home dir")
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

    def test_the_yuri_home_config_dir_beats_backend_env(self):
        # This is the file PUT /yuri/config (setup_store.write) actually
        # writes in a plain clone -- it must not be shadowed by backend/.env.
        self.load_in_config_order(
            None, self.plant("backend.env", "from-backend-env"),
            yuri_home_env=self.plant("home.env", "from-yuri-home-dir"))
        self.assertEqual(os.environ[PROBE], "from-yuri-home-dir")

    def test_the_out_of_tree_config_dir_beats_the_yuri_home_config_dir(self):
        self.load_in_config_order(
            self.plant("cfg.env", "from-config-dir"),
            self.plant("backend.env", "from-backend-env"),
            yuri_home_env=self.plant("home.env", "from-yuri-home-dir"))
        self.assertEqual(os.environ[PROBE], "from-config-dir")


class ProvenanceOfAnAlreadyExportedValue(_Harness):
    """Whose value is it when the environment and a file agree?

    `yapcode up`'s load_env() exports every line of the config file before it
    spawns the backend (bin/yapcode), so on the ordinary launcher path EVERY
    configured key arrives already set -- to exactly the file's value. The
    loader used to skip such a key entirely, leaving ENV_SOURCES unstamped and
    `_source_of` falling through to "process environment". That made Setup's
    shell-shadow warning (frontend/lib/setup.ts shadowedByShell) fire on every
    single configured key, telling the user to unset a shell export that does
    not exist -- while the saved value would in fact be re-read from that file
    perfectly well."""

    def test_a_value_identical_to_the_file_is_credited_to_the_file(self):
        os.environ[PROBE] = "same-value"
        self.load_in_config_order(None, self.plant("backend.env", "same-value"))
        # The value is untouched -- precedence is unchanged, this is only about
        # who gets the credit.
        self.assertEqual(os.environ[PROBE], "same-value")
        self.assertEqual(config._source_of(PROBE), "backend/.env")

    def test_a_value_that_differs_from_every_file_is_the_process_environment(self):
        # The case the warning was actually written for: something really is
        # exported in the shell, and it really will win again after a restart.
        os.environ[PROBE] = "from-the-shell"
        self.load_in_config_order(self.plant("cfg.env", "from-config-dir"),
                                  self.plant("backend.env", "from-backend-env"))
        self.assertEqual(os.environ[PROBE], "from-the-shell")
        self.assertEqual(config._source_of(PROBE), "process environment")

    def test_the_highest_precedence_matching_file_gets_the_credit(self):
        # Two files hold the same value the environment already has. The one
        # config.py consults FIRST is the one that would supply it on a clean
        # start, so it is the honest answer.
        os.environ[PROBE] = "shared"
        self.load_in_config_order(self.plant("cfg.env", "shared"),
                                  self.plant("backend.env", "shared"),
                                  yuri_home_env=self.plant("home.env", "shared"))
        self.assertEqual(config._source_of(PROBE), "config dir")

    def test_a_lower_precedence_file_cannot_steal_a_key_that_was_loaded(self):
        # The guard must not let the already-set branch overwrite provenance a
        # real load already recorded.
        self.load_in_config_order(self.plant("cfg.env", "from-config-dir"),
                                  self.plant("backend.env", "from-config-dir"))
        self.assertEqual(os.environ[PROBE], "from-config-dir")
        self.assertEqual(config._source_of(PROBE), "config dir")

    def test_an_unset_key_still_reads_as_not_set(self):
        self.assertEqual(config._source_of(PROBE), "not set")


class CallSites(_Harness):
    """The loader having the right semantics is not enough — config.py's own
    three calls must use them. This pins the observable outcome at import
    order, which is what a future reordering would break."""

    def test_neither_call_site_overrides(self):
        import inspect
        src = inspect.getsource(config)
        head = src[:src.index("VOICE_KEY_VARS")]
        self.assertNotIn("override=True", head,
                         "a .env file must never override the real environment")
        self.assertEqual(head.count("_load_env_file(_CONFIG_ENV, override=False"), 1)
        self.assertEqual(head.count("_load_env_file(_YURI_HOME_ENV, override=False"), 1)
        self.assertEqual(head.count("_load_env_file(_BACKEND_ENV, override=False"), 1)
        # And each is consulted in strict precedence order: the out-of-tree
        # (Homebrew) config dir first, then the dir PUT /yuri/config actually
        # writes in a plain clone, then backend/.env last.
        i_config_dir = head.index("_load_env_file(_CONFIG_ENV")
        i_yuri_home = head.index("_load_env_file(_YURI_HOME_ENV")
        i_backend = head.index("_load_env_file(_BACKEND_ENV")
        self.assertLess(i_config_dir, i_yuri_home)
        self.assertLess(i_yuri_home, i_backend)
