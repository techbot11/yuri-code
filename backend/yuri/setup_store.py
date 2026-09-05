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
import tempfile

import config

_MODE = 0o600


def target_dir() -> str:
    """Where the writable `.env` lives. $YAPCODE_CONFIG_DIR when set (the
    Homebrew and desktop layouts both set it), else a config dir beside her
    data. NOT created here -- `write()` does that, since a mere lookup
    (GET /yuri/config uses this too) has no business creating directories.

    `config.YURI_HOME` rather than re-reading $YURI_HOME: they must be the
    SAME value, or a test (or a real run) that patches one and not the other
    would see this function and `config.py`'s own `.env` loader disagree
    about where the file is."""
    raw = (os.getenv("YAPCODE_CONFIG_DIR") or "").strip()
    if raw:
        return os.path.expanduser(raw)
    return os.path.join(config.YURI_HOME, "config")


def _read(path: str) -> dict[str, str]:
    """Parse an existing `.env` into {key: value}, tolerating the shape a
    human hand-editor (or `yapcode config`) might have left: a `export ` shell
    prefix, and lines that aren't a valid assignment at all.

    Without the `export` strip, `export FOO=old` parses as the key
    `"export FOO"` rather than `"FOO"` -- a later clear of FOO would then
    merge against a merged-dict that has no `"FOO"` entry to pop, leaving the
    stale `export FOO=old` line right there in the rewritten file. A 200
    response with the old value still live after a restart is a lie."""
    out: dict[str, str] = {}
    if not os.path.isfile(path):
        return out
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = re.sub(r"^export\s+", "", k.strip())
            if not k.isidentifier():
                continue
            out[k] = v
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

    This is the last line of defense for a caller that bypasses HTTP
    entirely (this module has no framework dependency to raise an HTTP error
    with). The route handler runs a stricter check of its own first --
    see `has_forging_newline` -- so a value that reaches here from
    PUT /yuri/config has already been refused if it needed to be; a value
    that reaches here from a direct call to `write()` still comes out safe,
    just silently truncated rather than rejected.
    """
    raw = raw or ""
    first = re.split(r"[\r\n]", raw, maxsplit=1)[0]
    return first.strip()


def has_forging_newline(raw: str | None) -> bool:
    """Whether `raw` contains a newline that is NOT just a single trailing
    run (`"...\\n"` or `"...\\r\\n"`, the ordinary artifact of pasting a
    value out of a browser or terminal).

    A value like `"m\\nVC_AUTH_TOKEN=hijacked"` or `"\\nsk-proj-real-key"`
    would otherwise either forge a second assignment or -- worse -- have
    `clean_value` collapse it to an empty string, which the empty-clears-the-
    key rule would then silently delete instead of saving. Route handlers
    should refuse a value this is true for outright (naming the key, never
    the value) rather than let `clean_value` decide quietly."""
    raw = raw or ""
    body = raw.rstrip("\r\n")
    return "\n" in body or "\r" in body


def write(values: dict[str, str], *, config_dir: str | None = None) -> str:
    """Merge `values` into <config_dir>/.env and return its path.

    An empty value REMOVES the key -- the only way to unset a wrong one from
    the UI. Values are cleaned with `clean_value()` first; see there for why
    a newline is truncated rather than merely deleted.

    The replacement file is written to a freshly created temp name (never a
    fixed one) at mode 0600 from the moment it exists, then renamed over the
    real path -- so there is no window where the secret sits in a
    world-readable file, and no fixed name for a symlink planted in the
    config dir to hijack.
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

    # mkstemp creates the file itself (O_CREAT|O_EXCL, mode 0600 baked into
    # the open call) rather than opening a name that might already exist --
    # a fixed name like "<path>.tmp" would let a leftover file's permissions
    # (mode applies only on CREATION, not on an existing file) or a symlink
    # planted at that name survive into this write. fchmod is redundant
    # given mkstemp's own mode, but makes the guarantee explicit rather than
    # implicit in a stdlib default.
    fd, tmp = tempfile.mkstemp(prefix=".env.", suffix=".tmp", dir=d)
    try:
        os.fchmod(fd, _MODE)
        with os.fdopen(fd, "w") as f:
            f.write("# Written by Yuri OS Setup. Values are one per line.\n")
            for k in sorted(merged):
                f.write(f"{k}={merged[k]}\n")
        os.replace(tmp, path)
    except BaseException:
        # The write (or the rename) failed -- don't leave a stray 0600 file
        # holding a secret sitting around under a name nobody will clean up.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    os.chmod(path, _MODE)
    return path
