"""Importing ~/Yuri/memory/*.md into the memories table, once (spec §8).

Not a `.sql` migration: `Store.migrate()` runs SQL files only, has no `Home`,
and SQL cannot read a directory. Guarded by a settings flag rather than by the
schema version, so a later migration bumping the version cannot cause a second
import.

**The files are never modified.** They were handed to the user as "plain
markdown — edit or delete anything you like", and rewriting or deleting them
here would take that back without asking. They simply stop being read.

The import is deliberately DUMB about classification: every user line becomes
a `fact`, never a `preference`, even when it reads exactly like a rule. The
user's three real lines are all behavioural rules and will land as facts, to
be flipped in the panel in one click. A migration that guessed at what a rule
means would be confidently wrong about the most important memories she has.
"""
from __future__ import annotations

import logging
import os
import re

from yuri.domain.memory import InvalidMemory, Memory
from yuri.home import Home
from yuri.store.base import Store

log = logging.getLogger("yuri.memory.import")

IMPORT_FLAG = "memory_import_done"

# The shape `Memory.remember` wrote: "- YYYY-MM-DD  the fact".
DATED_LINE = re.compile(r"^-\s+(\d{4}-\d{2}-\d{2})\s+(.+)$")
_SLUG_RE = re.compile(r"^[a-z0-9-]{1,64}$")


def _lines(path: str) -> list[tuple[str, str]]:
    """(date, body) for every dated bullet. Everything else — the header, the
    explanatory prose, a bullet the user hand-wrote in another shape — is
    left in the file, which is still theirs."""
    if not os.path.exists(path):
        return []
    out: list[tuple[str, str]] = []
    with open(path, encoding="utf-8") as f:
        for raw in f:
            m = DATED_LINE.match(raw.strip())
            if m:
                out.append((m.group(1), m.group(2).strip()))
    return out


def import_legacy(store: Store, home: Home) -> dict:
    """Import once. Returns {"imported", "skipped", "already_done"}.

    The flag is set only after every write has succeeded, so a failure retries
    at the next startup rather than being recorded as done.
    """
    if store.settings.get(IMPORT_FLAG, ""):
        return {"imported": 0, "skipped": 0, "already_done": True}

    imported = skipped = 0

    def add(body: str, date: str, kind: str, subject: str) -> None:
        nonlocal imported, skipped
        # The same no-op the write path uses (spec §5.4): a file with the same
        # line twice becomes one memory.
        if store.memories.by_body(body) is not None:
            skipped += 1
            return
        try:
            m = Memory(body=body, kind=kind, subject=subject, source="stated", origin="ui")
        except InvalidMemory as exc:
            log.warning("skipping a memory from %s: %s", subject, exc)
            skipped += 1
            return
        # The date the user was told it, not today.
        m.created_at = f"{date}T00:00:00+00:00"
        m.updated_at = m.created_at
        store.memories.insert(m)
        imported += 1

    for date, body in _lines(home.user_memory_path):
        add(body, date, "fact", "user")

    projects_dir = home.projects_memory_dir
    if os.path.isdir(projects_dir):
        for fname in sorted(os.listdir(projects_dir)):
            if not fname.endswith(".md"):
                continue
            slug = fname[: -len(".md")]
            if not _SLUG_RE.match(slug):
                # A file whose name is not a slug cannot be a subject, and
                # inventing one would file the notes where nothing looks.
                log.warning("skipping memory/projects/%s: not a project slug", fname)
                skipped += 1
                continue
            for date, body in _lines(os.path.join(projects_dir, fname)):
                add(body, date, "project", slug)

    store.settings.set(IMPORT_FLAG, "1")
    if imported or skipped:
        log.info("imported %d memory line(s) from %s (%d skipped); the files were not modified",
                 imported, home.memory_dir, skipped)
    return {"imported": imported, "skipped": skipped, "already_done": False}
