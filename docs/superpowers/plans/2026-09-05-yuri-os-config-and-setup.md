# Yuri OS Configuration & Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user configure Yuri — API keys, and the environment checks that must pass before she can work — from the app itself, instead of hand-editing `backend/.env`.

**Architecture:** `yuri/doctor.py` is refactored so its checks are *data* that both the CLI and a new `GET /yuri/doctor` render, rather than lines it prints. `config.py` gains a registry of managed keys with masking and provenance, and its `.env` precedence is corrected so the real process environment wins — the prerequisite for the desktop app later injecting credentials. A new `/setup` route shows the checks and the keys, gates the app when something required is missing, and writes changes through `PUT /yuri/config`.

**Tech Stack:** FastAPI + Python 3.14 (`backend/.venv`, `unittest`); Next 16 / React 19 / TypeScript (`node --test lib/*.test.ts` only — no jsdom, so anything tested must be a pure function in `lib/`).

**Spec:** `docs/superpowers/specs/2026-09-05-yuri-desktop-app-design.md` — §6 is this plan's scope. Read §2.1, §5 and §9 too: they explain *why* the precedence fix and the denied-microphone reporting exist.

## Global Constraints

- **No functionality changes.** Every feature that works today works the same afterwards. Existing suites must stay green: **1561 backend** (`.venv/bin/python -m unittest discover -s tests -q`) and **296 frontend** (`node --test lib/*.test.ts`).
- **A secret value is never returned, logged, or put in an error.** Only presence, a masked hint, and provenance. This binds every task.
- **Frontend tests run under `node --test` with no DOM.** Logic that needs a test goes in `frontend/lib/*.ts` as a pure function; components consume it.
- **Colours come from tokens only** — see `docs/yuri/design/GUIDE.md` §1. No literal hex in new CSS.
- **A control that cannot work is not rendered** (GUIDE.md §6), and empty, loading and failed must never look the same.
- **Do not rename any `YAPCODE_*` or `VC_*` environment variable.** Spec §7.3: they are a config contract. `YAPCODE_CONFIG_DIR` in particular keeps its name in this plan.
- Managed key names, exactly: `GEMINI_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`.
- Effect scopes, exactly these three strings: `"now"`, `"next-session"`, `"restart"`.

## Deliberate deviation from the spec, and why

Spec §6.3 says credentials go renderer → IPC → `safeStorage`, and *"secrets never transit HTTP, not even on loopback."* That path needs Electron, which does not exist until sub-project 2.

This plan therefore writes credentials over `PUT /yuri/config` into `$YAPCODE_CONFIG_DIR/.env` at mode `0600`. That is **not a new exposure**: it is the same file, with the same permissions, that `yapcode config` has the user edit by hand today, over the same loopback API that already carries every other request. What it buys is that sub-project 1 ships something usable on its own.

Sub-project 2 then adds the `safeStorage` path *on top*, and Task 2's precedence fix is what makes it win: values injected into the process environment by Electron's main process will override the file this plan writes. When that lands, the HTTP write path should be removed for the desktop build.

---

## File Structure

**Backend**

| File | Responsibility |
|---|---|
| `backend/yuri/doctor.py` | modify — checks become a list of `Check` records; `main()` prints them |
| `backend/config.py` | modify — `.env` precedence; managed-key registry; masking; provenance |
| `backend/yuri/api/routes.py` | modify — `GET /yuri/doctor`, `GET /yuri/config`, `PUT /yuri/config` |
| `backend/yuri/api/schemas.py` | modify — `ConfigUpdate` request body |
| `backend/yuri/setup_store.py` | create — the only writer of `$YAPCODE_CONFIG_DIR/.env`; mode 0600 |
| `backend/tests/test_doctor.py` | modify — cover `checks()` alongside the existing print assertions |
| `backend/tests/test_config_precedence.py` | create — the three-way precedence |
| `backend/tests/test_setup_api.py` | create — the three endpoints, and the never-leak rule |

**Frontend**

| File | Responsibility |
|---|---|
| `frontend/lib/setup.ts` | create — pure: types, required-check rule, effect-scope labels, form validation |
| `frontend/lib/setup.test.ts` | create — its tests |
| `frontend/components/SetupPanel.tsx` | create — the checks list and the key form |
| `frontend/app/setup/page.tsx` | create — the `/setup` route |
| `frontend/components/shell/Rail.tsx` | modify — a tenth item, "Setup" |
| `frontend/components/SetupGate.tsx` | create — shows setup instead of the app when a required check fails |
| `frontend/app/layout.tsx` | modify — mount the gate |
| `frontend/app/globals.css` | modify — `.setup-*` styles from tokens |

---

## Task 1: The doctor's checks become data

`yuri/doctor.py` currently interleaves *deciding* a check with *printing* it (`_line` prints and returns the bool it was given). One implementation must serve both the CLI and the API, or the two drift and the UI shows something `yuri doctor` does not.

**Files:**
- Modify: `backend/yuri/doctor.py`
- Modify: `backend/tests/test_doctor.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `@dataclass(frozen=True) class Check: name: str; ok: bool; detail: str; required: bool`
  - `def checks() -> list[Check]` — runs every probe, returns records, prints nothing.
  - `def main(argv: list[str]) -> int` — unchanged signature and output format; now renders `checks()`.
  - `REQUIRED_CHECKS: frozenset[str]` = `frozenset({"home", "database", "claude", "voice keys"})`

`required` marks a check that must pass for Yuri to work at all. `tmux` is deliberately **not** required: without it the `cli` backend loses its live terminal pane, but the `sdk` backend still runs (spec §2.1). `opencode` is not required either — it already only gates the exit code when `YURI_AGENTS` asks for it.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_doctor.py`, inside `class Doctor`:

```python
    def test_checks_returns_records_and_prints_nothing(self):
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.object(config, "YURI_HOME", os.path.join(d, "Yuri")):
            buf = io.StringIO()
            with redirect_stdout(buf):
                rows = doctor.checks()
        self.assertEqual(buf.getvalue(), "", "checks() must not print")
        names = [c.name for c in rows]
        for expected in ("home", "database", "claude", "tmux", "voice keys"):
            self.assertIn(expected, names)
        for c in rows:
            self.assertIsInstance(c.ok, bool)
            self.assertIsInstance(c.detail, str)
            self.assertIsInstance(c.required, bool)

    def test_tmux_is_not_required_but_claude_is(self):
        # Without tmux the cli backend loses its live pane; the sdk backend
        # still works. Without claude, nothing does.
        self.assertIn("claude", doctor.REQUIRED_CHECKS)
        self.assertIn("voice keys", doctor.REQUIRED_CHECKS)
        self.assertNotIn("tmux", doctor.REQUIRED_CHECKS)
        self.assertNotIn("opencode", doctor.REQUIRED_CHECKS)

    def test_main_agrees_with_checks_on_the_verdict(self):
        # The CLI and the API must never disagree about whether things are ok.
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.object(config, "YURI_HOME", os.path.join(d, "Yuri")):
            rows = doctor.checks()
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = doctor.main([])
        required_ok = all(c.ok for c in rows if c.required)
        self.assertEqual(rc == 0, required_ok)
        for c in rows:
            self.assertIn(c.name, buf.getvalue())
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd backend && .venv/bin/python -m unittest tests.test_doctor -v 2>&1 | tail -20
```

