"""Backend runtime configuration.

Single place where environment-driven settings are resolved: each setting reads
its environment variable when present, otherwise falls back to the default
defined here. The `.env` files are loaded first so values placed there are
honored regardless of which module imports config first.

Config location:

Loaded in this order, which IS the precedence order — the real process
environment wins over all three, and each file only fills what the ones before
it left unset:

  * ~/.config/yapcode/.env — used ONLY by a read-only install (Homebrew), whose
                    wrapper sets YAPCODE_CONFIG_DIR because the Cellar can't
                    host a writable in-tree file. A normal clone never
                    consults it.
  * $YURI_HOME/config/.env — the WRITABLE config file for a clone. Both writers
                    target it: PUT /yuri/config (setup_store.write, what the
                    Setup UI saves) and `bin/yapcode`, whose wizard writes it
                    and whose `yapcode config` opens it. Consulted
                    UNCONDITIONALLY, unlike the Homebrew path above, because a
                    plain clone never sets YAPCODE_CONFIG_DIR: without this, a
                    value saved from Setup would sit in a file nothing ever
                    reads back.
  * backend/.env  — read LAST, so it loses to both of the above (gitignored).
                    No longer written by anything: it was the wizard's target
                    before the Setup UI existed, and it is still loaded so an
                    existing clone's file keeps working. `bin/yapcode` copies
                    it into the writable location on first run. Nothing should
                    tell a user to edit it — it may have no effect.

VC_AUTH_TOKEN is never auto-loaded from any of these — it is opt-in per run mode
(loopback-only `yapcode up`/run.sh stay tokenless; run-network.sh exports it
explicitly). See the access-control note below.
"""
from __future__ import annotations

import os
import re
import secrets
from dataclasses import dataclass

# Yuri's home: her state store (yuri.db), memory/, journal/ and workspace/.
# She may read/write freely here; it is appended to the project sandbox roots
# at runtime (see allowed_project_roots) once it exists. Defined up here
# (rather than down by YURI_AGENTS, where it used to live) because the
# .env-loading block below needs it to locate the Setup-writable config dir.
YURI_HOME: str = os.path.abspath(os.path.expanduser(os.getenv("YURI_HOME") or "~/Yuri"))

# backend/.env lives next to this file — resolved explicitly (not by CWD) so
# `uvicorn main:app` from any directory behaves the same.
_BACKEND_ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")

# Out-of-tree config dir — consulted ONLY when YAPCODE_CONFIG_DIR is set (a
# Homebrew install). A normal clone leaves it unset and writes
# _YURI_HOME_ENV below instead.
_config_dir_raw = os.getenv("YAPCODE_CONFIG_DIR")
_CONFIG_DIR = os.path.expanduser(_config_dir_raw) if _config_dir_raw else None
_CONFIG_ENV = os.path.join(_CONFIG_DIR, ".env") if _CONFIG_DIR else None
_CONFIG_ENV_DISPLAY = (
    _CONFIG_ENV.replace(os.path.expanduser("~"), "~", 1) if _CONFIG_ENV else None)

# THE writable config file for a plain clone (YAPCODE_CONFIG_DIR unset):
# setup_store.write / PUT /yuri/config save here, and bin/yapcode's wizard and
# `yapcode config` target the same path -- see the module docstring.
_YURI_HOME_ENV = os.path.join(YURI_HOME, "config", ".env")
_YURI_HOME_ENV_DISPLAY = _YURI_HOME_ENV.replace(os.path.expanduser("~"), "~", 1)

# Where each .env-provided variable came from, for the startup summary and
# actionable error messages. Values are display labels, never secrets.
ENV_SOURCES: dict[str, str] = {}

