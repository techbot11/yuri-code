# Yuri OS Desktop Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the working-from-a-clone Electron shell into an installable, unsigned `Yuri OS.app` that ships its own Python, tells you plainly when the microphone is denied, keeps API keys in the Keychain, and can restart its own backend.

**Architecture:** A build script produces a trimmed, relocatable Python payload; `electron-builder` packages it as `extraResources` beside the asar, and one pure function decides whether main spawns the bundled interpreter (packaged) or `backend/.venv` (dev). Three new IPC channels — microphone status, credential writes, backend restart — follow the existing `boot:*` pattern: a pure decision function in `lib/`, a thin main-process handler, and a renderer surface that renders states distinguishably.

**Tech Stack:** Electron 35.7.5, electron-builder, `python-build-standalone` 3.14, Next 16.2.6 / React 19, FastAPI, `claude-agent-sdk`.

**Spec:** `docs/superpowers/specs/2026-09-05-yuri-desktop-app-design.md`

**Carried-forward constraints from sub-project 2a:** `docs/yuri/desktop-shell.md` — read it. `BACKEND_URL` is inlined at `next build` time; the tray rule lives only in `frontend/lib/trayState.ts`; `child.killed` does not mean the child died; per-cycle child state must not outlive its cycle.

## Global Constraints

- **Unsigned first.** `identity: null`, `hardenedRuntime: false`. Signing and notarization are deferred, not cancelled (spec §11, R1 consequence 2). Do not add a signing identity in this plan.
- **`appId: com.yuri.app`**, `productName: Yuri OS` (already in `desktop/package.json`).
- **`NSMicrophoneUsageDescription` must reach `Info.plist`** via `mac.extendInfo`. R1 measured that this is what makes the TCC prompt appear and `getUserMedia` succeed in an unsigned packaged app.
- **Every packaged rebuild re-prompts for the microphone.** Measured in R1: a grant does not survive repackaging, even with a byte-identical CDHash. Expect it; never diagnose it as a regression.
- **Pin exact dependency versions** — no `^`, no `~` (org supply-chain rule).
- **Never bind or send a request to ports 8000 or 3000** during verification; they are the user's own workflow. Use 8198 (backend) and 3199 (frontend) via `YURI_DESKTOP_BACKEND_PORT` / `YURI_DESKTOP_FRONTEND_PORT`, and set `YURI_HOME` to a scratch directory.
- **Never print or log a secret value.** The resolved environment carries `ANTHROPIC_AUTH_TOKEN`; credentials work in Task 5 handles plaintext in memory. Log key *names* and booleans only.
- **Plaintext credentials never touch disk** (spec §6.3). `safeStorage` ciphertext goes to `~/Library/Application Support/Yuri OS/credentials.enc`.
- **Leave `frontend/.next` in its default state** at the end of any task: a plain `npx next build`, which inlines `http://localhost:8000`.
- **Do not modify `frontend/components/shell/Rail.tsx`.**
- **Test runners.** Backend: `cd backend && .venv/bin/python -m unittest discover -s tests -q` (1657 passing). Frontend: `cd frontend && node --test lib/*.test.ts` (373 passing) — **pure functions only, there is no DOM environment**. Desktop: `npm --prefix desktop test` over `desktop/lib/*.test.ts` (56 passing) — **pure functions only**. There is no bash test harness. React components and main-process code are verified by running the app and probing it.
- **Design guide** `docs/yuri/design/GUIDE.md`: a control that cannot work is not rendered; empty, loading and failed never look the same.

## File Structure

| File | Responsibility |
|---|---|
| `backend/agent_cli.py` (new) | Resolve the one `claude` binary and its version. Pure parsing; `shutil.which` injected. |
| `backend/claude_runner.py:247` | Pass `cli_path` so the SDK stops preferring its bundled copy. |
| `backend/yuri/doctor.py:169` | Report the resolved path *and* version, per backend, so skew is visible. |
| `backend/yuri/payload.py` (new) | Which files the Python payload prunes, and the size budget. Pure; lives in `backend/` because that is where a Python test runner exists. |
| `desktop/scripts/build-python.py` (new) | Thin CLI over `yuri.payload`: download, install, prune, report. |
| `desktop/lib/paths.ts` (new) | Packaged-vs-dev path resolution for the interpreter and backend cwd. Pure. |
| `desktop/electron-builder.yml` (new) | Bundle config: appId, unsigned, `extraResources`, `mac.extendInfo`. |
| `desktop/lib/mic.ts` (new) | Map a TCC status to a boot-checklist row. Pure. |
| `desktop/lib/credentials.ts` (new) | Serialise/parse the credential blob; name the secret keys. Pure. |
| `desktop/main/credentials.ts` (new) | `safeStorage` read/write and the env handed to children. |
| `frontend/lib/restart.ts` (new) | What restarting the backend would interrupt. Pure. |
| `frontend/components/BootSplash.tsx` | A microphone row when it is denied. |
| `frontend/components/SetupPanel.tsx` | Write credentials over IPC in Electron; offer the restart. |

---

### Task 1: One `claude`, not two

The SDK ships its own 203 MB `claude` and **prefers it over the one on `PATH`** (`claude_agent_sdk/_internal/transport/subprocess_cli.py:84-90`: bundled first, `shutil.which` second). The `cli` backend uses `shutil.which("claude")` (`backend/tmux_runner.py:287`). So today an `sdk` session and a `cli` session run **different Claude Code versions silently** — measured at 2.1.150 bundled against 2.1.261 on `PATH`. The spec calls this out as predating the desktop work and worth fixing on its own merits.

`cli_path` is public API (`claude_agent_sdk/types.py:1702`, "Path to the Claude Code CLI executable"), and setting it bypasses `_find_cli()` entirely. Setting it to the same binary the `cli` backend resolves makes the two agree **by construction**, and makes the 203 MB bundle deletable in Task 2 rather than merely unused.

**Files:**
- Create: `backend/agent_cli.py`
- Create: `backend/tests/test_agent_cli.py`
- Modify: `backend/claude_runner.py:247-256`
- Modify: `backend/yuri/doctor.py:169-172`

**Interfaces:**
- Consumes: nothing.
- Produces: `backend/agent_cli.py` with `resolve() -> str | None`, `parse_version(output: str) -> str | None`, `version(path: str) -> str | None`, `describe(path: str | None, ver: str | None) -> str`. Task 2 relies on `_bundled` being genuinely unused after this.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_agent_cli.py`:

```python
import unittest

import agent_cli


class ParseVersion(unittest.TestCase):
    def test_the_normal_output(self):
        self.assertEqual(agent_cli.parse_version("2.1.261 (Claude Code)\n"), "2.1.261")

    def test_a_bare_version(self):
        self.assertEqual(agent_cli.parse_version("2.1.150\n"), "2.1.150")

    def test_leading_noise_before_the_version(self):
        # A shell that prints a banner first must not defeat the parse.
        self.assertEqual(
            agent_cli.parse_version("nvm: using node 22\n2.1.261 (Claude Code)\n"), "2.1.261")

    def test_nothing_usable(self):
        for out in ("", "\n", "command not found", "Claude Code"):
            self.assertIsNone(agent_cli.parse_version(out), out)


class Resolve(unittest.TestCase):
    def test_uses_the_injected_lookup(self):
        self.assertEqual(agent_cli.resolve(which=lambda _n: "/opt/bin/claude"), "/opt/bin/claude")

    def test_absent_is_none_not_an_exception(self):
        # doctor already reports a missing claude as a required failure; this
        # must not raise on the way there.
        self.assertIsNone(agent_cli.resolve(which=lambda _n: None))


class Describe(unittest.TestCase):
    def test_path_and_version_together(self):
        # Both, because a path alone cannot show skew and a version alone
        # cannot show WHICH binary produced it.
        self.assertEqual(agent_cli.describe("/opt/bin/claude", "2.1.261"),
                         "/opt/bin/claude (2.1.261)")

    def test_version_unknown_still_names_the_path(self):
        self.assertEqual(agent_cli.describe("/opt/bin/claude", None),
                         "/opt/bin/claude (version unknown)")

    def test_absent(self):
        self.assertEqual(agent_cli.describe(None, None),
                         "not on PATH — install Claude Code")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && .venv/bin/python -m unittest tests.test_agent_cli -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'agent_cli'`

- [ ] **Step 3: Write the implementation**

Create `backend/agent_cli.py`:

```python
"""The one `claude` binary both backends use.

The SDK ships its own copy and PREFERS it over PATH
(claude_agent_sdk/_internal/transport/subprocess_cli.py:84-90 tries the
bundled CLI before shutil.which). tmux_runner uses PATH. So without this an
sdk-backed session and a cli-backed session run DIFFERENT Claude Code
versions and nothing says so -- measured at 2.1.150 bundled against 2.1.261
on PATH.

Passing `cli_path` (public API, types.py:1702) bypasses that resolution
entirely, which is what makes the two agree by construction rather than by
both happening to find the same file. It is also what lets the 203 MB
bundled copy be pruned from the packaged payload.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from typing import Callable

# `claude --version` prints "2.1.261 (Claude Code)". Anchored to a line so a
# login shell's banner cannot contribute a match, and non-greedy on nothing --
# a version is three dotted numbers or we do not claim to know it.
_VERSION_RE = re.compile(r"^(\d+\.\d+\.\d+)\b", re.MULTILINE)

VERSION_TIMEOUT_S = 5.0


def resolve(which: Callable[[str], str | None] = shutil.which) -> str | None:
    """The `claude` on PATH, or None. `which` is injected for testing."""
    return which("claude")


def parse_version(output: str) -> str | None:
    """The version in `claude --version` output, or None if there isn't one."""
    m = _VERSION_RE.search(output)
    return m.group(1) if m else None