Expected: `AttributeError: module 'yuri.doctor' has no attribute 'checks'`.

- [ ] **Step 3: Refactor `doctor.py`**

Replace the `_line` helper and `main()` body. Keep every probe (`_opencode_status`, `_opencode_reachable`) and every message string exactly as it is — the detail text is already good and rewriting it would be an unrequested change.

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class Check:
    """One environment check, as data. `required` means Yuri cannot work
    without it — see REQUIRED_CHECKS for why tmux is not one of them."""
    name: str
    ok: bool
    detail: str
    required: bool


# Yuri cannot work at all without these. tmux is absent on purpose: without
# it the cli backend loses its live terminal pane, but the sdk backend still
# runs (spec §2.1). opencode is absent because it already only matters when
# YURI_AGENTS asks for it.
REQUIRED_CHECKS: frozenset[str] = frozenset({"home", "database", "claude", "voice keys"})


def _check(name: str, ok: bool, detail: str) -> Check:
    return Check(name=name, ok=ok, detail=detail, required=name in REQUIRED_CHECKS)


def checks() -> list[Check]:
    """Run every probe and return the results. Prints nothing — `main` does
    the printing, and the API renders the same records, so the CLI and the UI
    cannot disagree."""
    out: list[Check] = []
    home = Home(config.YURI_HOME)
    try:
        home.ensure()
        out.append(_check("home", True, home.path))
    except Exception as exc:
        out.append(_check("home", False, f"{home.path}: {exc}"))
    try:
        store = SqliteStore(home.db_path)
        try:
            store.migrate()
            v = store.settings.get("schema_version")
        finally:
            store.close()
        out.append(_check("database", v == SCHEMA_VERSION,
                          f"{home.db_path} (schema v{v})"))
    except Exception as exc:
        out.append(_check("database", False, str(exc)))

    raw_roots = (os.getenv("ALLOWED_PROJECT_ROOTS") or "").strip()
    roots = config.allowed_project_roots()
    home_real = os.path.realpath(home.path)
    project_roots = [r for r in roots if r != home_real]
    if project_roots:
        out.append(_check("allowed roots", True, ", ".join(roots)))
    elif raw_roots:
        out.append(_check("allowed roots", False,
                          f"ALLOWED_PROJECT_ROOTS={raw_roots!r} resolves to nothing outside "
                          f"Yuri's own home ({home_real}); only her home is reachable — fix "
                          f"ALLOWED_PROJECT_ROOTS in Setup"))
    else:
        out.append(_check("allowed roots", False,
                          f"ALLOWED_PROJECT_ROOTS is not set — only Yuri's own home "
                          f"({home_real}) is reachable; set it in Setup so she can work in "
                          f"your projects (sessions elsewhere will refuse to start)"))

    claude = shutil.which("claude")
    out.append(_check("claude", claude is not None,
                      claude or "not on PATH — install Claude Code"))
    tmux = shutil.which("tmux")
    out.append(_check("tmux", tmux is not None,
                      tmux or "not on PATH — brew install tmux. Without it the live "
                              "terminal pane is unavailable; agents still run."))
    keys = config.voice_keys_found()
    out.append(_check("voice keys", bool(keys),
                      ", ".join(f"{k} ({src})" for k, src in keys)
                      or "none found — add one in Setup"))
    out.append(_check("agents", True, config.YURI_AGENTS))

    agents = [a.strip() for a in (config.YURI_AGENTS or "").split(",") if a.strip()]
    status, detail = _opencode_status()
    if "opencode" in agents:
        out.append(_check("opencode", status != "unavailable", detail))
    else:
        # ✓ is doctor's verdict ("nothing here needs fixing"), not a claim that
        # OpenCode is up — the detail says which it is.
        out.append(_check("opencode", True,
                          f"{detail} · not in YURI_AGENTS, so nothing needs it"))
    return out


def main(argv: list[str]) -> int:
    print("yuri doctor")
    rows = checks()
    for c in rows:
        print(f"  {'✓' if c.ok else '✗'} {c.name:<14} {c.detail}")
    ok = all(c.ok for c in rows if c.required)
    print("ok" if ok else "problems found")
    return 0 if ok else 1
```

Delete the now-unused `_line`. Note the exit-code change: it was `ok &= <every check>`; it is now `all(required checks)`. That is deliberate and is what `REQUIRED_CHECKS` encodes — a missing `tmux` no longer fails `yuri doctor`, because it no longer stops Yuri working.

- [ ] **Step 4: Run the doctor tests**

```bash
cd backend && .venv/bin/python -m unittest tests.test_doctor -v 2>&1 | tail -20
```

Expected: PASS. If a pre-existing test asserted a non-zero exit for missing `tmux`, update it and say so in the commit — the behaviour change is intended.

- [ ] **Step 5: Run the whole backend suite**

```bash
cd backend && .venv/bin/python -m unittest discover -s tests -q 2>&1 | tail -3
```

Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add backend/yuri/doctor.py backend/tests/test_doctor.py
git commit -m "refactor(doctor): checks are data, so the CLI and UI cannot disagree"
```

---

## Task 2: Real environment wins over `.env`

`config.py:63` loads `backend/.env` with `override=True`, which **overwrites** real environment variables. In the desktop app, credentials injected by Electron's main process would be silently beaten by a leftover development `.env`. This is the same failure shape as two bugs already fixed in this repo (a `--model` flag pinned over the user's config; `.zshrc` invisible to non-interactive shells): a narrower source silently overriding the user's actual intent.

**Files:**
- Modify: `backend/config.py:61-64`
- Create: `backend/tests/test_config_precedence.py`