try:  # dotenv is present in the venv; stay importable without it (e.g. in tests)
    from dotenv import dotenv_values

    def _load_env_file(path: str | None, *, override: bool, label: str) -> None:
        """Apply a .env file to the environment, recording provenance.
        VC_AUTH_TOKEN is skipped (opt-in per run mode — see module docstring)."""
        if not path or not os.path.isfile(path):
            return
        for _k, _v in (dotenv_values(path) or {}).items():
            if _k == "VC_AUTH_TOKEN" or _v is None:
                continue
            if not override and (os.getenv(_k) or "").strip():
                # fill-gaps: don't shadow an already-set value. But if that
                # value is IDENTICAL to this file's, the file IS where it came
                # from, and leaving ENV_SOURCES unstamped makes _source_of
                # fall through to "process environment" -- a lie with a
                # visible consequence. `yapcode up`'s load_env() exports every
                # line of the config file before spawning the backend, so
                # without this every configured key reported "process
                # environment" and Setup's shell-shadow warning
                # (frontend/lib/setup.ts) fired on all of them, telling the
                # user to unset a shell export that does not exist -- and the
                # saved value would in fact be re-read from the file just
                # fine. `_k not in ENV_SOURCES` so the precedence ORDER still
                # decides which file gets the credit when several hold the
                # same value: the first (highest-precedence) one wins, and a
                # later file cannot claim a key an earlier one already
                # explained.
                if os.environ.get(_k) == _v and _k not in ENV_SOURCES:
                    ENV_SOURCES[_k] = label
                continue
            os.environ[_k] = _v
            ENV_SOURCES[_k] = label

    # Precedence: the real process environment wins, then the out-of-tree
    # config dir, then the Setup-writable dir beside YURI_HOME, then
    # backend/.env. The real environment is FIRST because the desktop app
    # injects credentials that way (spec §6.3) -- a leftover backend/.env
    # would otherwise silently beat them (same failure shape as a --model
    # flag pinned over the user's own config). Each later file only fills
    # what an earlier one left unset, which is what makes this a strict
    # precedence chain rather than three independent merges.
    _load_env_file(_CONFIG_ENV, override=False, label=_CONFIG_ENV_DISPLAY or "")
    _load_env_file(_YURI_HOME_ENV, override=False, label=_YURI_HOME_ENV_DISPLAY)
    _load_env_file(_BACKEND_ENV, override=False, label="backend/.env")
except Exception:
    pass


# Credentials the desktop app decrypted from the Keychain and injected as real
# environment variables (spec 6.3). YURI_KEYCHAIN_KEYS names them so they can
# be LABELLED, and the labelling is the whole point: without it they fall
# through to _source_of's "process environment" default, and Setup's
# shell-shadow warning then tells the user to unset a shell export that does
# not exist.
#
# That is not a hypothetical -- the identical lie happened for `yapcode up`'s
# load_env() and is why the stamping in _load_env_file above exists at all (see
# its comment). This is the same bug arriving one layer over, from the desktop
# shell instead of the launcher.
#
# Set unconditionally for the names it lists, and AFTER the files are loaded:
# the real environment outranks every file, so for these variables the keychain
# genuinely IS where the effective value came from, even when a leftover .env
# happens to hold the same string. The manifest carries names only, never
# values.
KEYCHAIN_SOURCE = "the app's keychain"


def keychain_sources(getenv) -> dict[str, str]:
    """{var: label} for the credentials the desktop app injected.

    Takes `getenv` rather than reading os.environ, so this is reachable from a
    test -- the module-level call below runs once at import, which a test
    cannot arrange after the fact.

    A named variable with no value is skipped: the manifest says what the shell
    INTENDED to inject, and labelling an empty one would claim a provenance for
    a value that is not there.
    """
    out: dict[str, str] = {}
    for name in (getenv("YURI_KEYCHAIN_KEYS") or "").split(","):
        name = name.strip()
        if name and (getenv(name) or "").strip():
            out[name] = KEYCHAIN_SOURCE
    return out


ENV_SOURCES.update(keychain_sources(os.getenv))


# --- config provenance (startup summary + actionable errors) -----------------

# Provider API keys the voice layer can mint sessions with (any one suffices).
VOICE_KEY_VARS: tuple[str, ...] = ("GEMINI_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY")


def _source_of(var: str) -> str:
    """Display label for where a variable's effective value came from."""
    if not (os.getenv(var) or "").strip():
        return "not set"
    return ENV_SOURCES.get(var, "process environment")


def voice_keys_found() -> list[tuple[str, str]]:
    """(var, source) for each configured voice provider key."""
    return [(v, _source_of(v)) for v in VOICE_KEY_VARS if (os.getenv(v) or "").strip()]