def version(path: str) -> str | None:
    """Ask the binary its version. None on any failure -- a version we cannot
    read is not a reason to refuse to start, only a detail we cannot show."""
    try:
        p = subprocess.run([path, "--version"], capture_output=True, text=True,
                           timeout=VERSION_TIMEOUT_S, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_version(p.stdout or "") or parse_version(p.stderr or "")


def describe(path: str | None, ver: str | None) -> str:
    """The doctor line. Path AND version: a path alone cannot reveal skew, and
    a version alone cannot say which binary produced it."""
    if path is None:
        return "not on PATH — install Claude Code"
    return f"{path} ({ver})" if ver else f"{path} (version unknown)"
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && .venv/bin/python -m unittest tests.test_agent_cli -v`
Expected: PASS, 8 tests.

- [ ] **Step 5: Point the SDK at that binary**

In `backend/claude_runner.py`, add the import beside the existing ones:

```python
import agent_cli
```

Then in the `sdk.ClaudeAgentOptions(...)` call at line 247, add one entry, following the file's own `**({...} if ... else {})` idiom used for `model` and `agents`:

```python
        opts = sdk.ClaudeAgentOptions(
            # Passing model="" would ask for a model literally named "", so an
            # unset model omits the option and lets the SDK resolve it.
            **({"model": s.model} if s.model else {}),
            # The SDK prefers its own bundled `claude` over the one on PATH,
            # so without this an sdk session and a cli session run different
            # Claude Code versions with nothing saying so. Omitted when there
            # is no `claude` at all, which leaves the SDK's own error (and
            # doctor's required-check failure) to say so.
            **({"cli_path": p} if (p := agent_cli.resolve()) else {}),
            cwd=cwd,
```

- [ ] **Step 6: Make the version visible in doctor**

In `backend/yuri/doctor.py`, replace lines 169-172 (the current `claude` check, which reports only the path) with:

```python
    claude = agent_cli.resolve()
    out.append(_check("claude", claude is not None,
                      agent_cli.describe(claude, agent_cli.version(claude) if claude else None),
                      fix=Fix("Install Claude Code", CLAUDE_INSTALL_URL) if claude is None else None))
```

Add `import agent_cli` to that file's imports. Keep the existing `_check` and `Fix` usage exactly as the surrounding checks use them — read the two checks either side and match their argument style, since `_check`'s signature is local to this file.

- [ ] **Step 7: Verify doctor still passes and now shows a version**

```bash
cd backend && .venv/bin/python -m yuri.doctor
```

Expected: the `claude` line now reads a path followed by a version in parentheses. Confirm the version matches `claude --version` run directly — if it does not, `resolve()` and your shell disagree and that is the bug this task exists to remove.

- [ ] **Step 8: Run the full backend suite**

Run: `cd backend && .venv/bin/python -m unittest discover -s tests -q`
Expected: 1665 tests, 0 failures (1657 + 8).

- [ ] **Step 9: Commit**

```bash
git add backend/agent_cli.py backend/tests/test_agent_cli.py backend/claude_runner.py backend/yuri/doctor.py
git commit -m "fix(agents): one claude binary for both backends, and show its version"
```

---

### Task 2: A trimmed Python payload, with a gate that keeps it trimmed

R2 measured a relocatable CPython 3.14 at 68 MB unpacked, reaching **355 MB** once `requirements.lock` is installed — 203 MB of it the SDK's bundled `claude` (unused after Task 1) and a large share `__pycache__`. Trimming is most of the payload, not housekeeping.

The pruning rules and the size budget live in `backend/yuri/payload.py` because that is where a Python test runner exists; `desktop/scripts/build-python.py` is a thin CLI over them.

**Files:**
- Create: `backend/yuri/payload.py`
- Create: `backend/tests/test_payload.py`
- Create: `desktop/scripts/build-python.py`

**Interfaces:**
- Consumes: Task 1's removal of the bundled CLI from the live path.
- Produces: a payload directory at `desktop/build/python/` and `backend/yuri/payload.py` with `should_prune(rel: str) -> bool`, `PRUNE_SEGMENTS: tuple[str, ...]`, `MAX_PAYLOAD_BYTES: int`, `within_budget(total: int) -> bool`, `human(total: int) -> str`. Task 3 packages that directory.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_payload.py`:

```python
import unittest

from yuri import payload


class ShouldPrune(unittest.TestCase):
    def test_prunes_the_big_four(self):
        for rel in ("lib/python3.14/site-packages/claude_agent_sdk/_bundled",
                    "lib/python3.14/site-packages/pip",
                    "lib/python3.14/site-packages/setuptools",
                    "lib/python3.14/__pycache__"):
            self.assertTrue(payload.should_prune(rel), rel)

    def test_prunes_nested_pycache(self):
        self.assertTrue(payload.should_prune("lib/python3.14/site-packages/anyio/__pycache__"))

    def test_keeps_what_the_app_imports(self):
        # R2 confirmed every native import works; pruning any of these breaks
        # the backend at startup, which is the failure this test prevents.
        for rel in ("lib/python3.14/site-packages/pydantic_core",
                    "lib/python3.14/site-packages/rpds",
                    "lib/python3.14/site-packages/charset_normalizer",
                    "lib/python3.14/site-packages/websockets",
                    "lib/python3.14/site-packages/_cffi_backend.abi3.so",
                    "lib/python3.14/site-packages/claude_agent_sdk/_internal",
                    "bin/python3.14"):
            self.assertFalse(payload.should_prune(rel), rel)

    def test_matches_whole_segments_not_substrings(self):
        # The bug this catches: a substring rule for "test" prunes pytest_asyncio
        # and "latest", and a substring rule for "pip" prunes "pipeline".
        for rel in ("lib/python3.14/site-packages/pytest_asyncio",
                    "lib/python3.14/site-packages/latest_thing",
                    "lib/python3.14/site-packages/pipeline",
                    "lib/python3.14/site-packages/setuptools_scm_helper"):
            self.assertFalse(payload.should_prune(rel), rel)

    def test_a_segment_named_tests_is_pruned(self):
        self.assertTrue(payload.should_prune("lib/python3.14/site-packages/anyio/tests"))


class Budget(unittest.TestCase):
    def test_the_budget_is_a_real_ceiling_not_a_placeholder(self):
        # 355 MB is the UNtrimmed measurement from spike R2. A budget at or
        # above it would gate nothing.
        self.assertLess(payload.MAX_PAYLOAD_BYTES, 355 * 1024 * 1024)

    def test_within_budget(self):
        self.assertTrue(payload.within_budget(payload.MAX_PAYLOAD_BYTES))
        self.assertFalse(payload.within_budget(payload.MAX_PAYLOAD_BYTES + 1))

    def test_human_is_readable(self):
        self.assertEqual(payload.human(1024 * 1024), "1.0 MB")
        self.assertEqual(payload.human(157 * 1024 * 1024), "157.0 MB")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && .venv/bin/python -m unittest tests.test_payload -v`
Expected: FAIL — `ImportError: cannot import name 'payload' from 'yuri'`

- [ ] **Step 3: Write the implementation**

Create `backend/yuri/payload.py`. Set `MAX_PAYLOAD_BYTES` to a placeholder of `200 * 1024 * 1024` for now; Step 6 replaces it with the measured figure.

```python
"""What the bundled Python payload keeps, and how big it is allowed to get.

Spike R2 measured a relocatable CPython 3.14 at 68 MB unpacked and 355 MB
once requirements.lock is installed. Most of that is removable: 203 MB is the
claude-agent-sdk's own bundled `claude`, which agent_cli.py now bypasses in
favour of the one on PATH, and a large share is __pycache__ regenerated on
first import anyway.

The rules match whole PATH SEGMENTS, never substrings. A substring rule for
"test" also prunes pytest_asyncio; one for "pip" also prunes pipeline. Both
would break the backend at startup, in a build, with a traceback pointing at
an import rather than at this file.
"""
from __future__ import annotations

# Whole directory names to drop wherever they appear in the payload.
PRUNE_SEGMENTS: tuple[str, ...] = (
    "__pycache__",     # regenerated on first import
    "_bundled",        # the SDK's own 203 MB claude; agent_cli.py bypasses it
    "pip",             # nothing installs at runtime
    "setuptools",
    "pkg_resources",
    "tests",
    "test",
    "idlelib",         # the stdlib's Tk IDE
    "tkinter",         # no GUI toolkit is used; the app's UI is the renderer
    "lib2to3",
)

# The ceiling, measured on a real trimmed build (see this task's Step 6). A
# gate, not a guess: it exists so a dependency that quietly reintroduces a
# large payload fails the suite instead of shipping.
MAX_PAYLOAD_BYTES: int = 200 * 1024 * 1024


def should_prune(rel: str) -> bool:
    """Whether a payload-relative path should be dropped.

    `rel` is compared segment by segment, so "pytest_asyncio" survives a
    "test" rule and "pipeline" survives a "pip" rule.
    """
    return any(seg in PRUNE_SEGMENTS for seg in rel.split("/"))


def within_budget(total: int) -> bool:
    return total <= MAX_PAYLOAD_BYTES


def human(total: int) -> str:
    return f"{total / (1024 * 1024):.1f} MB"
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && .venv/bin/python -m unittest tests.test_payload -v`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the build script**

Create `desktop/scripts/build-python.py`:

```python
#!/usr/bin/env python3
"""Build the bundled Python payload for the packaged app.

Downloads a relocatable CPython, installs the backend's locked requirements
into it, prunes what yuri.payload says to prune, and reports the size against
the budget. Idempotent: an existing payload is reused unless --clean.

Run from the repo root:  python3 desktop/scripts/build-python.py
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tarfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "backend"))
from yuri import payload  # noqa: E402  (needs the path above)

# python-build-standalone, arm64 macOS. Pinned exactly: an unpinned "latest"
# would change the interpreter under the app between builds.
PBS_VERSION = "3.14.0"
PBS_RELEASE = "20251014"
PBS_URL = (f"https://github.com/astral-sh/python-build-standalone/releases/download/"
           f"{PBS_RELEASE}/cpython-{PBS_VERSION}+{PBS_RELEASE}-aarch64-apple-darwin-"
           f"install_only.tar.gz")

BUILD_DIR = os.path.join(ROOT, "desktop", "build")
PAYLOAD_DIR = os.path.join(BUILD_DIR, "python")
TARBALL = os.path.join(BUILD_DIR, f"cpython-{PBS_VERSION}.tar.gz")


def log(msg: str) -> None:
    print(f"[build-python] {msg}", flush=True)


def download() -> None:
    if os.path.exists(TARBALL):
        log(f"tarball already present: {os.path.basename(TARBALL)}")
        return
    os.makedirs(BUILD_DIR, exist_ok=True)
    log(f"downloading {PBS_URL}")
    urllib.request.urlretrieve(PBS_URL, TARBALL)


def unpack() -> None:
    if os.path.isdir(PAYLOAD_DIR):
        log("payload directory already unpacked")
        return
    log("unpacking")
    with tarfile.open(TARBALL) as tf:
        tf.extractall(BUILD_DIR)
    # The archive unpacks to "python/"; assert rather than assume, so a
    # changed archive layout fails here instead of three steps later.
    if not os.path.isdir(PAYLOAD_DIR):
        raise SystemExit(f"expected {PAYLOAD_DIR} after unpacking; archive layout changed")


def install_requirements() -> None:
    py = os.path.join(PAYLOAD_DIR, "bin", "python3")
    lock = os.path.join(ROOT, "backend", "requirements.lock")
    if not os.path.isfile(lock):
        raise SystemExit(f"no {lock} — the payload must be built from the locked set")
    log("installing requirements.lock")
    subprocess.run([py, "-m", "pip", "install", "--no-cache-dir", "-r", lock], check=True)


def prune() -> int:
    removed = 0
    # Bottom-up so a pruned parent does not invalidate the walk.
    for dirpath, dirnames, _files in os.walk(PAYLOAD_DIR, topdown=False):
        for d in list(dirnames):
            full = os.path.join(dirpath, d)
            rel = os.path.relpath(full, PAYLOAD_DIR)
            if payload.should_prune(rel):
                removed += dir_size(full)
                shutil.rmtree(full, ignore_errors=True)
    return removed


def dir_size(path: str) -> int:
    total = 0
    for dirpath, _dirnames, files in os.walk(path):
        for f in files:
            fp = os.path.join(dirpath, f)
            if not os.path.islink(fp):
                total += os.path.getsize(fp)
    return total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clean", action="store_true", help="rebuild from scratch")
    args = ap.parse_args()

    if args.clean and os.path.isdir(PAYLOAD_DIR):
        log("removing the existing payload")
        shutil.rmtree(PAYLOAD_DIR)

    download()
    unpack()
    install_requirements()
    before = dir_size(PAYLOAD_DIR)
    freed = prune()
    after = dir_size(PAYLOAD_DIR)

    log(f"before prune: {payload.human(before)}")
    log(f"pruned:       {payload.human(freed)}")
    log(f"payload:      {payload.human(after)}  (budget {payload.human(payload.MAX_PAYLOAD_BYTES)})")

    if not payload.within_budget(after):
        log("OVER BUDGET — either trim more or raise MAX_PAYLOAD_BYTES deliberately")
        return 1

    # Prove it still runs. R2 checked twelve top-level imports under a fully
    # scrubbed environment; the native ones are the ones that break when a
    # prune rule is too broad.
    py = os.path.join(PAYLOAD_DIR, "bin", "python3")
    probe = ("import pydantic_core, rpds, charset_normalizer, websockets, _cffi_backend, "
             "fastapi, uvicorn, claude_agent_sdk; print('imports ok')")
    r = subprocess.run(["env", "-i", py, "-c", probe], capture_output=True, text=True)
    if r.returncode != 0:
        log("PAYLOAD IS BROKEN after pruning — a rule is too broad:")
        log(r.stderr.strip()[-1200:])
        return 1
    log(r.stdout.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 6: Build it, then set the budget to the measured size**

```bash
cd /Users/ankur/Projects/yuri-code && python3 desktop/scripts/build-python.py --clean
```

Read the reported payload size. Then set `MAX_PAYLOAD_BYTES` in `backend/yuri/payload.py` to that measurement **rounded up by about 10%** — enough headroom that an ordinary dependency bump does not trip it, tight enough that reintroducing the 203 MB CLI does. Put the measured figure and the date in the comment, e.g.:

```python
# Measured 157 MB on 2026-09-06 (from 355 MB untrimmed). 10% headroom.
MAX_PAYLOAD_BYTES: int = 173 * 1024 * 1024
```

If the reported size is at or above 355 MB, stop: the prune did nothing and the walk or the rules are wrong. If the import probe fails, a rule is too broad — the probe output names the module.

- [ ] **Step 7: Re-run the suite and the build**

```bash
cd backend && .venv/bin/python -m unittest tests.test_payload -v
cd /Users/ankur/Projects/yuri-code && python3 desktop/scripts/build-python.py
```

Expected: tests pass with the real budget (the "budget is a real ceiling" test still passes), and the second build reports "imports ok" and reuses the payload without re-downloading.

- [ ] **Step 8: Keep the payload out of git**

Append to `desktop/.gitignore`:

```
build/
```

- [ ] **Step 9: Commit**

```bash
git add backend/yuri/payload.py backend/tests/test_payload.py desktop/scripts/build-python.py desktop/.gitignore
git commit -m "feat(desktop): build a trimmed bundled Python payload, with a size gate"
```

---

### Task 3: An installable, unsigned `Yuri OS.app`

`electron-builder` packages the asar plus the Task 2 payload as `extraResources`. One pure function decides where main looks for the interpreter, because a packaged app and a dev run resolve it differently and getting that wrong is a boot failure with a confusing message.

**Files:**
- Create: `desktop/lib/paths.ts`
- Create: `desktop/lib/paths.test.ts`
- Create: `desktop/electron-builder.yml`
- Modify: `desktop/package.json`
- Modify: `desktop/main/servers.ts`

**Interfaces:**
- Consumes: `desktop/build/python/` from Task 2.
- Produces: `desktop/lib/paths.ts` with `pythonPath(env: PathEnv): string`, `backendCwd(env: PathEnv): string`, and `type PathEnv = { packaged: boolean; resourcesPath: string; repoRoot: string }`. Tasks 4-6 do not depend on it.

- [ ] **Step 1: Write the failing test**

Create `desktop/lib/paths.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { backendCwd, pythonPath, type PathEnv } from "./paths.ts";

const packaged: PathEnv = {
  packaged: true,
  resourcesPath: "/Applications/Yuri OS.app/Contents/Resources",
  repoRoot: "/ignored/when/packaged",
};
const dev: PathEnv = {
  packaged: false,
  resourcesPath: "/ignored/in/dev",
  repoRoot: "/Users/me/yuri-code",
};

test("packaged: the interpreter comes from the bundle, never the repo", () => {
  assert.equal(pythonPath(packaged),
    "/Applications/Yuri OS.app/Contents/Resources/python/bin/python3");
});

test("dev: the interpreter is the repo's venv", () => {
  // A packaged path in dev would mean editing backend code and running a
  // stale bundled copy of it.
  assert.equal(pythonPath(dev), "/Users/me/yuri-code/backend/.venv/bin/python");
});

test("packaged: the backend's cwd is the bundled backend, not the repo", () => {
  assert.equal(backendCwd(packaged),
    "/Applications/Yuri OS.app/Contents/Resources/backend");
});

test("dev: the backend's cwd is the repo's backend", () => {
  assert.equal(backendCwd(dev), "/Users/me/yuri-code/backend");
});

test("a path with spaces is returned intact, not escaped or quoted", () => {
  // "Yuri OS.app" always contains a space. Quoting belongs to whoever builds
  // a command line, and a pre-quoted path here would be quoted twice.
  assert.ok(pythonPath(packaged).includes("Yuri OS.app"));
  assert.ok(!pythonPath(packaged).includes("\\"));
  assert.ok(!pythonPath(packaged).includes('"'));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix desktop test`
Expected: FAIL — cannot find module `./paths.ts`

- [ ] **Step 3: Write the implementation**

Create `desktop/lib/paths.ts`:

```ts
// Where the backend's interpreter and code live, which differs between a
// packaged app and a dev run.
//
// Pure, and takes its inputs rather than reading `app.isPackaged` and
// `process.resourcesPath` itself, so `node --test` can reach it -- the
// desktop suite has no Electron.
//
// Getting this wrong is not a subtle failure but it IS a confusing one: a dev
// run pointed at a bundled interpreter silently runs a stale copy of the
// backend while you edit the real one.

import path from "node:path";

export type PathEnv = {
  /** Electron's `app.isPackaged`. */
  packaged: boolean;
  /** Electron's `process.resourcesPath` -- Contents/Resources in a bundle. */
  resourcesPath: string;
  /** The repo root, for a dev run. */
  repoRoot: string;
};

/** The Python that runs uvicorn.
 *
 *  Packaged: the payload electron-builder copied into Resources/python (see
 *  desktop/electron-builder.yml's extraResources and
 *  desktop/scripts/build-python.py). Dev: the repo's own venv, so editing
 *  backend code takes effect.
 *
 *  Returned unescaped and unquoted. "Yuri OS.app" always contains a space,
 *  and quoting is the job of whoever builds a command line -- a path quoted
 *  here would be quoted twice. `spawn` with an argv array needs no quoting at
 *  all, which is how servers.ts uses it. */
export function pythonPath(env: PathEnv): string {
  return env.packaged
    ? path.join(env.resourcesPath, "python", "bin", "python3")
    : path.join(env.repoRoot, "backend", ".venv", "bin", "python");
}

/** The working directory uvicorn runs in -- it imports `main:app` from there. */
export function backendCwd(env: PathEnv): string {
  return env.packaged
    ? path.join(env.resourcesPath, "backend")
    : path.join(env.repoRoot, "backend");
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --prefix desktop test`
Expected: PASS, 61 tests (56 + 5).

- [ ] **Step 5: Use it in the spawn**

In `desktop/main/servers.ts`, import it and replace the hard-coded interpreter and cwd used when spawning the backend:

```ts
import { backendCwd, pythonPath, type PathEnv } from "../lib/paths.ts";
```

Add a helper beside `repoRoot()`:

```ts
/** The real Electron values, gathered in one place so lib/paths.ts stays
 *  pure and testable. */
function pathEnv(): PathEnv {
  return {
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: repoRoot(),
  };
}
```

Then use `pythonPath(pathEnv())` and `backendCwd(pathEnv())` where the backend child is spawned. Read the existing spawn call first and change only the interpreter path and `cwd` — the argv (`-m uvicorn main:app --port … --log-level info --timeout-graceful-shutdown 3`) and the env stay exactly as they are. Import `app` from `electron` if that file does not already.

- [ ] **Step 6: Write the bundle config**

Create `desktop/electron-builder.yml`:

```yaml
# Unsigned, deliberately. Spike R1 measured that an unsigned packaged app CAN
# use the microphone -- NSMicrophoneUsageDescription reaches Info.plist, the
# TCC prompt appears, and getUserMedia succeeds with a real device, WebRTC
# transport included. What it cannot do is keep the grant across a rebuild, so
# expect a re-prompt on every packaged build during development. Signing is
# deferred, not cancelled: a Developer ID gives TCC a durable identity and is
# the fix if that friction becomes annoying.
appId: com.yuri.app
productName: Yuri OS
copyright: Yuri OS

directories:
  output: dist
  buildResources: assets

# The asar carries only what runs. Source, tests and the payload build tree
# are excluded -- the payload arrives via extraResources instead, unpacked,
# because an interpreter cannot execute from inside an asar.
files:
  - out/**/*
  - package.json
  - "!**/*.ts"
  - "!**/*.map"
  - "!build/**"
  - "!dist/**"

extraResources:
  # Built by desktop/scripts/build-python.py. Trimmed and size-gated by
  # backend/yuri/payload.py.
  - from: build/python
    to: python
  # The backend itself, minus its dev venv (the bundled interpreter above
  # replaces it) and everything that is not runtime code.
  - from: ../backend
    to: backend
    filter:
      - "**/*"
      - "!.venv/**"
      - "!tests/**"
      - "!**/__pycache__/**"
      - "!.env"
  # The built frontend, which `next start` serves.
  - from: ../frontend/.next
    to: frontend/.next
  - from: ../frontend/public
    to: frontend/public

mac:
  category: public.app-category.productivity
  target:
    - target: dmg
      arch: [arm64]
  # No signing identity, and the hardened runtime off with it: hardenedRuntime
  # without a signature produces a bundle macOS refuses to launch.
  identity: null
  hardenedRuntime: false
  extendInfo:
    # Without this the TCC prompt never appears and getUserMedia fails with
    # no diagnosis. R1 verified this is the mechanism.
    NSMicrophoneUsageDescription: >-
      Yuri listens when you talk to her. Audio goes to the voice model you
      configured and is not recorded to disk.
    # She keeps running in the menu bar with no window open.
    LSUIElement: false

dmg:
  title: Yuri OS
```

- [ ] **Step 7: Add the build scripts**

In `desktop/package.json`, add `electron-builder` to `devDependencies` **pinned exactly** (no `^`), and add two scripts beside the existing ones:

```json
    "payload": "python3 ../desktop/scripts/build-python.py",
    "dist": "npm run build && npx electron-builder --config electron-builder.yml"
```

Install it:

```bash
npm --prefix desktop install --save-dev --save-exact electron-builder
```

- [ ] **Step 8: Build the frontend, the payload, and the app**

```bash
cd /Users/ankur/Projects/yuri-code/frontend && npx next build
cd /Users/ankur/Projects/yuri-code && python3 desktop/scripts/build-python.py
npm --prefix desktop run dist 2>&1 | tail -20
```

Expected: `desktop/dist/Yuri OS-0.1.0-arm64.dmg` exists. Report its size.

- [ ] **Step 9: Verify the bundle has what it needs, before launching it**

```bash
APP="desktop/dist/mac-arm64/Yuri OS.app"
ls "$APP/Contents/Resources/python/bin/python3"
ls "$APP/Contents/Resources/backend/main.py"
ls "$APP/Contents/Resources/frontend/.next/BUILD_ID"
/usr/libexec/PlistBuddy -c "Print :NSMicrophoneUsageDescription" "$APP/Contents/Info.plist"
test -d "$APP/Contents/Resources/backend/.venv" && echo "BUG: dev venv was bundled" || echo "ok: no dev venv"
```

Expected: all four present, the usage description printed, and no `.venv`.

- [ ] **Step 10: Launch the packaged app and confirm it boots**

```bash
open "desktop/dist/mac-arm64/Yuri OS.app"
```

Expected: the boot splash appears — her orb, "YURI", and the Environment · Interface · Backend checklist — and then the app. Note that this uses the DEFAULT ports 8000/3000, which belong to the user's live workflow: **confirm nothing of theirs is running on those ports before you do this**, and quit the app from the tray when finished. If they are in use the app will refuse with a port message, which is correct behaviour, not a failure of this task.

Verify from evidence, not from the window appearing: confirm the backend process running is the **bundled** interpreter, not the repo venv:

```bash
ps -Ao pid,command | grep -i "uvicorn main:app" | grep -v grep
```

Expected: the command names a path inside `Yuri OS.app/Contents/Resources/python`. If it names `backend/.venv`, `pythonPath` is taking the dev branch in a packaged app and the bundling is not real.

- [ ] **Step 11: Commit**

```bash
git add desktop/lib/paths.ts desktop/lib/paths.test.ts desktop/electron-builder.yml desktop/package.json desktop/package-lock.json desktop/main/servers.ts
git commit -m "feat(desktop): package an unsigned Yuri OS.app with its own Python"
```

---

### Task 4: Say so when the microphone is denied

Spec R1 consequence 3: a silently-denied microphone is indistinguishable from voice being broken, which is exactly the failure `docs/yuri/design/GUIDE.md` exists to prevent. The boot checklist built in 2a is the place for it.

The row appears **only when there is something to say** — a granted microphone gets no row, because a checklist entry that is always green is furniture. `not-determined` gets no row either: the TCC prompt appears on first `getUserMedia` and pre-announcing it adds nothing.

**Files:**
- Create: `desktop/lib/mic.ts`
- Create: `desktop/lib/mic.test.ts`
- Modify: `desktop/main/index.ts`
- Modify: `desktop/preload/index.ts`
- Modify: `frontend/lib/bootRows.ts`
- Modify: `frontend/lib/bootRows.test.ts`
- Modify: `frontend/components/BootSplash.tsx`

**Interfaces:**
- Consumes: `frontend/lib/bootRows.ts`'s `bootRows(s, elapsedMs)` and `YuriBootState` from 2a; `BootRow = { key, label, state, note }` with `state: "starting" | "ready" | "failed"`.
- Produces: `desktop/lib/mic.ts` with `type MicStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown"`, `MIC_SETTINGS_URL`, `normalizeMicStatus(raw: string): MicStatus`, `micNeedsSaying(s: MicStatus): boolean`. `YuriBootState` gains `mic: MicStatus`.

- [ ] **Step 1: Write the failing desktop test**

Create `desktop/lib/mic.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { MIC_SETTINGS_URL, micNeedsSaying, normalizeMicStatus } from "./mic.ts";

test("Electron's four statuses pass through", () => {
  for (const s of ["not-determined", "granted", "denied", "restricted"]) {
    assert.equal(normalizeMicStatus(s), s);
  }
});

test("anything else is unknown, not a crash and not a silent 'granted'", () => {
  // getMediaAccessStatus is documented for macOS and Windows; a future value
  // or another platform must not be read as permission we do not have.
  for (const s of ["", "GRANTED", "yes", "undefined"]) {
    assert.equal(normalizeMicStatus(s), "unknown", s);
  }
});

test("only denied and restricted are worth a row", () => {
  // Granted needs no row: an always-green checklist entry is furniture.
  // not-determined needs none either: the TCC prompt appears on the first
  // getUserMedia, and pre-announcing it tells the reader nothing to act on.
  assert.equal(micNeedsSaying("denied"), true);
  assert.equal(micNeedsSaying("restricted"), true);
  assert.equal(micNeedsSaying("granted"), false);
  assert.equal(micNeedsSaying("not-determined"), false);
  assert.equal(micNeedsSaying("unknown"), false);
});

test("the settings URL opens the microphone pane specifically", () => {
  assert.equal(MIC_SETTINGS_URL,
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix desktop test`
Expected: FAIL — cannot find module `./mic.ts`

- [ ] **Step 3: Write it**

Create `desktop/lib/mic.ts`:

```ts
// Microphone permission, as something the UI can say out loud.
//
// Spike R1 measured that an unsigned packaged app can use the microphone --
// but also that a grant does NOT survive a rebuild, so during development
// every packaged build starts at "not-determined" again. That makes "voice
// stopped working" a frequent, expected event with an unhelpful default
// symptom: nothing at all. Hence this.

/** Electron's `systemPreferences.getMediaAccessStatus("microphone")` values,
 *  plus `unknown` for anything we do not recognise. */
export type MicStatus =
  | "not-determined" | "granted" | "denied" | "restricted" | "unknown";

/** Opens System Settings at Privacy & Security -> Microphone. */
export const MIC_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

const KNOWN: MicStatus[] = ["not-determined", "granted", "denied", "restricted"];

/** Anything unrecognised becomes `unknown` rather than being trusted. Reading
 *  an unexpected value as "granted" would hide the exact condition this
 *  module exists to surface. */
export function normalizeMicStatus(raw: string): MicStatus {
  return (KNOWN as string[]).includes(raw) ? (raw as MicStatus) : "unknown";
}

/** Whether the boot checklist should carry a microphone row at all.
 *
 *  Only the two states the reader can act on. `granted` is silent because an
 *  always-green row is furniture; `not-determined` is silent because the TCC
 *  prompt arrives on the first getUserMedia and announcing it in advance
 *  gives the reader nothing to do. */
export function micNeedsSaying(s: MicStatus): boolean {
  return s === "denied" || s === "restricted";
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --prefix desktop test`
Expected: PASS, 65 tests (61 + 4).

- [ ] **Step 5: Report the status from main**

In `desktop/main/index.ts`:

Import it — `import { normalizeMicStatus, MIC_SETTINGS_URL, type MicStatus } from "../lib/mic.ts";` — and `systemPreferences` from `electron`.

Add a reader beside `pushBoot`:

```ts
/** The current TCC status. Read fresh each time rather than cached: the user
 *  can change it in System Settings while the app is running, and a cached
 *  "denied" would keep saying so after they fixed it. */
function micStatus(): MicStatus {
  if (process.platform !== "darwin") return "unknown";
  return normalizeMicStatus(systemPreferences.getMediaAccessStatus("microphone"));
}
```

Include it in the `lastBoot` payload built in `pushBoot`, as a `mic` field, alongside `env`/`backend`/`frontend`.

Add an IPC handler **above `await runBootCycle`**, with the other registrations (2a's Ruling 13 — every handler is registered before the boot, never after):

```ts
  // Re-read on request, so the splash can refresh after the user visits
  // System Settings without restarting the app.
  ipcMain.handle("mic:status", () => micStatus());

  ipcMain.on("mic:settings", () => {
    void shell.openExternal(MIC_SETTINGS_URL);
  });
```

`mic:settings` is the one place a non-`http(s)` scheme is opened deliberately. The `externalOpenScheme` guard added in 2a rejects it, so call `shell.openExternal` directly here with a comment saying why this single constant is exempt — it is a compile-time constant in this repo, not a URL from any page.

- [ ] **Step 6: Expose it in the preload**

In `desktop/preload/index.ts`, add to the `yuriBoot` bridge:

```ts
  micStatus: () => ipcRenderer.invoke("mic:status"),
  openMicSettings: () => ipcRenderer.send("mic:settings"),
```

- [ ] **Step 7: Write the failing frontend test**

Append to `frontend/lib/bootRows.test.ts`:

```ts
test("a denied microphone gets a failed row, after the others", () => {
  // Last, because it is a warning about something that will not work rather
  // than a step of the boot -- and the boot rows are in boot order.
  const rows = bootRows(state({ mic: "denied" }), 0);
  const last = rows[rows.length - 1];
  assert.equal(last.key, "mic");
  assert.equal(last.label, "Microphone");
  assert.equal(last.state, "failed");
});

test("a working microphone gets no row at all", () => {
  // An always-green row is furniture; the checklist is for what needs saying.
  for (const mic of ["granted", "not-determined", "unknown"] as const) {
    const keys = bootRows(state({ mic }), 0).map((r) => r.key);
    assert.ok(!keys.includes("mic"), `${mic} should be silent`);
    assert.equal(keys.length, 3, `${mic} should leave the three boot rows alone`);
  }
});

test("restricted says so too — it is not the same as granted", () => {
  assert.equal(bootRows(state({ mic: "restricted" }), 0).length, 4);
});

test("the elapsed counter never lands on the microphone row", () => {
  // The counter marks the first STILL-STARTING row; the mic row is failed, so
  // it must not absorb the count and leave the real one unmarked.
  const rows = bootRows(state({ mic: "denied", backend: "starting" }), 9000);
  assert.equal(rows.find((r) => r.key === "backend")?.note, "9s");
  assert.equal(rows.find((r) => r.key === "mic")?.note, "");
});
```

Update the file's `state()` helper to include `mic: "granted"` in its defaults, so existing tests keep their meaning.

- [ ] **Step 8: Run it to verify it fails**

Run: `cd frontend && node --test lib/bootRows.test.ts`
Expected: FAIL — the mic row is absent.

- [ ] **Step 9: Add the row**

In `frontend/lib/bootRows.ts`:

Add `mic: MicStatus` to `YuriBootState`, and declare the type locally rather than importing across the process boundary (`desktop/lib` is not reachable from a `next build` — the same constraint that keeps the tray rule duplicated, see `docs/yuri/desktop-shell.md`):

```ts
/** Mirrors desktop/lib/mic.ts's MicStatus. Declared again rather than
 *  imported: desktop/ is outside the frontend's build graph, and importing
 *  across would break `next build`. Only the two actionable values are read
 *  here, so a drift in the others cannot change what this renders. */
export type MicStatus =
  | "not-determined" | "granted" | "denied" | "restricted" | "unknown";
```

Then extend `bootRows` to append the row after the three boot rows and after the counter has been assigned, so it cannot absorb the count:

```ts
export function bootRows(
  s: YuriBootState | null | undefined,
  elapsedMs: number,
): BootRow[] {
  if (!s) return [];
  let noted = false;
  const rows = ROWS.map(({ key, label }) => {
    const state = s[key];
    const wants = state === "starting" && !noted && elapsedMs >= 1000;
    if (wants) noted = true;
    return { key, label, state, note: wants ? `${Math.floor(elapsedMs / 1000)}s` : "" };
  });

  // Appended last, and outside the counter loop above on purpose: it is a
  // warning about something that will not work, not a step of the boot, and
  // a `failed` row must never absorb the elapsed counter from the row that
  // is actually still starting.
  //
  // Silent when granted (an always-green row is furniture) and when
  // not-determined (the TCC prompt arrives on the first getUserMedia, so
  // there is nothing to act on yet).
  if (s.mic === "denied" || s.mic === "restricted") {
    rows.push({ key: "mic", label: "Microphone", state: "failed", note: "" });
  }
  return rows;
}
```

Widen `BootRow["key"]` to include `"mic"`.

- [ ] **Step 10: Run it to verify it passes**

Run: `cd frontend && node --test lib/*.test.ts`
Expected: PASS — 373 + 4 = 377 tests.

- [ ] **Step 11: Say what to do about it**

In `frontend/components/BootSplash.tsx`, render a line under the checklist when a mic row is present, with a button that opens System Settings. The button only exists inside Electron (GUIDE.md: a control that cannot work is not rendered), so gate it on the bridge exactly as the existing Retry/Quit buttons are:

```tsx
{rows.some((r) => r.key === "mic") ? (
  <div className="boot-mic">
    She cannot hear you until macOS lets her.
    {onMicSettings ? (
      <button className="txtoggle" onClick={onMicSettings}>Open Settings</button>
    ) : null}
  </div>
) : null}
```

Add `onMicSettings?: () => void` to the component's props, pass it from `SetupGate` as `bridge && (() => bridge.openMicSettings())` following the existing `onRetry`/`onQuit` pattern, and add a `.boot-mic` rule to `frontend/app/globals.css` using existing tokens — `var(--mono)`, `var(--danger)` for the text, laid out with `display: flex; gap: 8px; align-items: center; flex-shrink: 0;`. Give it `flex-shrink: 0` for the reason recorded in `docs/yuri/desktop-shell.md`: the splash column overflows by a few pixels and flex shrinks whatever has no intrinsic height.

- [ ] **Step 12: Verify it against a real denied microphone**

Build and package (Task 3's Step 8), launch the app, grant nothing, then deny the microphone in System Settings → Privacy & Security → Microphone. Relaunch and probe the DOM with the throwaway-Electron-entry pattern from `docs/yuri/desktop-shell.md`:

```
[...document.querySelectorAll('.boot-rows li')].map(li => [
  li.querySelector('.boot-rlabel').textContent, li.dataset.state])
```

Expected: a fourth entry `["Microphone", "failed"]`, and `.boot-mic` present. Then re-grant it, relaunch, and confirm the row is **gone** — a row that never disappears is the same bug as one that never appears. Report both observations.

- [ ] **Step 13: Commit**

```bash
git add desktop/lib/mic.ts desktop/lib/mic.test.ts desktop/main/index.ts desktop/preload/index.ts frontend/lib/bootRows.ts frontend/lib/bootRows.test.ts frontend/components/BootSplash.tsx frontend/components/SetupGate.tsx frontend/app/globals.css
git commit -m "feat(desktop): say plainly when macOS has denied the microphone"
```

---

### Task 5: API keys in the Keychain, not in a dotfile

Today the Setup UI sends keys over HTTP to `PUT /yuri/config`, and the backend writes them to `~/Yuri/config/.env` at mode 0600 (`backend/yuri/setup_store.py`). Spec §6.3: use Electron `safeStorage`, which encrypts against the macOS Keychain; ciphertext at `~/Library/Application Support/Yuri OS/credentials.enc`; **plaintext never touches disk**; writing goes renderer → IPC → main → `safeStorage`, so **secrets never transit HTTP, not even on loopback**; main decrypts at startup and passes the values to both children as environment variables.

The `.env` path stays as the fallback for the browser, where there is no `safeStorage`. Because main passes credentials as real environment variables, they already outrank every file in `config.py`'s precedence chain (real env > `$YAPCODE_CONFIG_DIR/.env` > `$YURI_HOME/config/.env` > `backend/.env`) — so no backend precedence change is needed, and a stale `.env` cannot shadow a Keychain value.

**Files:**
- Create: `desktop/lib/credentials.ts`
- Create: `desktop/lib/credentials.test.ts`
- Create: `desktop/main/credentials.ts`
- Modify: `desktop/main/index.ts`
- Modify: `desktop/main/servers.ts`
- Modify: `desktop/preload/index.ts`
- Modify: `frontend/components/SetupPanel.tsx`

**Interfaces:**
- Consumes: `backend/config.py`'s `MANAGED_KEYS`, whose `secret: bool` field names which keys belong here.
- Produces: `desktop/lib/credentials.ts` with `type CredentialBlob = { version: 1; values: Record<string, string> }`, `serializeCredentials(values: Record<string, string>): string`, `parseCredentials(raw: string): Record<string, string>`, `SECRET_KEYS: readonly string[]`, `isSecretKey(name: string): boolean`. Task 6 does not depend on it.

- [ ] **Step 1: Write the failing test**

Create `desktop/lib/credentials.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  isSecretKey, parseCredentials, serializeCredentials, SECRET_KEYS,
} from "./credentials.ts";

test("a round trip preserves every value", () => {
  const values = { GEMINI_API_KEY: "g-1", ANTHROPIC_AUTH_TOKEN: "a-2" };
  assert.deepEqual(parseCredentials(serializeCredentials(values)), values);
});

test("values containing newlines and quotes survive", () => {
  // The reason this is JSON and not dotenv: a token with a newline in it
  // silently truncates a KEY=VALUE file, and one with a quote corrupts it.
  const values = { ANTHROPIC_AUTH_TOKEN: 'a\n"b"\nc', GEMINI_API_KEY: "x=y#z" };
  assert.deepEqual(parseCredentials(serializeCredentials(values)), values);
});

test("unreadable ciphertext yields no credentials rather than throwing", () => {
  // A corrupt or truncated file must degrade to "no keys set", which Setup
  // already handles, not crash the main process before a window exists.
  for (const raw of ["", "not json", "{}", '{"version":1}', "null", "[]"]) {
    assert.deepEqual(parseCredentials(raw), {}, raw);
  }
});

test("a future version is not guessed at", () => {
  assert.deepEqual(parseCredentials('{"version":2,"values":{"A":"b"}}'), {});
});

test("non-string values are dropped, not coerced", () => {
  assert.deepEqual(
    parseCredentials('{"version":1,"values":{"A":"b","B":7,"C":null,"D":{}}}'),
    { A: "b" });
});

test("the secret set matches config.py's MANAGED_KEYS with secret=True", () => {
  // Kept in step by hand across a process boundary; this test is the record
  // of what it must match. backend/config.py is the source of truth.
  assert.deepEqual([...SECRET_KEYS].sort(), [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GEMINI_API_KEY", "OPENAI_API_KEY",
  ]);
});

test("only secret keys are accepted for encryption", () => {
  assert.equal(isSecretKey("GEMINI_API_KEY"), true);
  // Non-secrets belong in the .env file, not the Keychain: they are paths and
  // ports a user may reasonably want to read and edit in a text editor.
  assert.equal(isSecretKey("YURI_HOME"), false);
  assert.equal(isSecretKey("ALLOWED_PROJECT_ROOTS"), false);
  assert.equal(isSecretKey(""), false);
});
```

- [ ] **Step 2: Confirm the secret set before running anything**

```bash
cd backend && .venv/bin/python -c "
import config
print(sorted(k.name for k in config.MANAGED_KEYS if k.secret))"
```

If the printed list differs from the four names in the test above, **use the printed list** — `config.py` is the source of truth — and update both the test and `SECRET_KEYS` to match it.

- [ ] **Step 3: Run it to verify it fails**

Run: `npm --prefix desktop test`
Expected: FAIL — cannot find module `./credentials.ts`

- [ ] **Step 4: Write it**

Create `desktop/lib/credentials.ts`:

```ts
// The shape of the encrypted credential blob, and which keys belong in it.
//
// Pure: no safeStorage, no filesystem, so `node --test` reaches it.
// main/credentials.ts does the encrypting.
//
// JSON rather than dotenv, deliberately. A token containing a newline
// truncates a KEY=VALUE file and one containing a quote corrupts it, and
// these values are opaque strings from four different providers -- assuming
// anything about their characters is how a credential store loses a
// credential.

export type CredentialBlob = { version: 1; values: Record<string, string> };

/** Mirrors `backend/config.py`'s MANAGED_KEYS entries with `secret=True`.
 *  Held by hand: the two live in different languages in different processes.
 *  credentials.test.ts pins this list, and that test is the record of what it
 *  must match -- config.py is the source of truth. */
export const SECRET_KEYS: readonly string[] = [
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
];

/** Whether a key belongs in the Keychain. Non-secrets (paths, ports, roots)
 *  stay in the .env file: a user may reasonably want to read and edit those
 *  in a text editor, and encrypting them would only make that harder. */
export function isSecretKey(name: string): boolean {
  return SECRET_KEYS.includes(name);
}

export function serializeCredentials(values: Record<string, string>): string {
  const blob: CredentialBlob = { version: 1, values };
  return JSON.stringify(blob);
}

/** Credentials from a blob, or `{}` for anything unreadable.
 *
 *  Never throws. This is called before the window exists, and a corrupt or
 *  truncated file must degrade to "no keys set" -- a state Setup already
 *  renders -- rather than take down the main process with no UI to say why.
 *  A version we do not know is treated as unreadable rather than guessed at. */
export function parseCredentials(raw: string): Record<string, string> {
  let blob: unknown;
  try {
    blob = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof blob !== "object" || blob === null) return {};
  const b = blob as Partial<CredentialBlob>;
  if (b.version !== 1 || typeof b.values !== "object" || b.values === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.values)) {
    // Dropped, not coerced: String(null) is "null", which would be stored and
    // sent to a provider as a literal credential.
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npm --prefix desktop test`
Expected: PASS, 72 tests (65 + 7).

- [ ] **Step 6: Write the main-process store**

Create `desktop/main/credentials.ts`:

```ts
// safeStorage-backed credential storage.
//
// Spec 6.3: ciphertext in the app's own Application Support directory,
// plaintext never on disk, and the values handed to the children as
// environment variables -- which also means they outrank every file in
// backend/config.py's precedence chain (real env beats every .env), so a
// stale dotfile cannot shadow a Keychain value.
//
// Nothing here logs a value. Key NAMES and counts only.
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

import {
  isSecretKey, parseCredentials, serializeCredentials,
} from "../lib/credentials.ts";

function storePath(): string {
  return path.join(app.getPath("userData"), "credentials.enc");
}

/** Whether the Keychain is actually available. False on a machine where
 *  safeStorage cannot reach a keyring, in which case the .env path remains
 *  the only store and Setup must keep working through it. */
export function credentialsAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

/** Every stored credential, or {} if there is no store, it is unreadable, or
 *  encryption is unavailable. Never throws: this runs before any window
 *  exists. */
export function readCredentials(): Record<string, string> {
  if (!credentialsAvailable()) return {};
  const p = storePath();
  let cipher: Buffer;
  try {
    cipher = fs.readFileSync(p);
  } catch {
    return {};   // no store yet is the normal first-run case
  }
  try {
    return parseCredentials(safeStorage.decryptString(cipher));
  } catch (err) {
    // A store we cannot decrypt (a different machine, a reset Keychain) is
    // reported by name and count only.
    console.error("[yuri] credentials.enc could not be decrypted:",
                  err instanceof Error ? err.message : "unknown error");
    return {};
  }
}

/** Merge `updates` into the store. An empty-string value REMOVES a key --
 *  Setup's way of clearing one -- so writing "" cannot store an empty
 *  credential that then masks a real one from the environment. */
export function writeCredentials(updates: Record<string, string>): { written: string[] } {
  if (!credentialsAvailable()) {
    throw new Error("the system keychain is unavailable");
  }
  const current = readCredentials();
  const written: string[] = [];
  for (const [k, v] of Object.entries(updates)) {
    // Refused rather than silently dropped: a caller trying to store a
    // non-secret here has made a mistake worth surfacing.
    if (!isSecretKey(k)) throw new Error(`${k} is not a credential`);
    if (v === "") delete current[k];
    else current[k] = v;
    written.push(k);
  }
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), safeStorage.encryptString(serializeCredentials(current)),
                   { mode: 0o600 });
  console.log(`[yuri] credentials updated: ${written.join(", ") || "none"}`);
  return { written };
}
```

- [ ] **Step 7: Hand them to the children, and expose the write**

In `desktop/main/servers.ts`, merge the credentials into the environment each child is spawned with. Read the existing env construction first — 2a's `mergeEnv` and `agent_child_env` already establish the shape — and add the credentials **last**, so they win:

```ts
import { readCredentials } from "./credentials.ts";
```

In `desktop/main/index.ts`, register **above `await runBootCycle`** with the other handlers:

```ts
  // Secrets go renderer -> IPC -> main -> safeStorage and never over HTTP,
  // not even on loopback (spec 6.3). The reply carries key NAMES only.
  ipcMain.handle("credentials:write", (_e, updates: Record<string, string>) => {
    try {
      return { ok: true, ...writeCredentials(updates) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "write failed" };
    }
  });

  // Which keys are stored -- never their values. Setup shows a masked hint
  // built from this plus what the backend reports.
  ipcMain.handle("credentials:names", () => Object.keys(readCredentials()));
```

In `desktop/preload/index.ts`, add to the bridge:

```ts
contextBridge.exposeInMainWorld("yuriCredentials", {
  write: (updates: Record<string, string>) =>
    ipcRenderer.invoke("credentials:write", updates),
  names: () => ipcRenderer.invoke("credentials:names"),
});
```

- [ ] **Step 8: Use it from Setup when it exists**

In `frontend/components/SetupPanel.tsx`, route **secret** keys through the bridge when it is present and fall back to the existing `PUT /yuri/config` otherwise. Read the component's current save path first and keep its error rendering; the change is which transport carries the secret values, not how failures are shown.

The bridge is absent in a browser tab, so that path must keep working unchanged — this is a second transport, not a replacement. Non-secret keys continue over HTTP in both cases.

- [ ] **Step 9: Verify plaintext really never reaches disk**

Package and launch (Task 3, Steps 8 and 10). In Setup, save a **distinctive throwaway value** you can search for — use the literal `yuri-plaintext-canary-9713`, not a real key. Then:

```bash
CANARY=yuri-plaintext-canary-9713
S="$HOME/Library/Application Support/Yuri OS"
ls -l "$S/credentials.enc"
grep -c "$CANARY" "$S/credentials.enc" && echo "FAIL: plaintext in the store" || echo "ok: not plaintext"
grep -rl "$CANARY" "$HOME/Yuri" 2>/dev/null && echo "FAIL: written to a dotfile" || echo "ok: no dotfile copy"
stat -f "%Sp" "$S/credentials.enc"
```

Expected: the file exists, the canary is **absent** from it, no file under `~/Yuri` contains it, and the mode is `-rw-------`. Then confirm the child actually received it:

```bash
ps -Ao pid,command | grep "uvicorn main:app" | grep -v grep | awk '{print $1}' \
  | xargs -I{} sh -c 'ps eww {} | tr " " "\n" | grep -c "^GEMINI_API_KEY="'
```

Expected: `1` — the key reached the backend's environment. **Do not print the value**; the count is the evidence. Finally, clear the canary in Setup and confirm the key is gone from `credentials:names`.

- [ ] **Step 10: Run every suite**

```bash
npm --prefix desktop test
cd frontend && node --test lib/*.test.ts
cd ../backend && .venv/bin/python -m unittest discover -s tests -q
```

Expected: 72, 377, 1665 — all passing.

- [ ] **Step 11: Commit**

```bash
git add desktop/lib/credentials.ts desktop/lib/credentials.test.ts desktop/main/credentials.ts desktop/main/index.ts desktop/main/servers.ts desktop/preload/index.ts frontend/components/SetupPanel.tsx
git commit -m "feat(desktop): keep API keys in the Keychain, never on disk or over HTTP"
```

---

### Task 6: Offer to restart the backend, and say what that costs

Spec §6.4: some settings are frozen into module constants at import, so they need a restart. "The settings UI must label the third group as needing a restart and offer to do it — the desktop app can restart its own backend cleanly because it owns the child, which the browser version never could. **It must refuse to restart while a mission is running, or say what it will interrupt.**"

`frontend/lib/setup.ts` already has `Effect = "now" | "next-session" | "restart"` and the label "needs Yuri to restart", so the labelling exists; this adds the offer. 2a's whole-branch review also confirmed a child that crashes *after* boot is reported and nothing acts — the same button covers that.

**Files:**
- Create: `frontend/lib/restart.ts`
- Create: `frontend/lib/restart.test.ts`
- Modify: `desktop/main/index.ts`
- Modify: `desktop/preload/index.ts`
- Modify: `frontend/components/SetupPanel.tsx`

**Interfaces:**
- Consumes: `runBootCycle(drainFirst: boolean)` in `desktop/main/index.ts` (2a); `useYuri()`'s `missions` and `sessions` in the frontend.
- Produces: `frontend/lib/restart.ts` with `type RestartImpact = { safe: boolean; warning: string }` and `restartImpact(runningMissions: number, liveSessions: number): RestartImpact`.

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/restart.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { restartImpact } from "./restart.ts";

test("nothing running: safe, and no warning to show", () => {
  const r = restartImpact(0, 0);
  assert.equal(r.safe, true);
  assert.equal(r.warning, "");
});

test("a running mission is named and blocks the restart", () => {
  // The spec's requirement: refuse while a mission is running, or say what it
  // will interrupt. A mission is work she is doing unattended, so it is
  // refused rather than merely warned about.
  const r = restartImpact(1, 0);
  assert.equal(r.safe, false);
  assert.match(r.warning, /1 mission/);
});

test("several missions are counted, not pluralised wrongly", () => {
  assert.match(restartImpact(3, 0).warning, /3 missions/);
  assert.match(restartImpact(1, 0).warning, /1 mission\b/);
});

test("live sessions warn but do not block", () => {
  // A session is attended -- someone is sitting there and can decide. It must
  // still be named, because a restart drops it.
  const r = restartImpact(0, 2);
  assert.equal(r.safe, true);
  assert.match(r.warning, /2 sessions/);
});

test("both: the mission's refusal wins and both are named", () => {
  const r = restartImpact(2, 1);
  assert.equal(r.safe, false);
  assert.match(r.warning, /2 missions/);
  assert.match(r.warning, /1 session\b/);
});

test("negative or nonsense counts are treated as none, not as a refusal", () => {
  // A count arriving as -1 from a failed fetch must not permanently disable
  // the button with a warning about minus one mission.
  const r = restartImpact(-1, -5);
  assert.equal(r.safe, true);
  assert.equal(r.warning, "");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && node --test lib/restart.test.ts`
Expected: FAIL — cannot find module `./restart.ts`

- [ ] **Step 3: Write it**

Create `frontend/lib/restart.ts`:

```ts
// Whether the backend can be restarted right now, and what it would cost.
//
// Spec 6.4 requires the settings UI to refuse a restart while a mission is
// running, or say what it will interrupt. The distinction this draws:
//
//   a MISSION is unattended work -- she is doing it while nobody watches, so
//   killing it loses progress nobody chose to lose. Refused.
//   a SESSION is attended -- someone is there and can judge. Warned, allowed.
//
// Pure so `node --test` reaches it: there is no DOM test environment.

export type RestartImpact = {
  /** Whether the restart may proceed. */
  safe: boolean;
  /** What it would interrupt, or "" when there is nothing to say. */
  warning: string;
};

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

export function restartImpact(runningMissions: number, liveSessions: number): RestartImpact {
  // Clamped, not trusted: a count arriving as -1 from a failed fetch must not
  // disable the button forever with a warning about minus one mission.
  const missions = Number.isFinite(runningMissions) ? Math.max(0, Math.trunc(runningMissions)) : 0;
  const sessions = Number.isFinite(liveSessions) ? Math.max(0, Math.trunc(liveSessions)) : 0;

  const parts: string[] = [];
  if (missions > 0) parts.push(plural(missions, "mission"));
  if (sessions > 0) parts.push(plural(sessions, "session"));
  if (parts.length === 0) return { safe: true, warning: "" };

  return {
    safe: missions === 0,
    warning: `Restarting stops ${parts.join(" and ")}.`,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && node --test lib/restart.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire the restart in main**

In `desktop/main/index.ts`, register **above `await runBootCycle`** with the other handlers:

```ts
  // The restart the browser version could never offer: the desktop app owns
  // the child, so it can drain it and bring it back cleanly. drainFirst is
  // true -- this is exactly the retry path, and runBootCycle's `booting`
  // guard is what stops two cycles overlapping.
  //
  // Whether it SHOULD restart is the renderer's decision
  // (frontend/lib/restart.ts): only it knows what is running.
  ipcMain.handle("backend:restart", async () => {
    try {
      await runBootCycle(true);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "restart failed" };
    }
  });
```

In `desktop/preload/index.ts`, add to the `yuriBoot` bridge:

```ts
  restartBackend: () => ipcRenderer.invoke("backend:restart"),
```

- [ ] **Step 6: Offer it in Setup**

In `frontend/components/SetupPanel.tsx`, when a saved key's effect is `"restart"`, show the offer using `restartImpact`. The button is rendered only inside Electron — a browser tab cannot restart anything, and GUIDE.md says a control that cannot work is not rendered. Get the counts from `useYuri()`'s `missions` and `sessions`, counting only those actually running, matching how `frontend/lib/trayState.ts` counts them.

```tsx
const impact = restartImpact(runningMissions, liveSessions);
// ...
{needsRestart && bridge ? (
  <div className="setup-restart">
    <div className="mcp-blurb">{impact.warning || "Nothing is running."}</div>
    <button className="txtoggle primary" disabled={!impact.safe} onClick={doRestart}>
      Restart Yuri's backend
    </button>
  </div>
) : null}
```

A disabled button with the warning beside it is the honest rendering of "refuse, and say what it would interrupt": the reason is visible rather than the control merely being dead. While the restart is in flight, show that it is happening and disable the button — the backend is unreachable for several seconds and a second click would be a second cycle `booting` silently swallows.

Add a `.setup-restart` rule to `frontend/app/globals.css` using existing tokens.

- [ ] **Step 7: Verify all three behaviours**

Package and launch (Task 3, Steps 8 and 10).

1. **With nothing running:** change `YURI_HOME` in Setup, confirm the offer appears, click it, and confirm the backend comes back — the splash reappears with the checklist and then the app returns. Confirm the new value took effect (`GET /yuri/config` shows the new `YURI_HOME`), which is the whole point of the restart.
2. **With a session live:** start one, then confirm the warning names it and the button is still enabled.
3. **With a mission running:** start one, then confirm the button is **disabled** and the warning names the mission.

Then confirm no process leaked, which is the failure 2a's review found on this exact path:

```bash
ps -Ao pid,ppid,command | grep -E "uvicorn main:app|next-server" | grep -v grep
```

Expected: exactly one of each, both parented to the app — not two, and none with PPID 1.

- [ ] **Step 8: Run every suite**

```bash
npm --prefix desktop test
cd frontend && node --test lib/*.test.ts
cd ../backend && .venv/bin/python -m unittest discover -s tests -q
```

Expected: 72, 383, 1665 — all passing.

- [ ] **Step 9: Document the app for a reader who has only the .dmg**

Add to `README.md`, beside the `yuri app` section Task 6 of the previous plan added:

```markdown
### Installing the app

    cd frontend && npx next build
    python3 desktop/scripts/build-python.py
    npm --prefix desktop run dist

Puts `Yuri OS-0.1.0-arm64.dmg` in `desktop/dist/`. The app ships its own
Python, so it does not need this clone's `backend/.venv` — but it still needs
`claude` and `tmux` on your `PATH`, and it uses your own `claude`, not a
bundled copy, so both backends run the same version.

It is **unsigned**, so the first open needs right-click → Open rather than a
double-click. Two consequences worth knowing: macOS asks for the microphone
again after every rebuild (the grant is tied to the bundle, and an unsigned
one changes identity when it is replaced), and API keys you save in the app
go to your login Keychain rather than to a file.
```

- [ ] **Step 10: Commit**

```bash
git add frontend/lib/restart.ts frontend/lib/restart.test.ts desktop/main/index.ts desktop/preload/index.ts frontend/components/SetupPanel.tsx frontend/app/globals.css README.md
git commit -m "feat(desktop): offer to restart the backend, and say what that interrupts"
```

---

## Self-review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| §2.1 bundled Python, relocatable, native wheels (R2) | 2 |
| §2.1 the 355 MB problem; trimming as a required build step | 2 |
| §2.1 open question: can the bundled CLI go? | **1 — answered yes**, via `cli_path` (public API, `types.py:1702`), which also fixes the skew |
| §2.1 version skew between `cli` and `sdk` backends; surface path and version per backend | 1 |
| R1 `NSMicrophoneUsageDescription` via `mac.extendInfo`; unsigned; `hardenedRuntime: false` | 3 |
| R1 consequence 3: detect `denied` and say so, with the path to System Settings | 4 |
| §6.3 `safeStorage`, ciphertext in Application Support, plaintext never on disk, no HTTP | 5 |
| §6.3 main decrypts at startup and passes values to both children | 5 |
| §6.4 label restart-required settings and offer the restart | 6 |
| §6.4 refuse while a mission runs, or say what it interrupts | 6 |
| §11 signing and notarization deferred | Global constraint; unsigned throughout |

**Deliberately out of scope**, each with a reason: Intel/universal builds (R2 names it a separate later target); code signing and notarization (spec §11, and R1 makes it *indicated* rather than required — the app works unsigned); auto-update; Windows (spec §10 keeps the shape platform-agnostic but targets macOS first); auto-restarting a child that crashes *after* boot without asking (2a's review confirmed a silent restart loop is worse than a visibly dead server — Task 6 gives the user the button instead).

**Known gaps I am accepting**

- **`SECRET_KEYS` duplicates `config.py`'s `secret=True` set** across a language and process boundary, exactly as the tray rule does. Task 5 Step 2 makes the implementer read the real list before writing the test, and `credentials.test.ts` pins it — but nothing fails if `config.py` gains a fifth secret key. This is the same seam `docs/yuri/desktop-shell.md` documents for the tray; a new secret key needs both sides edited.
- **`MicStatus` is declared twice**, in `desktop/lib/mic.ts` and `frontend/lib/bootRows.ts`, because `desktop/` is outside the frontend's build graph. Only the two actionable values are read on the frontend side, so drift in the others cannot change what renders.
- **The payload is arm64-only.** An Intel Mac gets no usable build from this plan.
- **The size gate is a single number**, so a dependency bump that adds 15 MB passes silently until it accumulates. A per-directory budget would catch it earlier and is not worth the complexity yet.
- **Task 3 Step 10 and Tasks 4-6 verify against the default ports 8000/3000**, because a packaged app has no port override — its `BACKEND_URL` is baked into the bundled frontend build. This is the one place the plan cannot honour the scratch-port rule, so each such step says to confirm the user's own services are stopped first and to quit the app afterwards.

**Placeholder scan:** none. Every code step carries the code; every verification step carries the command and what to expect. The one deliberately deferred value — `MAX_PAYLOAD_BYTES` — is a placeholder replaced by a measurement in the same task (Task 2, Step 6), with explicit instructions on what to do if the measurement is implausible.

**Type consistency:** `PathEnv` (Task 3) is used only there. `MicStatus` (Task 4) is defined in `desktop/lib/mic.ts` and re-declared in `frontend/lib/bootRows.ts`, noted above. `BootRow["key"]` is widened in Task 4 to include `"mic"`; `YuriBootState` gains `mic` in the same task, and Task 4's Step 7 updates the existing test helper's defaults so earlier tests keep their meaning. `CredentialBlob`, `SECRET_KEYS`, `isSecretKey`, `serializeCredentials`, `parseCredentials` (Task 5) are consumed only by `desktop/main/credentials.ts`. `RestartImpact` and `restartImpact` (Task 6) are consumed only by `SetupPanel.tsx`. `runBootCycle(drainFirst: boolean)` is 2a's, called by Task 6 with `true`. `agent_cli.resolve/parse_version/version/describe` (Task 1) are consumed by `claude_runner.py` and `yuri/doctor.py`.