**Interfaces:**
- Consumes: nothing.
- Produces: precedence `real environment > $YAPCODE_CONFIG_DIR/.env > backend/.env`. `ENV_SOURCES` still records provenance per key.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_config_precedence.py`:

```python
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
```

- [ ] **Step 2: Run it to confirm the first case fails**

```bash
cd backend && .venv/bin/python -m unittest tests.test_config_precedence -v 2>&1 | tail -15
```

Expected: `CallSites.test_neither_call_site_overrides` FAILS on `override=True`, and
`test_the_config_dir_beats_backend_env` FAILS because the config dir is currently
consulted second. The `Precedence` tests that exercise `_load_env_file` with
`override=False` directly already pass — they document the semantics the call sites
must use.

- [ ] **Step 3: Fix the precedence**

In `backend/config.py`, replace the two loader calls and their comment:

```python
    # Precedence: the real process environment wins, then the out-of-tree
    # config dir, then backend/.env. The real environment is FIRST because
    # the desktop app injects credentials that way (spec §6.3) -- backend/.env
    # used to load with override=True, which silently beat them, the same
    # failure shape as a --model flag pinned over the user's own config.
    _load_env_file(_CONFIG_ENV, override=False, label=_CONFIG_ENV_DISPLAY or "")
    _load_env_file(_BACKEND_ENV, override=False, label="backend/.env")
```

`override=False` already means "don't shadow an already-set value", so loading the config dir first makes it beat `backend/.env`, and anything real in the environment beats both.

- [ ] **Step 4: Run the tests**

```bash
cd backend && .venv/bin/python -m unittest tests.test_config_precedence -v 2>&1 | tail -8
cd backend && .venv/bin/python -m unittest discover -s tests -q 2>&1 | tail -3
```

Expected: both `OK`. If another test relied on `backend/.env` overriding the environment, that test was pinning the bug — update it and note it in the commit.

- [ ] **Step 5: Commit**

```bash
git add backend/config.py backend/tests/test_config_precedence.py
git commit -m "fix(config): the real environment wins over .env, not the other way round"
```

---

## Task 3: Managed keys — registry, masking, provenance

The UI needs to show *which* settings it manages, whether each is set, a hint that identifies it without revealing it, where its value came from, and what changing it takes effect on.

**Files:**
- Modify: `backend/config.py` (append after `summary()`, around line 113)
- Create: `backend/tests/test_managed_keys.py`

**Interfaces:**
- Consumes: `config._source_of(var)`, `config.VOICE_KEY_VARS` (both already exist).
- Produces:
  - `MANAGED_KEYS: tuple[ManagedKey, ...]`
  - `@dataclass(frozen=True) class ManagedKey: name: str; label: str; secret: bool; effect: str; blurb: str`
  - `def masked_hint(value: str) -> str`
  - `def managed_status() -> list[dict]` — one dict per key: `{name, label, secret, effect, blurb, set: bool, hint: str, source: str}`. **Never a value.**

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_managed_keys.py`:

```python
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


class Registry(unittest.TestCase):
    def test_every_key_the_spec_names_is_managed(self):
        names = [k.name for k in config.MANAGED_KEYS]
        for expected in ("GEMINI_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY",
                         "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
                         "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"):
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
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd backend && .venv/bin/python -m unittest tests.test_managed_keys -v 2>&1 | tail -12
```

Expected: `AttributeError: module 'config' has no attribute 'masked_hint'`.

- [ ] **Step 3: Implement the registry**

Append to `backend/config.py`, after `summary()`:

```python
# --- managed configuration, for the Setup UI ------------------------------
# The settings a user can change from inside the app. Everything here is
# rendered by GET /yuri/config and written by PUT /yuri/config.
#
# `effect` says what a change takes effect on, because it is NOT uniform and
# a UI that implied otherwise would be lying:
#   "now"          read live via os.getenv at use time
#   "next-session" passed to a child process when it is spawned
#   "restart"      frozen into a module constant at import (see YURI_HOME etc.)
from dataclasses import dataclass


@dataclass(frozen=True)
class ManagedKey:
    name: str
    label: str
    secret: bool
    effect: str
    blurb: str


MANAGED_KEYS: tuple[ManagedKey, ...] = (
    ManagedKey("GEMINI_API_KEY", "Gemini API key", True, "now",
               "Lets her talk over Gemini Live. One voice key is required."),
    ManagedKey("OPENAI_API_KEY", "OpenAI API key", True, "now",
               "Lets her talk over OpenAI Realtime instead."),
    ManagedKey("AZURE_OPENAI_API_KEY", "Azure OpenAI key", True, "now",
               "For OpenAI Realtime through Azure."),
    ManagedKey("ANTHROPIC_API_KEY", "Anthropic API key", True, "next-session",
               "Used by the coding agents when they are not signed in to "
               "Claude Code."),
    ManagedKey("ANTHROPIC_AUTH_TOKEN", "Anthropic auth token", True, "next-session",
               "For a gateway that authenticates with a token rather than an "
               "API key."),
    ManagedKey("ANTHROPIC_BASE_URL", "Anthropic base URL", False, "next-session",
               "Point the agents at a gateway or proxy instead of the default "
               "endpoint."),
    ManagedKey("ANTHROPIC_MODEL", "Default agent model", False, "next-session",
               "Which model an agent session uses when nothing asks for a "
               "specific one."),
)


def masked_hint(value: str, *, secret: bool = True) -> str:
    """A hint that identifies a value without revealing it.

    Only the last four characters, and only when there is enough left over to
    keep hidden -- "…abcd" of a six-character secret reveals most of it. Short
    secrets get no hint at all. Non-secrets (a URL, a model name) are
    configuration rather than credentials, so masking them would make the UI
    useless."""
    value = (value or "").strip()
    if not value:
        return ""
    if not secret:
        return value
    return f"…{value[-4:]}" if len(value) > 8 else "set"


def managed_status() -> list[dict]:
    """Every managed key: whether it is set, a hint, where it came from, and
    what changing it takes effect on.

    NEVER returns a value. This function is the boundary the Setup UI reads
    through, so a leak here is a leak everywhere."""
    out = []
    for k in MANAGED_KEYS:
        raw = (os.getenv(k.name) or "").strip()
        out.append({
            "name": k.name, "label": k.label, "secret": k.secret,
            "effect": k.effect, "blurb": k.blurb,
            "set": bool(raw),
            "hint": masked_hint(raw, secret=k.secret) if raw else "",
            "source": _source_of(k.name),
        })
    return out
```

Also fix `missing_key_detail`, whose advice is now wrong — it points at a wizard that Setup replaces, and names `yapcode`:

```python
def missing_key_detail(var: str) -> str:
    """Actionable error body for a missing provider key/setting — says where we
    looked and how to fix it, instead of a bare 'not set'."""
    return (f"{var} is not set on the server. Looked in {env_files_checked()}. "
            f"Add it in Yuri OS under Setup.")
```

- [ ] **Step 4: Run the tests**