def env_files_checked() -> str:
    """Human-readable list of the .env locations consulted, with presence, in
    the SAME order config.py loads them -- so this string reads as the
    search order it describes, rather than a list a future fourth source
    could silently fall out of. The out-of-tree Homebrew dir is only listed
    when it applies (YAPCODE_CONFIG_DIR set), matching the module
    docstring's Config location section; the other two are unconditional."""
    parts = []
    if _CONFIG_ENV:  # only relevant for a Homebrew (YAPCODE_CONFIG_DIR) install
        parts.append(f"{_CONFIG_ENV_DISPLAY} "
                     f"({'present' if os.path.isfile(_CONFIG_ENV) else 'not found'})")
    parts.append(f"{_YURI_HOME_ENV_DISPLAY} "
                 f"({'present' if os.path.isfile(_YURI_HOME_ENV) else 'not present'})")
    parts.append(f"backend/.env ({'present' if os.path.isfile(_BACKEND_ENV) else 'not present'})")
    return " and ".join(parts)


def missing_key_detail(var: str) -> str:
    """Actionable error body for a missing provider key/setting — says where we
    looked and how to fix it, instead of a bare 'not set'."""
    return (f"{var} is not set on the server. Looked in {env_files_checked()}. "
            f"Add it in Yuri OS under Setup.")


def summary() -> str:
    """One-line config provenance banner for startup logs. Names and sources
    only — never secret values."""
    keys = voice_keys_found()
    voice = ", ".join(f"{v} (from {src})" for v, src in keys) if keys else "NONE FOUND"
    token = (f"set (from {_source_of('VC_AUTH_TOKEN')}; required from ALL callers, "
             "including localhost)" if AUTH_TOKEN else "not set (loopback-only access)")
    roots = (os.getenv("ALLOWED_PROJECT_ROOTS") or "").strip() or "(not set)"
    return f"voice keys: {voice} · auth token: {token} · allowed roots: {roots}"


# --- managed configuration, for the Setup UI ------------------------------
# The settings a user can change from inside the app. Everything here is
# rendered by GET /yuri/config and written by PUT /yuri/config.
#
# `effect` says what a change takes effect on, because it is NOT uniform and
# a UI that implied otherwise would be lying:
#   "now"          read live via os.getenv at use time
#   "next-session" passed to a child process when it is spawned
#   "restart"      frozen into a module constant at import (see YURI_HOME etc.)


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
    # Read live by allowed_project_roots(), so a change applies at once. Also
    # the setting that decides where Yuri may work at all, which is why the
    # doctor's "allowed roots" message can point at this screen.
    ManagedKey("ALLOWED_PROJECT_ROOTS", "Folders she may work in", False, "now",
               "Comma-separated. A session outside these folders refuses to "
               "start. Her own home is always allowed."),
)


def strip_url_userinfo(value: str) -> str:
    """`https://user:token@gw/x` -> `https://***@gw/x`.

    Public because `yuri.doctor` needs it too: OPENCODE_URL is interpolated
    into detail strings that GET /yuri/doctor returns verbatim, and a password
    written into a URL is a credential wherever it appears. A non-secret setting
    (a base URL) can still carry a credential in its userinfo -- masking the
    key but not this would let one straight through GET /yuri/config, which
    this whole module promises never returns a secret value. Anything that
    isn't `scheme://...@host` (a bare model name, a plain URL with no
    userinfo) passes through untouched."""
    from urllib.parse import urlsplit, urlunsplit
    try:
        parts = urlsplit(value)
    except ValueError:
        return value
    if not parts.scheme or "@" not in parts.netloc:
        return value
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    return urlunsplit((parts.scheme, f"***@{host}", parts.path, parts.query, parts.fragment))


def masked_hint(value: str, *, secret: bool = True) -> str:
    """A hint that identifies a value without revealing it.

    Only the last four characters, and only when there is enough left over to
    keep hidden -- "…abcd" of a six-character secret reveals most of it. Short
    secrets get no hint at all. Non-secrets (a URL, a model name) are
    configuration rather than credentials, so masking them would make the UI
    useless -- except a URL's userinfo, which IS a credential regardless of
    which field carries it; see `strip_url_userinfo`."""
    value = (value or "").strip()
    if not value:
        return ""
    if not secret:
        return strip_url_userinfo(value)
    return f"…{value[-4:]}" if len(value) > 8 else "set"


