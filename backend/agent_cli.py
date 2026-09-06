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