```bash
cd backend && .venv/bin/python -m unittest tests.test_managed_keys -v 2>&1 | tail -8
cd backend && .venv/bin/python -m unittest discover -s tests -q 2>&1 | tail -3
```

Expected: both `OK`. A test asserting the old `missing_key_detail` wording will fail; update its expected string.

- [ ] **Step 5: Commit**

```bash
git add backend/config.py backend/tests/test_managed_keys.py
git commit -m "feat(config): a managed-key registry with masking and provenance"
```

---

## Task 4: The three endpoints, and the writer

`GET /yuri/doctor` and `GET /yuri/config` render Task 1 and Task 3. `PUT /yuri/config` writes — and it is the only writer, so it owns the file mode.

**Files:**
- Create: `backend/yuri/setup_store.py`
- Modify: `backend/yuri/api/schemas.py`
- Modify: `backend/yuri/api/routes.py`
- Create: `backend/tests/test_setup_api.py`

**Interfaces:**
- Consumes: `doctor.checks() -> list[Check]`, `doctor.REQUIRED_CHECKS`, `config.managed_status()`, `config.MANAGED_KEYS`, `config.masked_hint`.
- Produces:
  - `setup_store.write(values: dict[str, str], *, config_dir: str) -> str` — merges into `<config_dir>/.env` at mode `0o600`, returns the path.
  - `setup_store.target_dir() -> str` — `$YAPCODE_CONFIG_DIR`, else `~/Yuri/config`, created if absent.
  - `GET /yuri/doctor` → `{"checks": [{name, ok, detail, required}], "ok": bool}` where `ok` is "every required check passes".
  - `GET /yuri/config` → `{"keys": [...managed_status()...], "path": "<display path>"}`
  - `PUT /yuri/config` body `{"values": {NAME: value}}` → `{"written": [names], "effects": ["now"|"next-session"|"restart"], "path": str}`; 400 on an unknown key name.

An empty-string value **clears** a key (removes the line). That is the only way to unset one from the UI, and a UI that could set but not clear a wrong key would trap the user.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_setup_api.py`:

```python
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
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd backend && .venv/bin/python -m unittest tests.test_setup_api -v 2>&1 | tail -12
```

Expected: `ModuleNotFoundError: No module named 'yuri.setup_store'`.

- [ ] **Step 3: Write the store**

Create `backend/yuri/setup_store.py`:

```python
"""The ONE writer of the config-dir `.env`.

Kept out of `config.py` on purpose: config.py READS the environment and is
imported by everything, and a module that everything imports should not also
be able to write credentials to disk.

Sub-project 2 supersedes this with Electron `safeStorage`, which never puts
plaintext on disk at all. Until then this is the same file, at the same
permissions, that `yapcode config` had the user edit by hand -- see the
plan's "Deliberate deviation from the spec".
"""
from __future__ import annotations

import os

_MODE = 0o600


def target_dir() -> str:
    """Where the writable `.env` lives. $YAPCODE_CONFIG_DIR when set (the
    Homebrew and desktop layouts both set it), else a config dir beside her
    data. Created if absent, owner-only."""
    raw = (os.getenv("YAPCODE_CONFIG_DIR") or "").strip()
    if raw:
        return os.path.expanduser(raw)
    home = os.path.expanduser(os.getenv("YURI_HOME") or "~/Yuri")
    return os.path.join(home, "config")