# The variables an agent child needs that this process may only have learned
# at runtime -- Setup writes them into our own environment (see PUT
# /yuri/config), and a shell export gives them to us too.
#
# A tmux pane does NOT inherit them. `tmux new-session` hands the child the
# tmux SERVER's environment, captured whenever that server first started,
# which is routinely days earlier: measured on a live machine, a pane created
# minutes after Setup saved an ANTHROPIC_AUTH_TOKEN still saw zero
# ANTHROPIC_* variables, and `claude` fell back to OAuth and asked to log in.
# So they have to be handed over explicitly -- see tmux_runner._write_agent_env.
#
# The SDK backend needs none of this: it spawns in-process and inherits
# os.environ directly.
AGENT_ENV_VARS: tuple[str, ...] = (
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
)


# The rest of the environment an agent needs to behave like the user's own
# terminal. Same root cause as AGENT_ENV_VARS above -- a tmux pane inherits the
# SERVER's environment, and that server is days old -- but a different class of
# variable, so kept separate: these are shell context, not credentials.
#
# A DELIBERATE LIST, not os.environ wholesale. Handing the agent everything
# would ship Yuri's own internals (VC_AUTH_TOKEN, YURI_*, the desktop shell's
# bookkeeping) into a shell the user reads and a model sees. Each entry below
# earned its place:
#
#   LANG, LC_ALL      Text encoding. A missing locale is how a subprocess ends
#                     up decoding bytes wrongly -- this repo has already caught
#                     one UnicodeDecodeError from exactly that shape.
#   SSH_AUTH_SOCK     An agent that runs `git push` over SSH needs the agent
#                     socket, and the socket path is per-login: a five-day-old
#                     tmux server points at one that no longer exists. Carried
#                     only when ours actually EXISTS, so a dead socket of ours
#                     never replaces a live one of theirs.
#   HTTP(S)_PROXY,    Behind a corporate proxy an agent cannot reach anything
#   NO_PROXY          without these, and they are exactly the kind of thing
#                     configured after a tmux server started.
#
# Deliberately ABSENT, and each for a reason found the hard way:
#   HOME              The pane's own HOME is already correct, and getting it
#                     wrong moves ~/.claude out from under the CLI. No upside.
#   NODE_OPTIONS      Verification in this repo hit port collisions from an
#                     inherited --inspect; passing it down would make that a
#                     shipped behaviour rather than an accident.
#   TERM              tmux sets it correctly for the pane it created.
AGENT_SHELL_VARS: tuple[str, ...] = (
    "LANG", "LC_ALL",
    "SSH_AUTH_SOCK",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy",
)


def agent_child_env() -> dict[str, str]:
    """The AGENT_ENV_VARS that are actually set, for handing to an agent child.
    Absent and blank are the same thing: a blank would shadow whatever the
    child would otherwise have found for itself."""
    out: dict[str, str] = {}
    for k in AGENT_ENV_VARS:
        v = (os.getenv(k) or "").strip()
        if v:
            out[k] = v
    return out


def agent_shell_env(getenv=os.getenv, exists=os.path.exists) -> dict[str, str]:
    """The AGENT_SHELL_VARS worth handing over, with their caveats applied.

    `getenv` and `exists` are injected so the rules are testable without
    arranging a real environment or a real socket.

    Blank is the same as absent, as above. SSH_AUTH_SOCK additionally has to
    point at something that is there: ours being stale is as likely as theirs,
    and replacing a working socket with a dead one would break `git push` in
    the name of fixing it.
    """
    out: dict[str, str] = {}
    for k in AGENT_SHELL_VARS:
        v = (getenv(k) or "").strip()
        if not v:
            continue
        if k == "SSH_AUTH_SOCK" and not exists(v):
            continue
        out[k] = v
    return out


