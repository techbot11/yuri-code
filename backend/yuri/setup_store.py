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
import re

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


def clean_value(raw: str | None) -> str:
    """Collapse a pasted value to its safe, single-line form.

    Only the text up to the first newline survives -- a value containing a
    newline would otherwise forge a second `KEY=value` assignment and set any
    variable at all, and merely deleting the newline CHARACTER isn't enough:
    that still concatenates the forged assignment onto the legitimate value
    (`m` + `VC_AUTH_TOKEN=hijacked` becomes `mVC_AUTH_TOKEN=hijacked`), which
    still leaks the forged name and value into the file. Truncating instead
    discards everything after the newline outright.

    Used identically by `write()` (the file) and by the route handler that
    mirrors a write into `os.environ` (this process), so the two can never
    disagree about what a given raw value becomes.
    """
    raw = raw or ""
    first = re.split(r"[\r\n]", raw, maxsplit=1)[0]
    return first.strip()


def write(values: dict[str, str], *, config_dir: str | None = None) -> str:
    """Merge `values` into <config_dir>/.env and return its path.

    An empty value REMOVES the key -- the only way to unset a wrong one from
    the UI. Values are cleaned with `clean_value()` first; see there for why
    a newline is truncated rather than merely deleted.

    The file is created at mode 0600 and re-chmodded on every write, so a
    file that predates this code (or was created by a hand edit) is corrected
    rather than trusted.
    """
    d = config_dir or target_dir()
    os.makedirs(d, mode=0o700, exist_ok=True)
    path = os.path.join(d, ".env")
    merged = _read(path)
    for k, v in values.items():
        v = clean_value(v)
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