def _read(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    if not os.path.isfile(path):
        return out
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            out[k.strip()] = v
    return out


def write(values: dict[str, str], *, config_dir: str | None = None) -> str:
    """Merge `values` into <config_dir>/.env and return its path.

    An empty value REMOVES the key -- the only way to unset a wrong one from
    the UI. Values are written on one line each with newlines stripped: a
    pasted value containing a newline would otherwise forge a second
    assignment and could set any variable at all.

    The file is created at mode 0600 and re-chmodded on every write, so a
    file that predates this code (or was created by a hand edit) is corrected
    rather than trusted.
    """
    d = config_dir or target_dir()
    os.makedirs(d, mode=0o700, exist_ok=True)
    path = os.path.join(d, ".env")
    merged = _read(path)
    for k, v in values.items():
        v = (v or "").replace("\n", "").replace("\r", "").strip()
        if v:
            merged[k] = v
        else:
            merged.pop(k, None)

    tmp = path + ".tmp"
    # Create with 0600 from the start: writing then chmodding leaves a window
    # where the file is world-readable.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, _MODE)
    with os.fdopen(fd, "w") as f:
        f.write("# Written by Yuri OS Setup. Values are one per line.\n")
        for k in sorted(merged):
            f.write(f"{k}={merged[k]}\n")
    os.replace(tmp, path)
    os.chmod(path, _MODE)
    return path
```

- [ ] **Step 4: Add the request schema**

Append to `backend/yuri/api/schemas.py`:

```python
class ConfigUpdate(BaseModel):
    """Managed settings to write. An empty value clears the key."""
    values: dict[str, str]
```

- [ ] **Step 5: Add the endpoints**

In `backend/yuri/api/routes.py`, alongside the other `@r.get` handlers. Add `from yuri import doctor, setup_store` and `ConfigUpdate` to the existing schema import.

```python
    @r.get("/doctor")
    async def read_doctor():
        """The same checks `yuri doctor` prints, as data — one implementation,
        so the CLI and the Setup screen cannot disagree. `ok` counts only the
        REQUIRED checks: a missing tmux costs the live terminal pane, not the
        app."""
        rows = await asyncio.to_thread(doctor.checks)
        return {"checks": [{"name": c.name, "ok": c.ok, "detail": c.detail,
                            "required": c.required} for c in rows],
                "ok": all(c.ok for c in rows if c.required)}

    @r.get("/config")
    async def read_config():
        """Managed settings: presence, a masked hint, provenance, and what a
        change takes effect on. NEVER a value."""
        return {"keys": config.managed_status(),
                "path": setup_store.target_dir().replace(
                    os.path.expanduser("~"), "~", 1)}

    @r.put("/config")
    async def write_config(body: ConfigUpdate):
        """Write managed settings. Refuses any name not in MANAGED_KEYS: this
        endpoint writes a file the backend reads at startup, so an arbitrary
        name would let a caller set VC_AUTH_TOKEN or ALLOWED_PROJECT_ROOTS."""
        known = {k.name: k for k in config.MANAGED_KEYS}
        unknown = sorted(set(body.values) - set(known))
        if unknown:
            raise HTTPException(
                status_code=400,
                detail=f"not settings Yuri manages: {', '.join(unknown)}")
        path = await asyncio.to_thread(setup_store.write, dict(body.values))
        written = sorted(body.values)
        # De-duplicated, in the fixed order the UI explains them in.
        order = ("now", "next-session", "restart")
        effects = [e for e in order if any(known[n].effect == e for n in written)]
        return {"written": written, "effects": effects,
                "path": path.replace(os.path.expanduser("~"), "~", 1)}
```

`doctor.checks()` touches the filesystem and probes OpenCode over the network, so it goes through `asyncio.to_thread` rather than blocking the event loop.

Imports, checked against `routes.py` as it stands: `asyncio` (line 13) and `HTTPException` (line 19) are already there. **`os` is NOT** — add `import os` to the stdlib group, since both handlers use `os.path.expanduser`. Then extend the two existing import lines:

```python
from yuri import doctor, setup_store
```

and add `ConfigUpdate` to the `from .schemas import (...)` list, keeping it alphabetical.

- [ ] **Step 6: Run the tests**

```bash
cd backend && .venv/bin/python -m unittest tests.test_setup_api -v 2>&1 | tail -14
cd backend && .venv/bin/python -m unittest discover -s tests -q 2>&1 | tail -3
```

Expected: both `OK`. There is an existing architectural test that asserts which modules may import what — if it objects to `routes.py` importing `setup_store`, read its rationale before changing anything.

- [ ] **Step 7: Commit**

```bash
git add backend/yuri/setup_store.py backend/yuri/api/schemas.py \
        backend/yuri/api/routes.py backend/tests/test_setup_api.py
git commit -m "feat(api): doctor and managed config over HTTP, with one writer at 0600"
```

---

## Task 5: The frontend's pure logic

Frontend tests are `node --test lib/*.test.ts` with no DOM, so every rule the Setup screen follows lives here as a pure function.

**Files:**
- Create: `frontend/lib/setup.ts`
- Create: `frontend/lib/setup.test.ts`

**Interfaces:**
- Consumes: the JSON shapes Task 4 produces.
- Produces:
  - `type DoctorCheck = { name: string; ok: boolean; detail: string; required: boolean }`
  - `type ManagedKey = { name: string; label: string; secret: boolean; effect: Effect; blurb: string; set: boolean; hint: string; source: string }`
  - `type Effect = "now" | "next-session" | "restart"`
  - `function blocking(checks: DoctorCheck[]): DoctorCheck[]`
  - `function gateOpen(checks: DoctorCheck[] | null): boolean`
  - `function effectLabel(e: Effect): string`
  - `function effectsSentence(effects: Effect[]): string`
  - `function pendingChanges(keys: ManagedKey[], draft: Record<string, string>): string[]`
  - `function canSave(keys: ManagedKey[], draft: Record<string, string>): boolean`

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/setup.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import {
  blocking, canSave, effectLabel, effectsSentence, gateOpen, pendingChanges,
  type DoctorCheck, type ManagedKey,
} from "./setup.ts";

const check = (over: Partial<DoctorCheck> = {}): DoctorCheck => ({
  name: "claude", ok: true, detail: "/opt/homebrew/bin/claude", required: true, ...over,
});

const key = (over: Partial<ManagedKey> = {}): ManagedKey => ({
  name: "GEMINI_API_KEY", label: "Gemini API key", secret: true, effect: "now",
  blurb: "Lets her talk over Gemini Live.", set: false, hint: "", source: "not set",
  ...over,
});

test("only a FAILING REQUIRED check blocks", () => {
  // tmux failing costs the live terminal pane, not the app — so it must not
  // hold the whole UI hostage.
  const rows = [
    check({ name: "claude", ok: true }),
    check({ name: "tmux", ok: false, required: false }),
    check({ name: "voice keys", ok: false, required: true }),
  ];
  assert.deepEqual(blocking(rows).map((c) => c.name), ["voice keys"]);
});

test("the gate is open when every required check passes", () => {
  assert.equal(gateOpen([check({ ok: true }), check({ name: "tmux", ok: false, required: false })]), true);
  assert.equal(gateOpen([check({ ok: false })]), false);
});

test("the gate stays SHUT while the checks are unknown", () => {
  // null is "not loaded yet". Treating it as open would flash the whole app
  // and then yank it away; treating it as shut shows the boot state, which is
  // what is actually true.
  assert.equal(gateOpen(null), false);
});

test("an empty check list does not silently open the gate", () => {
  // No checks means the endpoint told us nothing, not that all is well.
  assert.equal(gateOpen([]), false);
});

test("each effect scope has plain words", () => {
  assert.match(effectLabel("now"), /now|straight away|immediately/i);
  assert.match(effectLabel("next-session"), /next/i);
  assert.match(effectLabel("restart"), /restart/i);
});

test("the effects sentence names the strongest requirement", () => {
  assert.match(effectsSentence(["now"]), /now|straight away|immediately/i);
  assert.match(effectsSentence(["now", "restart"]), /restart/i,
    "a change needing a restart must not be reported as taking effect now");
  assert.equal(effectsSentence([]), "");
});

test("a pending change is one that differs from what is saved", () => {
  const keys = [key({ name: "ANTHROPIC_MODEL", secret: false, set: true, hint: "claude-opus-5" }),
                key({ name: "GEMINI_API_KEY", set: true, hint: "…4f2a" })];
  // Same value as the visible hint on a NON-secret is not a change.
  assert.deepEqual(pendingChanges(keys, { ANTHROPIC_MODEL: "claude-opus-5" }), []);
  assert.deepEqual(pendingChanges(keys, { ANTHROPIC_MODEL: "claude-sonnet-5" }),
                   ["ANTHROPIC_MODEL"]);
});

test("typing into a SECRET field is always a change", () => {
  // Its current value is unknown to the client by design, so it can never be
  // compared — anything typed has to be treated as new.
  const keys = [key({ name: "GEMINI_API_KEY", set: true, hint: "…4f2a" })];
  assert.deepEqual(pendingChanges(keys, { GEMINI_API_KEY: "anything" }),
                   ["GEMINI_API_KEY"]);
});

test("clearing a set key is a change; clearing an unset one is not", () => {
  const set = [key({ name: "ANTHROPIC_MODEL", secret: false, set: true, hint: "m1" })];
  assert.deepEqual(pendingChanges(set, { ANTHROPIC_MODEL: "" }), ["ANTHROPIC_MODEL"]);
  const unset = [key({ name: "ANTHROPIC_MODEL", secret: false, set: false, hint: "" })];
  assert.deepEqual(pendingChanges(unset, { ANTHROPIC_MODEL: "" }), []);
});

test("an untouched field is never a change", () => {
  const keys = [key({ name: "GEMINI_API_KEY", set: true, hint: "…4f2a" })];
  assert.deepEqual(pendingChanges(keys, {}), []);
});

test("save needs at least one pending change", () => {
  const keys = [key({ name: "ANTHROPIC_MODEL", secret: false, set: false })];
  assert.equal(canSave(keys, {}), false);
  assert.equal(canSave(keys, { ANTHROPIC_MODEL: "  " }), false, "whitespace is not a value");
  assert.equal(canSave(keys, { ANTHROPIC_MODEL: "claude-opus-5" }), true);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd frontend && node --test lib/setup.test.ts 2>&1 | tail -6
```

Expected: FAIL — `Cannot find module './setup.ts'`.

- [ ] **Step 3: Implement `lib/setup.ts`**

```typescript
// Setup: the environment checks that must pass, and the settings a user can
// change from inside the app.
//
// Pure so `node --test` reaches it. The rules here are the ones that can be
// wrong in a way nobody notices — a gate that opens while the checks are
// still loading flashes the whole app and yanks it back; a "takes effect now"
// label on a setting that needs a restart is simply a lie.

export type Effect = "now" | "next-session" | "restart";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  /** Yuri cannot work without this one. tmux is NOT required: without it the
   *  live terminal pane is unavailable, but agents still run. */
  required: boolean;
};