def managed_status() -> list[dict]:
    """Every managed key: whether it is set, a hint, where it came from, and
    what changing it takes effect on.

    NEVER returns a value. This function is the boundary the Setup UI reads
    through, so a leak here is a leak everywhere."""
    out = []
    for k in MANAGED_KEYS:
        raw = (os.getenv(k.name) or "").strip()
        hint = masked_hint(raw, secret=k.secret) if raw else ""
        out.append({
            "name": k.name, "label": k.label, "secret": k.secret,
            "effect": k.effect, "blurb": k.blurb,
            "set": bool(raw),
            "hint": hint,
            # Whether `hint` HIDES something rather than being the value. The
            # Setup screen pre-fills a field only when it does not: a secret's
            # hint is "...9f31", and a non-secret URL's userinfo is stripped,
            # so pre-filling either would save the mask as the value.
            "masked": bool(raw) and hint != raw,
            "source": _source_of(k.name),
        })
    return out


def _env_bool(name: str, default: bool) -> bool:
    """Read a boolean env var. Missing/empty -> default; otherwise truthy values
    are 1/true/yes/on (case-insensitive), everything else is False."""
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# Repo root = parent of this backend/ directory.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Where interactive CLI session control dirs live (meta.json, events.jsonl,
# mode, settings.json, decisions/) — the on-disk storage rehydration reads.
# Defaults to a folder inside the project so it's easy to find, inspect, and
# edit (gitignored). Override with VC_SESSION_STORE to point anywhere, e.g.
# back to ~/.yapcode/tmux.
SESSION_STORE_DIR: str = os.path.abspath(os.path.expanduser(
    os.getenv("VC_SESSION_STORE") or os.path.join(_REPO_ROOT, ".yapcode", "tmux")
))


def allowed_project_roots() -> list[str]:
    """Realpath'd ALLOWED_PROJECT_ROOTS entries — the directory sandbox a session's
    cwd must live under — plus Yuri's home once it exists. Realpath (not just
    abspath) so symlinked roots compare correctly against a realpath'd candidate."""
    raw = os.getenv("ALLOWED_PROJECT_ROOTS", "")
    roots = [os.path.realpath(os.path.expanduser(p)) for p in raw.split(",") if p.strip()]
    home = os.path.realpath(YURI_HOME)
    if os.path.isdir(home) and home not in roots:
        roots.append(home)
    return roots


def resolve_within_roots(path: str) -> str:
    """Realpath `path` and return it only if it is an existing directory contained
    in one of `allowed_project_roots()`; raise ValueError otherwise.

    Fails closed: with no roots configured nothing is allowed. This is the sink-side
    guard the session runners apply to a cwd before using it in any filesystem
    operation — defense in depth alongside session_manager.resolve_project_path,
    which resolves spoken folder references to an allowed path in the first place."""
    real = os.path.realpath(os.path.abspath(os.path.expanduser(path)))
    for root in allowed_project_roots():
        # Kept as a bare `real.startswith(root)` (no `or`, no wrapping the receiver)
        # so CodeQL recognizes it as an allowed-prefix path-injection barrier.
        if real.startswith(root):
            tail = real[len(root):]
            if tail and not tail.startswith(os.sep):
                continue  # sibling like "<root>-evil", not actually under the root
            if not os.path.isdir(real):
                raise ValueError(f"not a directory: {path!r}")
            return real
    raise ValueError(f"directory is outside the allowed project roots: {path!r}")


# On backend shutdown, whether to KILL interactive CLI sessions (the old
# destroy-on-exit behavior) or DETACH and leave them running so the next startup
# can rehydrate them.
#
# Default: False -> detach ("let go, don't destroy"), so a restart preserves
# sessions. Set VC_KILL_SESSIONS_ON_SHUTDOWN=1 to restore the old behavior where
# stopping the backend kills every CLI session and removes its control dir.
KILL_SESSIONS_ON_SHUTDOWN: bool = _env_bool("VC_KILL_SESSIONS_ON_SHUTDOWN", False)

# Which agent providers Yuri registers (comma-separated ids). Default: Claude
# Code only. A configured agent is still shown "offline" until its health check
# passes (spec §7).
YURI_AGENTS: str = (os.getenv("YURI_AGENTS") or "claude-code").strip()

# YURI_HOME itself is defined near the top of this file, not here -- the
# .env-loading block needs it before this point.


