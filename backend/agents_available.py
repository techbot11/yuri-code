"""Which coding agents this machine has, as data.

No agent is bundled with Yuri: `claude` and `opencode` are the user's own
installations, found on PATH. She connects to what is there and reports the
rest as OFFLINE -- that is why a missing agent is a status here rather than a
failed required check (see `yuri/doctor.py`'s `REQUIRED_CHECKS`, which this
task removes `claude` from: a machine with no Claude Code installed used to
get "Before Yuri can start" and no way in).

`build()` takes its inputs (what YURI_AGENTS enables, what was found on PATH,
and their versions) so the registry is testable without touching a real
filesystem. `statuses()` is the thin wrapper that reads the real world.
"""
from __future__ import annotations

import shutil
from dataclasses import dataclass
from typing import Iterable

import agent_cli
import config


@dataclass(frozen=True)
class AgentStatus:
    name: str          # the YURI_AGENTS token, e.g. "claude-code"
    label: str         # for a person to read
    available: bool    # is the binary on PATH
    detail: str        # path and version, or why not
    enabled: bool      # does YURI_AGENTS ask for it


# Every agent this codebase can drive. A registry rather than "whatever is
# installed": an agent absent from the UI cannot be discovered by the user.
# Adding one is an entry here plus a runner -- codex is NOT here because
# nothing in this codebase can drive it yet.
REGISTRY: tuple[tuple[str, str, str], ...] = (
    # (YURI_AGENTS token, label, binary name)
    ("claude-code", "Claude Code", "claude"),
    ("opencode", "OpenCode", "opencode"),
)


def build(enabled: Iterable[str], found: dict[str, str],
          versions: dict[str, str]) -> list[AgentStatus]:
    """The registry crossed with what is installed. Pure."""
    on = set(enabled)
    out: list[AgentStatus] = []
    for token, label, binary in REGISTRY:
        path = found.get(binary)
        if path is None:
            detail = f"not installed - no `{binary}` on PATH"
        else:
            ver = versions.get(path)
            detail = f"{path} ({ver})" if ver else path
        out.append(AgentStatus(name=token, label=label, available=path is not None,
                               detail=detail, enabled=token in on))
    return out


def any_available(agents: Iterable[AgentStatus]) -> bool:
    """Whether she can actually run anything: installed AND asked for. An
    installed agent that YURI_AGENTS does not enable is not one she can use."""
    return any(a.available and a.enabled for a in agents)


def statuses() -> list[AgentStatus]:
    """The real machine. `claude` goes through agent_cli so this and the SDK
    resolve the same binary (see agent_cli.py)."""
    found: dict[str, str] = {}
    versions: dict[str, str] = {}
    claude = agent_cli.resolve()
    if claude:
        found["claude"] = claude
        ver = agent_cli.version(claude)
        if ver:
            versions[claude] = ver
    oc = shutil.which(config.OPENCODE_BIN)
    if oc:
        found["opencode"] = oc
    enabled = tuple(t.strip() for t in config.YURI_AGENTS.split(",") if t.strip())
    return build(enabled, found, versions)