export type ManagedKey = {
  name: string;
  label: string;
  /** A credential. Its value is never sent to the client, so a secret field
   *  starts empty and anything typed into it counts as new. */
  secret: boolean;
  effect: Effect;
  blurb: string;
  set: boolean;
  /** Identifies the value without revealing it ("…4f2a"), or the value itself
   *  for a non-secret. Empty when unset. */
  hint: string;
  source: string;
};

/** The failing checks that actually stop Yuri working. */
export function blocking(checks: DoctorCheck[]): DoctorCheck[] {
  return checks.filter((c) => c.required && !c.ok);
}

/** Whether the app may render instead of the Setup screen.
 *
 *  `null` (not loaded) and `[]` (the endpoint told us nothing) both keep it
 *  SHUT. Opening on unknown state would show the whole app and then remove
 *  it, and an empty list is an absence of information rather than a clean
 *  bill of health. */
export function gateOpen(checks: DoctorCheck[] | null): boolean {
  if (!checks || checks.length === 0) return false;
  return blocking(checks).length === 0;
}

export function effectLabel(e: Effect): string {
  if (e === "now") return "takes effect straight away";
  if (e === "next-session") return "applies to the next agent session";
  return "needs Yuri to restart";
}

/** One sentence for a set of effects, naming the STRONGEST — a change that
 *  needs a restart must not be reported as taking effect now. */
export function effectsSentence(effects: Effect[]): string {
  if (effects.length === 0) return "";
  const strongest: Effect =
    effects.includes("restart") ? "restart"
      : effects.includes("next-session") ? "next-session" : "now";
  return `Saved — ${effectLabel(strongest)}.`;
}

const touched = (draft: Record<string, string>, name: string) =>
  Object.prototype.hasOwnProperty.call(draft, name);

/** Which keys the draft actually changes.
 *
 *  A secret's current value is unknown to the client by design, so it cannot
 *  be compared: anything typed is new. A non-secret can be compared against
 *  the hint, which for a non-secret IS the value. */
export function pendingChanges(
  keys: ManagedKey[], draft: Record<string, string>,
): string[] {
  return keys
    .filter((k) => {
      if (!touched(draft, k.name)) return false;
      const next = (draft[k.name] || "").trim();
      if (!next) return k.set;           // clearing matters only if it was set
      if (k.secret) return true;
      return next !== k.hint;
    })
    .map((k) => k.name);
}

