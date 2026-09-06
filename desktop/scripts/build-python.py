#!/usr/bin/env python3
"""Build the bundled Python payload for the packaged app.

Downloads a relocatable CPython, installs the backend's locked requirements
into it, prunes what yuri.payload says to prune, and reports the size against
the budget.

Idempotent, but NOT by reusing the payload in place. The prune deliberately
removes `pip`, so a second `pip install` into a built payload dies with "No
module named pip" -- the payload is not re-buildable once trimmed. Instead a
stamp records the interpreter and the requirements.lock this payload was built
from: a matching stamp skips straight to the report, and a missing or
different one rebuilds from scratch. A changed lock therefore rebuilds by
itself, which reusing the directory would never have done.

Run from the repo root:  python3 desktop/scripts/build-python.py
"""
from __future__ import annotations

import argparse
import hashlib
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
# Inside the payload, so --clean takes it away with everything else.
STAMP = os.path.join(PAYLOAD_DIR, ".yuri-payload")


def log(msg: str) -> None:
    print(f"[build-python] {msg}", flush=True)


def fingerprint() -> str:
    """What this payload was built from. Either the interpreter release or the
    locked requirements changing makes an existing payload stale."""
    with open(os.path.join(ROOT, "backend", "requirements.lock"), "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()[:16]
    return f"cpython-{PBS_VERSION}+{PBS_RELEASE} lock-{digest}"


def stamp_matches() -> bool:
    try:
        with open(STAMP) as f:
            return f.read().strip() == fingerprint()
    except OSError:
        return False


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
    for dirpath, dirnames, files in os.walk(PAYLOAD_DIR, topdown=False):
        for d in list(dirnames):
            full = os.path.join(dirpath, d)
            rel = os.path.relpath(full, PAYLOAD_DIR)
            if payload.should_prune(rel):
                removed += dir_size(full)
                shutil.rmtree(full, ignore_errors=True)
        # Files as well as directories: Tcl/Tk ships three loose files that no
        # directory rule can reach, and they are ~3 MB of a toolkit this app
        # never loads.
        for f in files:
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, PAYLOAD_DIR)
            if payload.should_prune_file(rel):
                try:
                    removed += os.path.getsize(full)
                    os.unlink(full)
                except OSError:
                    pass
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

    # An existing payload built from this same interpreter and lock is done --
    # and must NOT be run through install_requirements() again, because the
    # prune removed the pip that would do it. Report and probe instead.
    if stamp_matches():
        log("payload is already built for this interpreter and lock")
        # enforce=False deliberately: the budget was already checked when this
        # payload was built (the stamp is written only after that check and the
        # import probe both passed), and it has RUN since, which regenerates
        # the __pycache__ the prune removed. Re-gating that larger number here
        # would fail a build that is entirely correct.
        return report(dir_size(PAYLOAD_DIR), 0, enforce=False)

    download()
    unpack()
    install_requirements()
    before = dir_size(PAYLOAD_DIR)
    freed = prune()
    after = dir_size(PAYLOAD_DIR)

    return report(after, freed, before)


def report(after: int, freed: int, before: int | None = None,
           enforce: bool = True) -> int:
    """Size, budget, and a proof the payload still runs.

    NOTE the size being checked is the post-prune one. `__pycache__` is pruned
    and then regenerated by the very probe below, so measuring again afterwards
    gives a larger number that is NOT a budget breach -- see
    yuri/payload.py's MAX_PAYLOAD_BYTES comment.
    """
    if before is not None:
        log(f"before prune: {payload.human(before)}")
        log(f"pruned:       {payload.human(freed)}")
    if enforce:
        log(f"payload:      {payload.human(after)}  "
            f"(budget {payload.human(payload.MAX_PAYLOAD_BYTES)})")
    else:
        # Say WHY this number may exceed the budget, or a reader sees a breach
        # printed exactly like a pass and stops trusting the gate.
        log(f"payload:      {payload.human(after)} as it stands, having run "
            f"(the {payload.human(payload.MAX_PAYLOAD_BYTES)} budget was met at "
            f"build time; __pycache__ has regenerated since)")

    if enforce and not payload.within_budget(after):
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
    # Written only now: a stamp on a payload whose imports fail would let the
    # next run skip straight past a broken build.
    with open(STAMP, "w") as f:
        f.write(fingerprint() + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
