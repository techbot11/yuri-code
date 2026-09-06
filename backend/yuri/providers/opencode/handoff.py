"""Which server-side OpenCode session a `/voice-handoff` from an OpenCode
terminal refers to.

OpenCode's custom commands (`~/.config/opencode/commands/*.md`) give the
shell command they run no session-id variable — no documented `$ARGUMENTS`
equivalent for "which session am I" — and the JS plugin API documents none
either. So the only thing a `/voice-handoff` invocation can tell Yuri about
itself is its **working directory** (`pwd`, run from the script).

`pick()` resolves that against the server's own session list — every session
whose `location.directory` matches, most recently updated first — the same
way `GET /api/session` reports it. Two matches adopt **neither**: guessing
between two of the user's own sessions is exactly the takeover
`provider.py`'s `rehydrate(known=...)` deliberately avoids (see its docstring:
"the user's own OpenCode work, and adopting it would put her in charge").
Naming both and adopting nothing keeps that choice with the user, who can
re-run the handoff with an explicit `session_id` once they see which is
which.

Pure: the caller (the `/session/handoff/opencode` endpoint) fetches the
sessions from the provider and hands them here; nothing in this module talks
to the network.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Pick:
    """The resolved session, or why there isn't one."""
    session: dict[str, Any] | None
    ambiguous: list[dict[str, Any]] = field(default_factory=list)
    reason: str = ""


def _norm(p: str) -> str:
    """Compare directories without a trailing slash deciding the outcome:
    `pwd` and the server can disagree about one, and a handoff that failed for
    that reason would look like a broken integration rather than a mismatch."""
    return os.path.normpath(p or "")


def _updated(session: dict[str, Any]) -> float:
    t = (session.get("time") or {}).get("updated")
    try:
        return float(t)
    except (TypeError, ValueError):
        return -1.0     # unknown sorts last rather than raising


def pick(sessions: list[dict[str, Any]], directory: str) -> Pick:
    want = _norm(directory)
    matches = [
        s for s in sessions
        if _norm(str((s.get("location") or {}).get("directory") or "")) == want
    ]
    if not matches:
        return Pick(None, [], f"no OpenCode session is open in {directory}")
    if len(matches) > 1:
        # Newest first, so the message names them in the order a person would
        # guess between.
        ordered = sorted(matches, key=_updated, reverse=True)
        return Pick(None, ordered,
                    f"more than one OpenCode session is open in {directory}")
    return Pick(matches[0], [], "")