export function canSave(keys: ManagedKey[], draft: Record<string, string>): boolean {
  return pendingChanges(keys, draft).length > 0;
}
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && node --test lib/setup.test.ts 2>&1 | tail -6
cd frontend && node --test lib/*.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"
cd frontend && npx tsc --noEmit -p tsconfig.json
```

Expected: `setup.test.ts` passes, the whole suite is 296 + the new tests with 0 failures, and `tsc` is silent.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/setup.ts frontend/lib/setup.test.ts
git commit -m "feat(setup): the pure rules for the checks and the managed keys"
```

---

## Task 6: The Setup screen

**Files:**
- Create: `frontend/components/SetupPanel.tsx`
- Create: `frontend/app/setup/page.tsx`
- Modify: `frontend/components/shell/Rail.tsx`
- Modify: `frontend/app/globals.css`

**Interfaces:**
- Consumes: everything Task 5 produces; `yget`/`yput`/`ApiError` from `@/lib/api`; `ViewError` from `@/components/ViewError`.
- Produces: `export function SetupPanel({ onPass }: { onPass?: () => void })` — `onPass` fires after a successful save whose re-check leaves nothing blocking, so Task 7's gate can dismiss itself.

- [ ] **Step 1: Write the panel**

Create `frontend/components/SetupPanel.tsx`:

```tsx
"use client";

// Setup: what must be true for Yuri to work, and the settings you can change
// from here instead of editing a file.
//
// The checks come from the same `yuri doctor` implementation the CLI prints,
// so the two cannot disagree. Secret values are never sent to the browser —
// a secret field therefore starts EMPTY with its hint beside the label, and
// leaving it empty changes nothing.
import { useCallback, useEffect, useState } from "react";
import { ApiError, yget, yput } from "@/lib/api";
import {
  blocking, canSave, effectsSentence, pendingChanges,
  type DoctorCheck, type Effect, type ManagedKey,
} from "@/lib/setup";
import { ViewError } from "./ViewError";

export function SetupPanel({ onPass }: { onPass?: () => void }) {
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [keys, setKeys] = useState<ManagedKey[] | null>(null);
  const [where, setWhere] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([
        yget<{ checks: DoctorCheck[]; ok: boolean }>("doctor"),
        yget<{ keys: ManagedKey[]; path: string }>("config"),
      ]);
      setChecks(d.checks || []);
      setKeys(c.keys || []);
      setWhere(c.path || "");
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!keys) return;
    const names = pendingChanges(keys, draft);
    setBusy(true);
    setSaveError("");
    setSaved("");
    try {
      const values: Record<string, string> = {};
      for (const n of names) values[n] = draft[n] ?? "";
      const res = await yput<{ effects: Effect[] }>("config", { values });
      setSaved(effectsSentence(res.effects || []));
      setDraft({});
      await load();
      // Re-read rather than trusting the save: a key can be written and still
      // leave something else blocking.
      const fresh = await yget<{ checks: DoctorCheck[] }>("doctor");
      setChecks(fresh.checks || []);
      if (blocking(fresh.checks || []).length === 0) onPass?.();
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <section className="setup">
        <div className="mcp-head"><h3 className="sectitle">Setup</h3></div>
        <ViewError error={loadError} onRetry={() => void load()} />
      </section>
    );
  }
  if (!checks || !keys) {
    return (
      <section className="setup">
        <div className="mcp-head"><h3 className="sectitle">Setup</h3></div>
        <div className="empty">Checking your machine…</div>
      </section>
    );
  }

  const stops = blocking(checks);

  return (
    <section className="setup">
      <div className="mcp-head"><h3 className="sectitle">Setup</h3></div>
      <p className="mcp-blurb">
        What Yuri needs from this machine, and the keys she uses. These are the same
        checks <code>yuri doctor</code> runs.
      </p>

      {stops.length > 0 && (
        <div className="mcp-configerr">
          {stops.length === 1
            ? `One thing is stopping her: ${stops[0].name}.`
            : `${stops.length} things are stopping her: ${stops.map((s) => s.name).join(", ")}.`}
        </div>
      )}

      <div className="setup-checks">
        {checks.map((c) => (
          <div key={c.name} className={`setup-check ${c.ok ? "ok" : c.required ? "bad" : "warn"}`}>
            <span className="setup-check-name">{c.name}</span>
            <span className="setup-check-detail">{c.detail}</span>
            {!c.ok && !c.required && (
              <span className="tf-hint">Optional — she works without it.</span>
            )}
          </div>
        ))}
      </div>

      <div className="mcp-head" style={{ marginTop: 22 }}>
        <h3 className="sectitle">Keys and models</h3>
      </div>
      <p className="mcp-blurb">
        Saved to <code>{where}</code>, readable only by you. Yuri never sends a saved
        value back to this screen, so a key field starts empty — leave it that way to
        keep the current one.
      </p>

      <div className="setup-keys">
        {keys.map((k) => (
          <label className="tf-field" key={k.name}>
            <span className="tf-label">
              {k.label}
              {k.set && <span className="setup-hint"> · {k.hint} · from {k.source}</span>}
            </span>
            <input
              className="tf-input"
              type={k.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              placeholder={k.set ? (k.secret ? "unchanged" : k.hint) : "not set"}
              value={draft[k.name] ?? ""}
              onChange={(e) => {
                setDraft({ ...draft, [k.name]: e.target.value });
                setSaved("");
              }}
            />
            <span className="tf-hint">{k.blurb}</span>
          </label>
        ))}
      </div>

      {saveError && <pre className="mcp-err">{saveError}</pre>}
      {saved && <em className="setup-saved">{saved}</em>}

      <div className="mcp-actions tf-save">
        <button className="txtoggle primary" disabled={busy || !canSave(keys, draft)}
                onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="txtoggle" disabled={busy} onClick={() => void load()}>
          Check again
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Write the route**

Create `frontend/app/setup/page.tsx`:

```tsx
"use client";

import { SetupPanel } from "@/components/SetupPanel";

export default function Page() {
  return (
    <div className="setup-view">
      <h2 className="viewtitle">Setup</h2>
      <SetupPanel />
    </div>
  );
}
```

- [ ] **Step 3: Add the rail item**

In `frontend/components/shell/Rail.tsx`, append to the `Route[]` array after the `/activity` entry:

```tsx
  { href: "/setup", label: "Setup",
    icon: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></> },
```

- [ ] **Step 4: Add the styles**

Append to `frontend/app/globals.css`. Tokens only — no literal colours (GUIDE.md §1):

```css
/* --- Setup: the checks, and the keys ------------------------------------- */
.setup, .setup-view { min-width: 0; }

.setup-checks {
   display: flex;
   flex-direction: column;
   gap: 6px;
   margin-top: 4px;
}

/* A failing REQUIRED check and a failing optional one must not look the same:
   one stops her, the other costs a feature. */
.setup-check {
   display: grid;
   grid-template-columns: 110px 1fr;
   gap: 4px 12px;
   align-items: baseline;
   padding: 7px 10px;
   border: 1px solid var(--line);
   border-left-width: 3px;
   border-radius: 8px;
   min-width: 0;
}

.setup-check.ok   { border-left-color: var(--good); }
.setup-check.bad  { border-left-color: var(--danger); }
.setup-check.warn { border-left-color: var(--warn); }

.setup-check-name {
   font-family: var(--disp);
   text-transform: uppercase;
   letter-spacing: 0.06em;
   font-size: 10px;
   color: var(--mut);
}

.setup-check-detail {
   font-family: var(--mono);
   font-size: 12px;
   color: var(--ink);
   overflow-wrap: anywhere;
}

.setup-check .tf-hint { grid-column: 2; }

.setup-keys {
   display: flex;
   flex-direction: column;
   gap: 4px;
}

.setup-hint {
   font-family: var(--mono);
   text-transform: none;
   letter-spacing: 0;
   color: var(--dim);
}

.setup-saved {
   display: block;
   margin-top: 10px;
   font-size: 12px;
   color: var(--good);
}
```

These three tokens are confirmed present in `globals.css:12-14` — `--good`, `--warn`,
`--danger`. There is no `--ok`; the success token is `--good`.

- [ ] **Step 5: Typecheck and build**

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
cd frontend && npx next build 2>&1 | grep -E "Compiled|error|/setup"
cd frontend && node --test lib/*.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"
```

Expected: `tsc` silent, `✓ Compiled successfully`, `/setup` in the route list, 0 test failures.

- [ ] **Step 6: Verify in a browser against an ISOLATED stack**

Never point a scratch frontend at the developer's own backend. Two things make that happen and both have bitten this repo:

- `BACKEND_URL` is **inlined at build time** by Turbopack. Setting it only for `next start` has no effect — you must set it for `next build`.
- Check both ports are free *first*; a failed bind silently leaves the previous server serving.

```bash
cd /Users/ankur/Projects/yuri-code
SC=$(mktemp -d)
for p in 3155 8155; do lsof -ti tcp:$p -sTCP:LISTEN >/dev/null && { echo "$p BUSY - stop"; exit 1; }; done
mkdir -p "$SC/YuriHome"
(cd backend && YURI_HOME="$SC/YuriHome" YAPCODE_CONFIG_DIR="$SC/cfg" \
   nohup .venv/bin/python -m uvicorn main:app --port 8155 > "$SC/be.log" 2>&1 &)
sleep 4
cd frontend && BACKEND_URL=http://127.0.0.1:8155 npx next build > "$SC/b.log" 2>&1
grep -rho "http://127.0.0.1:8155/yuri" .next/server/chunks/*.js | head -1   # must print
nohup npx next start -p 3155 > "$SC/f.log" 2>&1 &
sleep 6
curl -s localhost:3155/api/yuri/doctor | head -c 200
```