# --- OpenCode provider ------------------------------------------------------
# Only read when YURI_AGENTS includes "opencode"; OpenCode is optional.
#
# Yuri attaches to a server already answering at OPENCODE_URL; only when
# nothing answers does she spawn one, and she only ever stops a server she
# started. OPENCODE_SPAWN=0 makes her attach-only, for a user who wants to own
# the process. OPENCODE_SERVER_PASSWORD is never logged: summary() above prints
# names and sources only, and `yuri doctor` prints the URL and the status, never
# the value.
OPENCODE_URL: str = (os.getenv("OPENCODE_URL") or "http://127.0.0.1:4096").strip()
OPENCODE_SPAWN: bool = _env_bool("OPENCODE_SPAWN", True)
OPENCODE_BIN: str = (os.getenv("OPENCODE_BIN") or "opencode").strip()
OPENCODE_SERVER_PASSWORD: str = (os.getenv("OPENCODE_SERVER_PASSWORD") or "").strip()
# Basic-auth username. The server pairs the password with a username, and
# Basic with an empty user is refused -- `opencode attach --username` uses
# the same default. Measured, not guessed (see the verification doc).
OPENCODE_SERVER_USERNAME: str = (os.getenv("OPENCODE_SERVER_USERNAME")
                                 or "opencode").strip() or "opencode"
OPENCODE_MODEL: str = (os.getenv("OPENCODE_MODEL") or "").strip()

# Whether the spawned OpenCode keeps Yuri's voice-provider keys — see
# opencode_child_env(). Off by default: the spec says strip.
OPENCODE_INHERIT_KEYS: bool = _env_bool("OPENCODE_INHERIT_KEYS", False)


def opencode_child_env() -> dict[str, str]:
    """The environment a spawned `opencode serve` is given.

    Design spec §4: the child "inherits no Yuri secrets". This is the only
    layer that knows which names those are — `OpenCodeServer` may not import
    config, so it takes whatever this returns verbatim.

    * **VC_AUTH_TOKEN is stripped unconditionally.** It is the shared secret
      gating Yuri's own endpoints; OpenCode has no use for it, and a coding
      agent that can read it could authenticate to her API as the user.
    * **VOICE_KEY_VARS are stripped by default, and that is a judgement call.**
      They are Yuri's voice-model keys *and* plausibly OpenCode's own provider
      auth (the same GEMINI_API_KEY / OPENAI_API_KEY names). The spec says
      strip, so stripping is the default; OPENCODE_INHERIT_KEYS=1 is the escape
      hatch for a user whose OpenCode reads its model auth from the environment
      rather than from its own `opencode auth login` store. The hatch covers
      the ambiguous model keys only — never VC_AUTH_TOKEN, which is never
      OpenCode's.
    * **Everything else passes through**, PATH and HOME in particular: the child
      cannot find its own binary or its config without them.

    The server password is *not* set here. `OpenCodeServer._spawn` layers it on
    top of whatever this returns, so filtering can never disarm server auth.
    """
    env = dict(os.environ)
    env.pop("VC_AUTH_TOKEN", None)
    if not OPENCODE_INHERIT_KEYS:
        for var in VOICE_KEY_VARS:
            env.pop(var, None)
    return env


# --- Access control ---------------------------------------------------------
#
# The backend turns voice/tool calls into real command execution on this
# machine, so its endpoints (and the live-terminal WebSocket) must not be open
# to anyone who can reach the port. Two layers gate access:
#
#   1. A shared-secret token (VC_AUTH_TOKEN). When set, every sensitive endpoint
#      and the terminal WebSocket require it (header `X-VC-Token` / `Authorization:
#      Bearer` / `?token=`). When UNSET, only loopback (localhost) clients are
#      allowed and any remote caller is refused — so plain `run.sh` on localhost
#      needs zero config, while exposing the server to the LAN (run-network.sh)
#      forces a token to be set first. The token is required even from loopback
#      once configured, so the same-origin Next proxy can't be used to launder a
#      remote attacker's request into a trusted loopback call.
#
#   2. A CORS / WebSocket-Origin allowlist (replaces the old `*`) so a malicious
#      web page in the user's browser can't drive the backend cross-origin.
AUTH_TOKEN: str = (os.getenv("VC_AUTH_TOKEN") or "").strip()


