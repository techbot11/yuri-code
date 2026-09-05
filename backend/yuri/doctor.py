"""`yuri doctor` — local environment checks. Prints one line per check;
exit 0 when everything required is present."""
from __future__ import annotations

import asyncio
import os
import shutil
import sys
from dataclasses import dataclass

import config
from yuri.home import Home
from yuri.store.sqlite import SCHEMA_VERSION, SqliteStore


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


def _opencode_reachable() -> bool:
    """One probe of OPENCODE_URL, exactly the way the provider does it — same
    endpoint, same auth, same short timeout — so doctor and Yuri agree.

    Imported inside the function so `yuri doctor` still runs its other checks
    if the OpenCode code path (or httpx) is unimportable, and so a doctor run
    for a user without OpenCode pays nothing for it. Never acquires: a probe
    must not start a server for someone who only asked for a checkup.
    """
    try:
        from yuri.providers.opencode.server import OpenCodeServer
        server = OpenCodeServer(config.OPENCODE_URL, spawn=False,
                                password=config.OPENCODE_SERVER_PASSWORD or None)
        return asyncio.run(server.is_reachable())
    except Exception:
        return False


def _opencode_status() -> tuple[str, str]:
    """(status, detail) for the OpenCode line: attached, spawnable or
    unavailable. Names the URL and the binary; never the password."""
    url = config.OPENCODE_URL
    if _opencode_reachable():
        return "attached", (f"attached · a server is already answering at {url} "
                            "— Yuri will use it and never stop it")
    binary = config.OPENCODE_BIN
    found = binary if os.path.sep in binary else shutil.which(binary)
    if not config.OPENCODE_SPAWN:
        return "unavailable", (f"unavailable · nothing answered at {url} and "
                               "OPENCODE_SPAWN=0, so Yuri will not start one — run "
                               "`opencode serve` yourself, or set OPENCODE_SPAWN=1")
    if not found:
        return "unavailable", (f"unavailable · nothing answered at {url} and {binary!r} "
                               "is not on PATH — install OpenCode, or set OPENCODE_BIN "
                               "to its full path")
    return "spawnable", (f"spawnable · {found} · nothing at {url} yet; Yuri will "
                         "start one when a session needs it")


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

    # config.allowed_project_roots() always appends Yuri's own home once it
    # exists on disk (independent of ALLOWED_PROJECT_ROOTS), and home.ensure()
    # above has just created it — so `roots` itself is never empty and can't
    # be used as the pass/fail signal here. What actually matters for this
    # check is whether there is any allowed root OTHER than Yuri's home: if
    # not, real project sessions have nowhere to start, even though the
    # effective-roots list looks non-empty. Report the raw configuration
    # alongside the effective roots so both are visible.
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


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