Confirm by hand at `http://localhost:3155/setup`:
1. Every check renders, and a failing optional check (`tmux`, if absent) looks different from a failing required one.
2. A secret field is empty with its hint beside the label; Save is disabled until something is typed.
3. Saving `ANTHROPIC_MODEL` reports "applies to the next agent session" and the value appears in `$SC/cfg/.env` at mode 600 — `ls -l "$SC/cfg/.env"`.
4. Clearing it removes the line.

Then tear down and remove the build, which has the scratch URL baked in:

```bash
kill $(lsof -ti tcp:3155 -sTCP:LISTEN) $(lsof -ti tcp:8155 -sTCP:LISTEN) 2>/dev/null
rm -rf "$SC" frontend/.next
```

- [ ] **Step 7: Commit**

```bash
git add frontend/components/SetupPanel.tsx frontend/app/setup/page.tsx \
        frontend/components/shell/Rail.tsx frontend/app/globals.css
git commit -m "feat(setup): a Setup panel for the checks and the keys"
```

---

## Task 7: The gate

When a required check fails, the app must show Setup rather than a UI whose every action will fail.

**Files:**
- Create: `frontend/components/SetupGate.tsx`
- Modify: `frontend/app/layout.tsx`

**Interfaces:**
- Consumes: `gateOpen`, `DoctorCheck` from `@/lib/setup`; `SetupPanel` from Task 6.
- Produces: `export function SetupGate({ children }: { children: React.ReactNode })`.

- [ ] **Step 1: Write the gate**

Create `frontend/components/SetupGate.tsx`:

```tsx
"use client";

// Shows Setup instead of the app when something required is missing.
//
// Rather than a UI whose every button fails: without a voice key she cannot
// talk, and without `claude` no session can start. The gate is checked ONCE
// per load — it is a first-run and misconfiguration gate, not a supervisor,
// and re-checking on every render would put a doctor probe (which touches the
// filesystem and the network) on the critical path of every navigation.
//
// It stays SHUT while the answer is unknown: opening on unknown state would
// render the whole app and then snatch it away. `/setup` itself is never
// gated, or a failing check would make the fix unreachable.
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { yget } from "@/lib/api";
import { gateOpen, type DoctorCheck } from "@/lib/setup";
import { SetupPanel } from "./SetupPanel";

export function SetupGate({ children }: { children: React.ReactNode }) {
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [reachable, setReachable] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    let live = true;
    yget<{ checks: DoctorCheck[] }>("doctor")
      .then((d) => live && setChecks(d.checks || []))
      // A backend that cannot be reached is not a failed check — it is a
      // different problem, and the app's own error surfaces say it better
      // than a Setup screen would.
      .catch(() => live && setReachable(false));
    return () => { live = false; };
  }, []);

  if (!reachable || dismissed) return <>{children}</>;
  if (pathname === "/setup") return <>{children}</>;
  if (checks === null) return <div className="empty">Checking your machine…</div>;
  if (gateOpen(checks)) return <>{children}</>;

  return (
    <div className="setup-view">
      <h2 className="viewtitle">Before Yuri can start</h2>
      <SetupPanel onPass={() => setDismissed(true)} />
    </div>
  );
}
```

- [ ] **Step 2: Mount it**

In `frontend/app/layout.tsx`, wrap the stage's children with `<SetupGate>`. Read the file first: the gate must sit **inside** `VoiceProvider` (it calls `yget`, and the provider owns auth) but **around** the routed content, so the rail and dock stay visible and a user can reach `/setup`.

- [ ] **Step 3: Typecheck, build, test**

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
cd frontend && npx next build 2>&1 | grep -E "Compiled|error"
cd frontend && node --test lib/*.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"
```

Expected: silent, `✓ Compiled successfully`, 0 failures.

- [ ] **Step 4: Verify the gate both ways, on an isolated stack**

Use the same isolated-stack recipe as Task 6, Step 6 — including building with `BACKEND_URL` set, not just starting with it.

With **no voice key** in the scratch config, `/` must show "Before Yuri can start". Add a key through the form; the gate must dismiss without a reload. Then confirm `/setup` was reachable the whole time — that is what stops a failing check making its own fix unreachable.

- [ ] **Step 5: Full suites, then commit**

```bash
cd backend && .venv/bin/python -m unittest discover -s tests -q 2>&1 | tail -3
cd frontend && node --test lib/*.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"
```

```bash
git add frontend/components/SetupGate.tsx frontend/app/layout.tsx
git commit -m "feat(setup): show Setup instead of a UI whose every action would fail"
```

---

## Self-review

**Spec §6 coverage**

| Spec | Task |
|---|---|
| §6.2 doctor as a UI surface, one implementation | 1, 4, 6 |
| §6.2 required vs optional (tmux not blocking) | 1 (`REQUIRED_CHECKS`), 5 (`blocking`), 6 (styling) |
| §6.3 managed values (voice + `ANTHROPIC_*`) | 3 (`MANAGED_KEYS`) |
| §6.3 precedence fix (real env wins) | 2 |
| §6.3 presence and masked hint only, never a value | 3, 4 (two explicit leak tests), 5, 6 |
| §6.4 effect scopes labelled honestly | 3 (`effect`), 5 (`effectsSentence`), 6 |
| §6.5 `GET /yuri/doctor`, `GET`/`PUT /yuri/config` | 4 |
| §9 R1: a denied microphone must be reported plainly | **not covered — see below** |

**Gaps, stated rather than hidden**

- **The microphone check is absent.** Spec §9 R1 requires the setup screen to report a *denied* mic explicitly, since a silently-denied mic is indistinguishable from voice being broken. It is not here because mic status comes from Electron's `systemPreferences`, which does not exist until sub-project 2 — a browser can only discover it by *requesting* the mic, which would prompt. It belongs in sub-project 2's plan, as a check the gate renders through the same `DoctorCheck` shape Task 1 defines. That shape was chosen so it can be added there without changing anything here.
- **`safeStorage` is absent**, deliberately, per "Deliberate deviation from the spec" above.
- **§6.1's boot window and §6.4's "offer to restart the backend" are absent** — both need the Electron main process that owns the child. Sub-project 2.

**Placeholder scan:** none. Every step carries the code or the command it needs.

**Type consistency:** `Check` (backend dataclass) serialises to `DoctorCheck` (frontend type) with the same four fields; `ManagedKey` exists on both sides, with the backend adding `set`/`hint`/`source` in `managed_status()` and the frontend type including all seven. `Effect` is the same three strings in both. `setup_store.write(values, *, config_dir=None)` is called with one positional argument in Task 4's route and with the keyword in its tests, which the signature supports.