def token_matches(provided: str | None) -> bool:
    """Constant-time compare of a presented token against VC_AUTH_TOKEN.
    Always False when no token is configured (callers fall back to loopback)."""
    if not AUTH_TOKEN or not provided:
        return False
    return secrets.compare_digest(provided, AUTH_TOKEN)


def _default_allowed_origins() -> list[str]:
    """Exact frontend origins that may call the backend cross-origin (the live
    terminal WS / debug stream are browser-direct). Localhost dev ports by
    default; extend with VC_ALLOWED_ORIGINS (comma-separated)."""
    base = [
        "http://localhost:3000", "http://127.0.0.1:3000",
        "https://localhost:3000", "https://127.0.0.1:3000",
    ]
    extra = [o.strip() for o in (os.getenv("VC_ALLOWED_ORIGINS") or "").split(",") if o.strip()]
    # De-dupe, preserve order.
    seen: set[str] = set()
    out: list[str] = []
    for o in [*base, *extra]:
        if o not in seen:
            seen.add(o)
            out.append(o)
    return out


ALLOWED_ORIGINS: list[str] = _default_allowed_origins()

# Private-LAN origins (any port) are allowed by default so the phone/laptop can
# reach the backend over the LAN in network mode — mirrors next.config.mjs's
# allowedDevOrigins. The token is still required there, so this regex is a
# convenience for legitimate same-network devices, not the security boundary.
# Override or disable with VC_ALLOWED_ORIGIN_REGEX (set it empty to disable).
_DEFAULT_ORIGIN_REGEX = (
    r"^https?://("
    r"localhost|127\.0\.0\.1|\[::1\]|"
    r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
    r"192\.168\.\d{1,3}\.\d{1,3}|"
    r"172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
    r")(:\d{1,5})?$"
)
_origin_regex_raw = os.getenv("VC_ALLOWED_ORIGIN_REGEX")
ALLOWED_ORIGIN_REGEX: str | None = (
    _DEFAULT_ORIGIN_REGEX if _origin_regex_raw is None else (_origin_regex_raw.strip() or None)
)
_ORIGIN_RE = re.compile(ALLOWED_ORIGIN_REGEX) if ALLOWED_ORIGIN_REGEX else None


def exact_origin_allowed(origin: str | None) -> bool:
    """Whether `origin` is one of the EXACT origins in ALLOWED_ORIGINS —
    ALLOWED_ORIGIN_REGEX is deliberately not consulted.

    For the credential-writing endpoints (GET/PUT /yuri/config, GET
    /yuri/doctor) `origin_allowed` is too loose to be a boundary: its default
    regex fullmatches loopback and every private-LAN address on ANY port, so
    a page served from any other local port would satisfy it. That looseness
    is fine for the read-mostly, token-guarded browser-direct transports it
    was written for; it is not fine for a route that persists a value into the
    `.env` read at every boot (an attacker-controlled ANTHROPIC_BASE_URL sends
    the user's real Anthropic credential to their host) or widens
    ALLOWED_PROJECT_ROOTS with effect "now".

    A legitimate browser request never has to satisfy this, because it never
    carries an Origin at all: every REST call goes through the same-origin
    Next proxy (frontend/lib/api.ts), which deliberately does not forward
    Origin (frontend/lib/proxyAuth.ts) and rejects cross-site requests itself
    via Sec-Fetch-Site. That holds for a LAN phone too — the phone talks to
    Next, Next talks to the backend server-side. So the callers this list has
    to admit are the ones configured explicitly with VC_ALLOWED_ORIGINS."""
    return bool(origin) and origin in ALLOWED_ORIGINS


def origin_allowed(origin: str | None) -> bool:
    """Whether a browser Origin header is permitted (used for the WebSocket
    handshake, where CORS middleware doesn't apply). An empty Origin (non-browser
    clients) returns False here; the WS path treats a missing Origin separately."""
    if not origin:
        return False
    if origin in ALLOWED_ORIGINS:
        return True
    # fullmatch (not match) so a trailing newline / extra suffix can't sneak past
    # the `$` anchor.
    return bool(_ORIGIN_RE and _ORIGIN_RE.fullmatch(origin))
