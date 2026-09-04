# Yuri's Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Yuri's append-only markdown memory with a store that survives, can be corrected, carries what she noticed, and can be searched — a small unconditional core in her prompt plus `recall` as a tool.

**Architecture:** One `memories` table. `recollection.py` owns selection (core tier), supersede resolution and recall; `embedding.py` is one HTTP call behind an interface so tests use a fake; `rollup.py` turns history into memories in the background at startup. Retrieval is a TOOL, never a connect-time step, because `/yuri/context` is fetched once at connect and at connect there is no query to be similar to.

**Tech Stack:** Python 3.14 + FastAPI + stdlib sqlite3 (no vector DB, no numpy — measured). Next 16 / React 19 / TypeScript. Backend tests `unittest`; frontend tests `node --test lib/*.test.ts` only, so anything tested must be a pure function in `lib/`.

**Spec:** `docs/superpowers/specs/2026-09-04-yuri-memory-design.md`

## How this plan is written, and why

Task 1 below is written at full density — every test body, every line of
implementation — because everything else depends on the row shape and the
repository, and a wrong shape there propagates into ten files.

**Tasks 2 onward carry exact interfaces and a named test inventory rather than
transcribed test bodies.** That is a deliberate deviation from the
writing-plans default, and the reason is that this plan is executed in the
session that wrote it: the author is the implementer. Transcribing 3,000 lines
of test code into a document and then re-typing it as code is spend with no
reader. What the plan must NOT lose is the part that actually prevents drift —
exact signatures, exact constants, and what each test has to prove — so those
are kept in full.

If this plan is ever handed to a cold implementer, tasks 2+ need their test
bodies written out first. Said here rather than discovered there.

## Global Constraints

- `EMBED_MODEL = "gemini-embedding-001"`, `EMBED_DIMS = 768`, `EMBED_TIMEOUT_S = 20`.
- `CORE_BUDGET_CHARS = 2000`, `CORE_DAYS = 3`, `RECALL_MAX = 5`, `RECALL_BODY_MAX = 300`, `BODY_MAX = 500`, `SEMANTIC_SCAN_MAX = 10_000`, `DAY_SUMMARY_MODEL = "gemini-2.5-flash"`.
- `KINDS = ("preference", "fact", "observation", "day", "project")`; `SOURCES = ("stated", "observed", "inferred")`; `ORIGINS = ("voice", "ui", "journal", "mission")`.
- **Subject is defined per kind and nothing else is allowed:** `preference`/`fact`/`day` → `"user"`; `project` → the project slug; `observation` → the project slug of the mission it came from.
- **A write is never refused for being the ten-thousandth.** `SEMANTIC_SCAN_MAX` bounds the semantic scan only.
- **Writes never block on an embedding.** Rows are written with `embedding = NULL` and embedded in the background.
- **`preference` rows are exempt from `CORE_BUDGET_CHARS`.**
- Every new voice tool declares `tier` and `category`; `tools_for_model()` strips them.
- No `shell=True`, no `create_subprocess_shell`, no `os.system` (enforced by a source-grep test).
- Follow `docs/yuri/design/GUIDE.md` for any UI: no literal colours, a control that would fail is not rendered, empty/loading/failed never look the same.
- The user's existing markdown files are never modified or deleted.

---

## Task 1: Domain, migration 0005, and the repository

**Files:**
- Create: `backend/yuri/domain/memory.py`
- Create: `backend/yuri/store/migrations/0005_memories.sql`
- Modify: `backend/yuri/store/base.py` (add `MemoryRepo`, add `memories` to `Store`)
- Modify: `backend/yuri/store/sqlite.py` (`SCHEMA_VERSION` 4 → 5, `_BOOL_COLS` += `pinned`, `SqliteMemories`, wire into `SqliteStore.__init__`)
- Test: `backend/tests/test_memory_domain.py`, `backend/tests/test_memory_store.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `yuri.domain.memory.Memory` dataclass with fields, in this order:
    `body: str`, `kind: str`, `subject: str = "user"`, `id: str = field(default_factory=new_id)`,
    `source: str = "stated"`, `origin: str = "voice"`, `superseded_by: str | None = None`,
    `pinned: bool = False`, `embedding: bytes | None = None`,
    `created_at: str = field(default_factory=utcnow)`, `updated_at: str = field(default_factory=utcnow)`
  - `KINDS`, `SOURCES`, `ORIGINS`, `BODY_MAX = 500`, `SUBJECT_FOR_KIND: dict[str, str]`
  - `Memory.to_dict()`, `Memory.from_dict(d)`, `Memory.is_current` property
  - `InvalidMemory(ValueError)`
  - `MemoryRepo` (abstract): `insert(m)`, `get(id)`, `update(m)`, `current(kinds=None, subjects=None, limit=200)`, `for_subject(subject, limit=200)`, `superseded_of(id)`, `needing_embedding(limit=50)`, `with_embeddings(limit=SEMANTIC_SCAN_MAX)`, `by_body(body)`, `count()`

- [ ] **Step 1: Write the failing domain test**

```python
# backend/tests/test_memory_domain.py
"""The Memory row. Its validation is the only thing standing between a typo
and a memory she asserts as fact."""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from yuri.domain.memory import (BODY_MAX, KINDS, ORIGINS, SOURCES,  # noqa: E402
                                InvalidMemory, Memory)


class MemoryShapeTests(unittest.TestCase):
    def test_a_minimal_memory_defaults_to_something_usable(self):
        m = Memory(body="prefers short answers", kind="preference")
        self.assertEqual((m.subject, m.source, m.origin), ("user", "stated", "voice"))
        self.assertFalse(m.pinned)
        self.assertIsNone(m.embedding)
        self.assertIsNone(m.superseded_by)
        self.assertTrue(m.is_current)

    def test_it_round_trips_through_a_dict(self):
        m = Memory(body="b", kind="fact", subject="user", source="observed",
                   origin="mission", pinned=True)
        self.assertEqual(Memory.from_dict(m.to_dict()), m)

    def test_an_empty_body_is_refused(self):
        for bad in ("", "   ", "\n"):
            with self.assertRaises(InvalidMemory):
                Memory(body=bad, kind="fact")

    def test_the_body_is_whitespace_collapsed_and_bounded(self):
        m = Memory(body="  two\n\nlines   here  ", kind="fact")
        self.assertEqual(m.body, "two lines here")
        self.assertEqual(len(Memory(body="x" * 900, kind="fact").body), BODY_MAX)

    def test_an_unknown_kind_source_or_origin_is_refused_by_name(self):
        for field, value in (("kind", "vibes"), ("source", "guessed"), ("origin", "telepathy")):
            with self.assertRaises(InvalidMemory) as ctx:
                Memory(**{"body": "b", "kind": "fact", field: value})
            self.assertIn(value, str(ctx.exception), field)

    def test_the_subject_is_forced_to_match_the_kind(self):
        # Spec's Global Constraints: subject is defined per kind and nothing
        # else is allowed. A `preference` filed under a project would never be
        # selected by the core tier, so it would be a memory that silently
        # does nothing.
        self.assertEqual(Memory(body="b", kind="preference", subject="yuri-code").subject, "user")
        self.assertEqual(Memory(body="b", kind="fact", subject="yuri-code").subject, "user")
        self.assertEqual(Memory(body="b", kind="day", subject="anything").subject, "user")
        # project and observation KEEP their slug.
        self.assertEqual(Memory(body="b", kind="project", subject="yuri-code").subject, "yuri-code")
        self.assertEqual(Memory(body="b", kind="observation", subject="yuri-code").subject,
                         "yuri-code")

    def test_a_project_memory_with_no_slug_is_refused(self):
        # It would be unfindable: the core tier selects project facts BY slug.
        with self.assertRaises(InvalidMemory):
            Memory(body="b", kind="project", subject="user")
        with self.assertRaises(InvalidMemory):
            Memory(body="b", kind="project", subject="")

    def test_a_slug_that_is_not_a_slug_is_refused(self):
        for bad in ("Not A Slug", "../etc", "a/b"):
            with self.assertRaises(InvalidMemory):
                Memory(body="b", kind="project", subject=bad)

    def test_superseded_is_not_current(self):
        m = Memory(body="b", kind="fact", superseded_by="other-id")
        self.assertFalse(m.is_current)

    def test_the_enums_are_what_the_spec_says(self):
        self.assertEqual(KINDS, ("preference", "fact", "observation", "day", "project"))
        self.assertEqual(SOURCES, ("stated", "observed", "inferred"))
        self.assertEqual(ORIGINS, ("voice", "ui", "journal", "mission"))
```

- [ ] **Step 2: Run it, confirm it fails on the missing module**

Run: `cd backend && .venv/bin/python -m unittest tests.test_memory_domain`
Expected: `ModuleNotFoundError: No module named 'yuri.domain.memory'`

- [ ] **Step 3: Write the domain**

```python
# backend/yuri/domain/memory.py
"""One thing Yuri remembers (spec §3).

The validation here is load-bearing rather than defensive. Two rules in
particular:

  * `subject` is forced to match `kind`. The core tier selects preferences and
    facts under `"user"` and project facts BY SLUG, so a preference filed
    under a project would never be selected — a memory that exists and
    silently does nothing, which is worse than one that was refused.
  * `source` is a closed set of three, because her prompt renders each one
    differently. "You told me", "it happened" and "I think" must never be able
    to read alike, and a fourth value would render as one of them by accident.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

from .ids import new_id, utcnow

KINDS: tuple[str, ...] = ("preference", "fact", "observation", "day", "project")
SOURCES: tuple[str, ...] = ("stated", "observed", "inferred")
ORIGINS: tuple[str, ...] = ("voice", "ui", "journal", "mission")

# One sentence. Bounded because every one of these can land in her prompt, and
# a 5,000-character "memory" is a document.
BODY_MAX = 500

USER = "user"
# Kinds whose subject is always the user. A slug on one of these is a filing
# error, and correcting it beats storing something unfindable.
USER_KINDS: frozenset[str] = frozenset({"preference", "fact", "day"})
# Kinds that MUST carry a project slug, for the same reason in reverse.
SLUG_KINDS: frozenset[str] = frozenset({"project", "observation"})

_SLUG_RE = re.compile(r"^[a-z0-9-]{1,64}$")


class InvalidMemory(ValueError):
    """Names the offending value, because a memory refused without saying why
    is a memory the caller will try to write again."""


@dataclass
class Memory:
    body: str
    kind: str
    subject: str = USER
    id: str = field(default_factory=new_id)
    source: str = "stated"
    origin: str = "voice"
    superseded_by: str | None = None
    pinned: bool = False
    # 768 float32 little-endian. NULL until the background embedder gets to
    # it (spec §7.2) — a row is findable by the cheap path immediately and
    # semantically searchable a second later.
    embedding: bytes | None = None
    created_at: str = field(default_factory=utcnow)
    updated_at: str = field(default_factory=utcnow)

    def __post_init__(self) -> None:
        self.body = " ".join(str(self.body or "").split())[:BODY_MAX]
        if not self.body:
            raise InvalidMemory("a memory needs a body")
        for name, allowed in (("kind", KINDS), ("source", SOURCES), ("origin", ORIGINS)):
            value = getattr(self, name)
            if value not in allowed:
                raise InvalidMemory(f"unknown {name}: {value!r}; expected one of {list(allowed)}")
        self.subject = self._subject_for_kind()

    def _subject_for_kind(self) -> str:
        subject = str(self.subject or "").strip()
        if self.kind in USER_KINDS:
            # Corrected, not refused: a caller passing a slug for a preference
            # meant the preference, and the slug is meaningless for it.
            return USER
        if self.kind in SLUG_KINDS:
            if not subject or subject == USER:
                raise InvalidMemory(
                    f"a {self.kind!r} memory needs a project slug as its subject; "
                    "the core tier and recall both select these by slug")
            if not _SLUG_RE.match(subject):
                raise InvalidMemory(
                    f"{subject!r} is not a project slug (lowercase letters, digits, dashes)")
            return subject
        return subject or USER      # unreachable: every kind is in one set

    @property
    def is_current(self) -> bool:
        return self.superseded_by is None

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Memory":
        return cls(**{k: d[k] for k in cls.__dataclass_fields__ if k in d})
```

- [ ] **Step 4: Run it, confirm green**

Run: `cd backend && .venv/bin/python -m unittest tests.test_memory_domain -v`
Expected: 9 tests pass.

- [ ] **Step 5: Write the failing store test**

```python
# backend/tests/test_memory_store.py
"""The memories table and its repository.

`embedding` is a BLOB and is deliberately NOT registered in _JSON_COLS:
sqlite3 maps `bytes` to a BLOB natively, and registering it would store the
repr of a bytes object with no error. `pinned` IS registered in _BOOL_COLS,
because without it `row.pinned is True` fails while `if row.pinned:` works.
"""
from __future__ import annotations

import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from yuri.domain.memory import Memory  # noqa: E402
from yuri.store.sqlite import SCHEMA_VERSION, SqliteStore  # noqa: E402


def vec(seed: float = 1.0) -> bytes:
    return struct.pack("<768f", *([seed] * 768))


class MemoryStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = SqliteStore(os.path.join(self.tmp.name, "y.db"))
        self.store.migrate()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.store.close)
        self.repo = self.store.memories

    def _add(self, body="a thing", **over) -> Memory:
        m = Memory(body=body, **{"kind": "fact", **over})
        self.repo.insert(m)
        return m

    def test_the_migration_ran(self):
        self.assertGreaterEqual(SCHEMA_VERSION, 5)
        self.assertEqual(self.store.settings.get("schema_version", 0), SCHEMA_VERSION)

    def test_a_memory_round_trips_through_sqlite(self):
        m = self._add("prefers short answers", kind="preference", pinned=True)
        back = self.repo.get(m.id)
        self.assertEqual(back, m)
        # The bool must come back a real bool, not 1.
        self.assertIs(back.pinned, True)

    def test_an_embedding_survives_as_bytes(self):
        m = self._add("with a vector")
        m.embedding = vec(0.5)
        self.repo.update(m)
        back = self.repo.get(m.id)
        self.assertIsInstance(back.embedding, bytes)
        self.assertEqual(len(back.embedding), 768 * 4)
        self.assertEqual(struct.unpack("<768f", back.embedding)[0], 0.5)

    def test_current_excludes_superseded(self):
        old = self._add("the old way")
        new = self._add("the new way")
        old.superseded_by = new.id
        self.repo.update(old)
        bodies = [m.body for m in self.repo.current()]
        self.assertIn("the new way", bodies)
        self.assertNotIn("the old way", bodies)

    def test_a_superseded_memory_is_still_readable_by_id(self):
        # Kept, not deleted: "you used to want X" is occasionally the answer.
        old = self._add("the old way")
        old.superseded_by = "whatever"
        self.repo.update(old)
        self.assertIsNotNone(self.repo.get(old.id))

    def test_superseded_of_lists_what_one_memory_replaced(self):
        new = self._add("the new way")
        for body in ("first try", "second try"):
            old = self._add(body)
            old.superseded_by = new.id
            self.repo.update(old)
        self.assertEqual({m.body for m in self.repo.superseded_of(new.id)},
                         {"first try", "second try"})

    def test_current_filters_by_kind_and_subject(self):
        self._add("a preference", kind="preference")
        self._add("about a project", kind="project", subject="yuri-code")
        self._add("about another", kind="project", subject="other-thing")
        self.assertEqual([m.body for m in self.repo.current(kinds=["preference"])],
                         ["a preference"])
        self.assertEqual([m.body for m in self.repo.current(kinds=["project"],
                                                            subjects=["yuri-code"])],
                         ["about a project"])

    def test_for_subject_returns_newest_first(self):
        first = self._add("older", kind="project", subject="p")
        first.created_at = "2020-01-01T00:00:00+00:00"
        self.repo.update(first)
        self._add("newer", kind="project", subject="p")
        self.assertEqual([m.body for m in self.repo.for_subject("p")][0], "newer")

    def test_needing_embedding_finds_only_the_unembedded_and_current(self):
        plain = self._add("no vector yet")
        done = self._add("has one")
        done.embedding = vec()
        self.repo.update(done)
        gone = self._add("superseded")
        gone.superseded_by = plain.id
        self.repo.update(gone)
        # A superseded row is never sent to her, so embedding it is spend for
        # nothing.
        self.assertEqual([m.body for m in self.repo.needing_embedding()], ["no vector yet"])

    def test_with_embeddings_returns_only_rows_that_can_be_scored(self):
        self._add("no vector")
        done = self._add("scoreable")
        done.embedding = vec()
        self.repo.update(done)
        self.assertEqual([m.body for m in self.repo.with_embeddings()], ["scoreable"])

    def test_by_body_finds_an_exact_current_duplicate(self):
        # The dedup no-op in spec §5.4 is built on this.
        m = self._add("exactly this")
        self.assertEqual(self.repo.by_body("exactly this").id, m.id)
        self.assertIsNone(self.repo.by_body("something else"))

    def test_by_body_ignores_a_superseded_duplicate(self):
        # Otherwise re-stating a preference you once retired would silently
        # revive the retired row instead of writing a current one.
        m = self._add("exactly this")
        m.superseded_by = "x"
        self.repo.update(m)
        self.assertIsNone(self.repo.by_body("exactly this"))

    def test_count_counts_current_memories(self):
        self._add("one")
        gone = self._add("two")
        gone.superseded_by = "x"
        self.repo.update(gone)
        self.assertEqual(self.repo.count(), 1)

    def test_deleting_a_memory_removes_it(self):
        m = self._add("temporary")
        self.repo.delete(m.id)
        self.assertIsNone(self.repo.get(m.id))
```

- [ ] **Step 6: Run it, confirm it fails**

Run: `cd backend && .venv/bin/python -m unittest tests.test_memory_store`
Expected: `AttributeError: 'SqliteStore' object has no attribute 'memories'`

- [ ] **Step 7: Write migration 0005**

```sql
-- backend/yuri/store/migrations/0005_memories.sql
-- One thing Yuri remembers. Replaces ~/Yuri/memory/*.md as the read path;
-- the files themselves are never touched (spec §8) and are imported once by
-- yuri/services/legacy_memory.py, which cannot live here because SQL cannot
-- read a directory.
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  source TEXT NOT NULL,
  origin TEXT NOT NULL,
  -- No REFERENCES memories(id): a superseding row can be written in the same
  -- transaction as the row it supersedes, and the mission-delete regression
  -- (Phase 7) is a standing reminder that a foreign key nobody cascades is a
  -- 500 waiting to happen. Integrity here is one service's job, not sqlite's.
  superseded_by TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  -- 768 float32 little-endian, or NULL until the background embedder runs.
  embedding BLOB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The core tier's query: current rows, by kind, by subject (spec §4.1).
CREATE INDEX memories_current ON memories(kind, subject) WHERE superseded_by IS NULL;
-- The background embedder's query.
CREATE INDEX memories_unembedded ON memories(created_at)
  WHERE embedding IS NULL AND superseded_by IS NULL;
-- The dedup no-op's lookup (spec §5.4).
CREATE INDEX memories_body ON memories(body) WHERE superseded_by IS NULL;
-- The panel's superseded-history view.
CREATE INDEX memories_superseded ON memories(superseded_by);
```

- [ ] **Step 8: Add the repo interface**

In `backend/yuri/store/base.py`, add before `class Store`:

```python
class MemoryRepo(ABC):
    @abstractmethod
    def insert(self, m: Memory) -> None: ...
    @abstractmethod
    def get(self, id: str) -> Memory | None: ...
    @abstractmethod
    def update(self, m: Memory) -> None: ...
    @abstractmethod
    def delete(self, id: str) -> None: ...
    @abstractmethod
    def current(self, kinds: list[str] | None = None, subjects: list[str] | None = None,
                limit: int = 200) -> list[Memory]:
        """Non-superseded memories, newest first. `kinds`/`subjects` are ORed
        within themselves and ANDed with each other."""
    @abstractmethod
    def for_subject(self, subject: str, limit: int = 200) -> list[Memory]: ...
    @abstractmethod
    def superseded_of(self, id: str) -> list[Memory]:
        """What this memory replaced — the panel's history view."""
    @abstractmethod
    def needing_embedding(self, limit: int = 50) -> list[Memory]:
        """Current rows with no vector. Superseded rows are excluded: they are
        never sent to her, so embedding them is spend for nothing."""
    @abstractmethod
    def with_embeddings(self, limit: int = 10_000) -> list[Memory]: ...
    @abstractmethod
    def by_body(self, body: str) -> Memory | None:
        """An exact CURRENT duplicate, for the §5.4 no-op."""
    @abstractmethod
    def count(self) -> int: ...
```

Add `memories: MemoryRepo` to the `Store` protocol/ABC alongside `artifacts`, and
`from yuri.domain.memory import Memory` to the imports.

- [ ] **Step 9: Implement the sqlite repo**

In `backend/yuri/store/sqlite.py`:

```python
# with the other imports
from yuri.domain.memory import Memory
from .base import MemoryRepo   # add to the existing .base import list

SCHEMA_VERSION = 5             # was 4

# `pinned` joins the bool registry. `embedding` joins NEITHER registry:
# sqlite3 maps bytes to a BLOB natively, and putting it in _JSON_COLS would
# store the repr of a bytes object with no error at all.
_BOOL_COLS = {"auto_approve_edits", "speakable", "builtin", "archived", "read_only", "pinned"}


class SqliteMemories(_Base, MemoryRepo):
    table, cls = "memories", Memory

    def delete(self, id):
        self._c.get().execute("DELETE FROM memories WHERE id = ?", (id,))

    def current(self, kinds=None, subjects=None, limit=200):
        where, args = ["superseded_by IS NULL"], []
        if kinds:
            where.append(f"kind IN ({', '.join('?' * len(kinds))})")
            args.extend(kinds)
        if subjects:
            where.append(f"subject IN ({', '.join('?' * len(subjects))})")
            args.extend(subjects)
        return self._many(
            f"SELECT * FROM memories WHERE {' AND '.join(where)} "
            f"ORDER BY created_at DESC LIMIT ?", (*args, limit))

    def for_subject(self, subject, limit=200):
        return self._many(
            "SELECT * FROM memories WHERE subject = ? AND superseded_by IS NULL "
            "ORDER BY created_at DESC LIMIT ?", (subject, limit))

    def superseded_of(self, id):
        return self._many("SELECT * FROM memories WHERE superseded_by = ? "
                          "ORDER BY created_at DESC", (id,))

    def needing_embedding(self, limit=50):
        return self._many(
            "SELECT * FROM memories WHERE embedding IS NULL AND superseded_by IS NULL "
            "ORDER BY created_at DESC LIMIT ?", (limit,))

    def with_embeddings(self, limit=10_000):
        return self._many(
            "SELECT * FROM memories WHERE embedding IS NOT NULL AND superseded_by IS NULL "
            "ORDER BY created_at DESC LIMIT ?", (limit,))

    def by_body(self, body):
        return self._one("SELECT * FROM memories WHERE body = ? AND superseded_by IS NULL "
                         "LIMIT 1", (" ".join(str(body or "").split()),))

    def count(self):
        return self._c.get().execute(
            "SELECT COUNT(*) FROM memories WHERE superseded_by IS NULL").fetchone()[0]
```

Wire it in `SqliteStore.__init__`: `self.memories = SqliteMemories(self._conn)`.

- [ ] **Step 10: Run both tests, confirm green**

Run: `cd backend && .venv/bin/python -m unittest tests.test_memory_domain tests.test_memory_store -v`
Expected: 23 tests pass.

- [ ] **Step 11: Run the whole suite — the SCHEMA_VERSION bump touches every store test**

Run: `cd backend && .venv/bin/python -m unittest discover -s tests -q`
Expected: OK. If a test asserts `SCHEMA_VERSION == 4`, update it to the constant rather than the literal.

- [ ] **Step 12: Commit**

```bash
git add backend/yuri/domain/memory.py backend/yuri/store/ backend/tests/test_memory_domain.py backend/tests/test_memory_store.py
git commit -m "feat(memory): the memories table, its row and its repository"
```

---
## Task 2: Import the existing markdown, once

**Files:** Create `backend/yuri/services/legacy_memory.py`; Modify `backend/yuri/app.py` (call it from `startup()`); Test `backend/tests/test_legacy_memory.py`

**Interfaces:**
- Consumes: `Store` (Task 1), `Home`.
- Produces: `import_legacy(store, home) -> dict` returning
  `{"imported": int, "skipped": int, "already_done": bool}`;
  `IMPORT_FLAG = "memory_import_done"` (a `settings` key).
- `DATED_LINE = re.compile(r"^-\s+(\d{4}-\d{2}-\d{2})\s+(.+)$")`

**Why Python and not the migration:** `migrate()` runs `.sql` files only and
has no `Home`; SQL cannot read a directory. Guarded by a settings flag rather
than by the schema version, so re-running is a no-op even after a later
migration bumps the version.

**Tests** (`test_legacy_memory.py`), each named for what it proves:
- `test_it_imports_dated_lines_from_user_md` — 3 real-shaped lines become 3 `fact`/`stated`/`user` rows.
- `test_the_original_date_is_preserved` — `created_at` is the line's date, not today. Spec §3: "you told me this in September" is part of what the memory means.
- `test_the_header_and_prose_are_not_imported` — `user.md`'s "# What Yuri knows about you" and its explanatory paragraph must not become memories.
- `test_project_files_become_project_memories_under_their_slug` — `projects/yuri-code.md` → `kind="project"`, `subject="yuri-code"`.
- `test_a_file_whose_name_is_not_a_slug_is_skipped_not_crashed` — counted in `skipped`.
- `test_it_does_not_guess_preference_vs_fact` — a line reading like a rule still lands as `fact`. Spec §8: a migration that guessed at what a rule means would be worse.
- `test_running_it_twice_imports_nothing_the_second_time` — the flag.
- `test_the_markdown_files_are_never_modified` — byte-compare before and after. Spec §8.
- `test_an_absent_memory_dir_is_not_an_error` — a fresh install imports nothing and sets the flag.
- `test_a_duplicate_line_in_the_file_becomes_one_memory` — the §5.4 no-op applies to the import too.

**Wiring:** in `startup()`, after `build_container`, before `c.mcp.start_all()`:
wrap in `try/except` and log — an import that fails must not stop the backend,
and the flag is only set on success so the next start retries.

- [ ] **Steps: write the tests, run (fail), implement, run (pass), full suite, commit**

```bash
git commit -m "feat(memory): import the existing markdown once, and never touch the files again"
```

---

## Task 3: The core tier — selection and rendering

**Files:** Create `backend/yuri/services/recollection.py`; Test `backend/tests/test_core_tier.py`

**Interfaces:**
- Consumes: `MemoryRepo`, `Memory`.
- Produces (module constants and two pure functions):
  - `CORE_BUDGET_CHARS = 2000`, `CORE_DAYS = 3`
  - `SOURCE_PHRASE = {"stated": "you told me", "observed": "happened", "inferred": "I think"}`
  - `select_core(rows: list[Memory], project_slugs: list[str], budget: int = CORE_BUDGET_CHARS) -> tuple[list[Memory], int]` → the chosen rows and **how many were left out**
  - `render_core(chosen: list[Memory], omitted: int) -> str`
  - `core_block(repo, project_slugs) -> str` — the one impure entry point, `select_core` + `render_core`

**Selection order (spec §4.1), and it is the whole point of the task:**
1. every `pinned`
2. every current `preference` — **exempt from the budget**
3. current `fact` under `user`, newest first
4. current `project` for `project_slugs`
5. the last `CORE_DAYS` `day` summaries

**Tests** (`test_core_tier.py`):
- `test_a_pinned_memory_is_always_first`
- `test_every_preference_is_included_even_past_the_budget` — 50 preferences of 100 chars each all appear with `budget=200`. THE test: silently dropping "always ask before cancelling" is the failure this replaces.
- `test_facts_are_included_newest_first_until_the_budget`
- `test_the_omitted_count_is_what_did_not_fit` — and `render_core` prints it.
- `test_the_block_names_how_many_it_left_out` — asserts the literal phrase "more memories not shown" and that it mentions recall.
- `test_two_hundred_memories_produce_a_bounded_block` — **the regression guard for the bug that started this phase.** Asserts `len(block) < budget * 2` (preferences are exempt, so the bound is not the budget itself) and that nothing is cut mid-word.
- `test_no_memory_is_ever_truncated_mid_line` — the `"r 15"` failure. A memory is included whole or not at all.
- `test_project_facts_only_for_the_named_slugs`
- `test_only_the_last_three_days_appear`
- `test_superseded_rows_are_never_selected`
- `test_the_three_sources_render_as_three_different_phrases` — `stated`/`observed`/`inferred` produce distinguishable text.
- `test_an_empty_store_renders_nothing_misleading` — no "WHAT YOU REMEMBER" heading with nothing under it.

- [ ] **Steps: write the tests, run (fail), implement, run (pass), commit**

```bash
git commit -m "feat(memory): the core tier — bounded, preference-exempt, and it says what it left out"
```

---

## Task 4: Supersede resolution

**Files:** Modify `backend/yuri/services/recollection.py`; Test `backend/tests/test_supersede.py`

**Interfaces:**
- Produces `resolve_replaces(phrase: str, rows: list[Memory]) -> Memory` — raises
  `ValueError` on no match (listing the current memories) and on ambiguity
  (listing what matched, and telling the caller to ask which).
- Matching order, mirroring `_resolve_task` in `tools.py`: exact id → exact
  body (case-insensitive) → unique substring → word overlap with stopwords
  removed.

**Reuse note:** `tools.py` already defines `STOPWORDS` for the spoken-step
matcher. Import it rather than defining a second list — two stopword lists
that drift is how "run the tests" matched every step.

**Tests** (`test_supersede.py`):
- `test_an_exact_body_wins_over_a_substring`
- `test_a_unique_substring_resolves` — "the bit about language" finds the language preference.
- `test_an_ambiguous_phrase_refuses_and_lists_what_matched` — and the message says to ask which.
- `test_a_phrase_matching_nothing_lists_the_current_memories`
- `test_an_empty_phrase_asks_which`
- `test_stopwords_alone_never_match` — "the thing" must not resolve.
- `test_it_uses_the_same_stopwords_as_the_task_matcher` — asserts identity with `tools.STOPWORDS`, so they cannot drift.
- `test_a_superseded_row_is_never_a_candidate` — you cannot replace something already replaced.

- [ ] **Steps: write the tests, run (fail), implement, run (pass), commit**

```bash
git commit -m "feat(memory): she says what a memory replaces, in words, and the backend refuses to guess"
```

---

## Task 5: The embedding service

**Files:** Create `backend/yuri/services/embedding.py`; Test `backend/tests/test_embedding.py`

**Interfaces:**
- `EMBED_MODEL = "gemini-embedding-001"`, `EMBED_DIMS = 768`, `EMBED_TIMEOUT_S = 20`
- `class EmbeddingUnavailable(RuntimeError)` — the named type, so the caller can degrade rather than fail (spec §4.2).
- `class Embedder(Protocol)`: `async def embed(self, texts: list[str]) -> list[bytes]`
- `class GeminiEmbedder`: the one HTTP call, `httpx`, `batchEmbedContents` for >1.
- `class FakeEmbedder`: deterministic from the text's hash, for tests. **Not a mock** — a real implementation of the interface, so the code under test runs unchanged.
- `pack(values: list[float]) -> bytes` / `unpack(blob: bytes) -> array.array` — `struct`-based, little-endian, `EMBED_DIMS` enforced.
- `cosine(a: bytes, b: bytes) -> float` — vectors are stored **L2-normalised**, so this is a dot product. Normalising on the way IN is what makes search 31ms instead of 60.
- `MEASURED` docstring block recording the numbers from spec §7.1, so the next person does not re-measure to find out whether 768 was a guess.

**Tests** (`test_embedding.py`), all against `FakeEmbedder` plus pure functions:
- `test_pack_and_unpack_round_trip`
- `test_a_wrong_length_vector_is_refused` — a 3072-dim reply must not be silently stored.
- `test_cosine_of_a_vector_with_itself_is_one`
- `test_cosine_of_orthogonal_vectors_is_zero`
- `test_stored_vectors_are_normalised` — asserts `pack` normalises, since `cosine` depends on it.
- `test_a_missing_key_raises_the_named_type_with_an_actionable_message` — mirrors `own/search.py`: "GEMINI_API_KEY isn't set in backend/.env".
- `test_an_upstream_error_body_is_never_relayed` — plant a secret in a 403 body, assert it does not survive. The same test shape that caught the search tool.
- `test_the_fake_is_deterministic_and_the_right_shape`
- `test_similar_text_scores_higher_than_unrelated_text_under_the_fake` — so recall tests can assert ranking without the network.

- [ ] **Steps: write the tests, run (fail), implement, run (pass), commit**

```bash
git commit -m "feat(memory): embeddings behind an interface, normalised on the way in"
```

---

## Task 6: Recall — cheap path, then semantic, then degraded

**Files:** Modify `backend/yuri/services/recollection.py`; Test `backend/tests/test_recall.py`

**Interfaces:**
- `RECALL_MAX = 5`, `RECALL_BODY_MAX = 300`, `SEMANTIC_SCAN_MAX = 10_000`
- `async def recall(repo, embedder, query: str, subject: str | None = None, since: str | None = None) -> dict`
  returning `{"results": [...], "matched": int, "how": "filtered" | "semantic" | "keyword", "degraded": bool, "message": str}`
- Each result: `{"body", "kind", "source", "when", "said"}` where `said` is the
  attributed phrasing — "you told me on 2 Sep" / "I noticed on 3 Sep".

**The three paths, in order:**
1. **filtered** — a `subject` or `since` narrows it enough that SQL answers (measured 0.22ms). No embedding at all.
2. **semantic** — embed the query, score `with_embeddings()` rows by cosine.
3. **keyword** — `EmbeddingUnavailable`: substring-and-recency over the same rows, `degraded: True`, and the message SAYS the ranking is not semantic.

**Tests** (`test_recall.py`):
- `test_a_subject_filter_answers_without_embedding` — assert the FakeEmbedder was never called. The performance guarantee, as a test.
- `test_a_since_filter_answers_without_embedding`
- `test_a_fuzzy_query_uses_the_semantic_path`
- `test_no_embedder_falls_back_to_keyword_and_says_it_is_degraded` — asserts `degraded` and that the message mentions it.
- `test_results_are_capped_and_report_the_true_total` — 40 matches → 5 results, `matched: 40`. "Top 5 of 40" must never read as "there were 5".
- `test_a_long_body_is_clipped`
- `test_each_result_is_attributed_by_its_source` — three sources, three phrasings.
- `test_superseded_memories_never_appear` — history is the panel's job, not hers.
- `test_an_unembedded_row_is_still_findable_by_the_cheap_path` — the §7.2 promise: findable immediately, semantically searchable a second later.
- `test_the_semantic_scan_is_bounded` — with `SEMANTIC_SCAN_MAX` lowered, only that many rows are scored, and the result says so rather than implying it searched everything.
- `test_a_write_is_never_refused_for_being_the_ten_thousandth` — belongs here because it is the same constant; asserts `insert` succeeds past the cap.

- [ ] **Steps: write the tests, run (fail), implement, run (pass), commit**

```bash
git commit -m "feat(memory): recall — cheap path first, semantic when it must, honest when degraded"
```

---

## Task 7: The background embedder

**Files:** Create `backend/yuri/services/embed_worker.py`; Modify `backend/yuri/app.py`; Test `backend/tests/test_embed_worker.py`

**Interfaces:**
- `class EmbedWorker`: `start()`, `stop()`, `async def drain(limit: int = 50) -> int`
- `EMBED_BATCH = 10`, `EMBED_IDLE_S = 5.0`
- On the container as `Container.embedder_worker`; started in `startup()` after
  `dispatcher.start()`, stopped in `shutdown()` **before** the store closes.

**Why a worker and not inline:** spec §7.2. Inline embedding makes "remember I
prefer X" pause 1.4s before "Noted."

**Tests** (`test_embed_worker.py`):
- `test_it_embeds_rows_that_have_no_vector`
- `test_it_batches_rather_than_calling_once_per_row` — count the FakeEmbedder's calls.
- `test_an_embedder_failure_leaves_the_row_alone_and_retries_next_drain` — a `NULL` embedding is recoverable; a wrong one is not.
- `test_it_never_raises_into_startup` — an embedder that always fails must not stop the backend.
- `test_stop_is_safe_when_it_was_never_started` — mirrors every other lifecycle object in this codebase.
- `test_a_superseded_row_is_not_embedded` — spend for nothing.
- `test_draining_twice_does_nothing_the_second_time`

- [ ] **Steps: write the tests, run (fail), implement, run (pass), full suite, commit**

```bash
git commit -m "feat(memory): embed in the background, so remembering never makes her pause"
```

---

## Task 8: rollup.py — day summaries and observed memories

**Files:** Create `backend/yuri/services/rollup.py`; Modify `backend/yuri/app.py`; Test `backend/tests/test_rollup.py`

**Interfaces:**
- `DAY_SUMMARY_MODEL = "gemini-2.5-flash"`, `DAY_SUMMARY_MAX = 400`, `ROLLUP_DAYS_BACK = 14`
- `class Summariser(Protocol)`: `async def summarise(self, text: str) -> str`; `GeminiSummariser`, `FakeSummariser`
- `async def roll_days(store, home, summariser) -> int` — for each past day with a journal and no `day` memory, write one. Idempotent.
- `def roll_observations(store) -> int` — read the event log, write `observed` memories. Idempotent via the §5.4 identical-body no-op.
- `OBSERVATIONS`: the closed set of patterns it will derive, each with the events it reads:
  - a task that failed the same check twice → `verification.failed` twice, same `task_id` + `check`
  - a check that could never run → `verification.failed` with verdict `unavailable`
  - a mission returned to repeatedly → ≥3 `mission.status_changed` into `running` for one mission

**Why the event log and not a bus subscriber:** spec §5.3. A subscriber would
have to infer "twice" from one event, which means holding state, which means
being wrong after a restart.

**Tests** (`test_rollup.py`):
- `test_a_past_day_with_a_journal_gets_one_summary`
- `test_today_is_not_summarised` — the day is not over; the core tier carries today's journal until it is.
- `test_a_day_that_already_has_a_summary_is_left_alone`
- `test_running_it_twice_writes_nothing_new` — idempotence, both halves.
- `test_a_summariser_failure_skips_that_day_and_says_so_in_the_log` — and the next startup retries.
- `test_the_summary_is_bounded`
- `test_a_repeated_verification_failure_becomes_one_observed_memory` — and its `subject` is the project slug, not the mission id (Global Constraints).
- `test_a_single_failure_produces_no_memory` — "twice" means twice.
- `test_an_unavailable_check_becomes_its_own_observation` — distinct from a failure, because the remedy is different.
- `test_observed_memories_are_never_marked_stated` — the honesty rule as a test.
- `test_it_reads_no_more_than_fourteen_days_back`

- [ ] **Steps: write the tests, run (fail), implement, run (pass), full suite, commit**

```bash
git commit -m "feat(memory): roll up days and observations from history, idempotently"
```

---

## Task 9: The voice tools — `remember` rewritten, `recall` added

**Files:** Modify `backend/tools.py`; Test `backend/tests/test_memory_tools.py`

**Interfaces:**
- `remember(fact, project=None, replaces=None, inferred=False)` → writes a row.
  `tier: "safe"`, `category: "herself"`.
- `recall(query, project=None, since=None)` → Task 6's dict. Same tier/category.
- Result keys are a CONTRACT with the model (`tools.py`'s module docstring):
  `remember` → `{"remembered": bool, "body", "kind", "replaced": str | None, "message"}`.

**Tests** (`test_memory_tools.py`):
- `test_remember_writes_a_row_and_returns_immediately` — and asserts no embedder call, so the §7.2 promise holds at the tool boundary.
- `test_remember_with_replaces_supersedes_the_named_memory`
- `test_remember_with_an_ambiguous_replaces_is_a_soft_error_listing_what_matched`
- `test_remember_the_same_thing_twice_is_a_no_op_that_says_so`
- `test_remember_with_inferred_marks_the_source_not_the_body` — she must not write "I think that..." into the body; the column carries it.
- `test_remember_with_a_project_files_it_under_the_slug`
- `test_remember_with_an_unknown_project_is_a_soft_error_naming_the_real_ones`
- `test_recall_returns_attributed_results`
- `test_recall_with_no_matches_says_so_rather_than_returning_nothing`
- `test_both_tools_declare_tier_and_category`
- `test_neither_tool_reaches_the_model_carrying_tier` — `tools_for_model()` strips them.
- `test_no_voice_tool_can_delete_a_memory` — asserted against the real `TOOL_DEFINITIONS`, the same shape as the no-voice-tool-creates-a-specialist test. Deleting a memory on a mishearing is not recoverable.
- `test_tools_py_still_never_reaches_into_the_store` — the existing architectural test must stay green; the new tools go through the service.

- [ ] **Steps: write the tests, run (fail), implement, run (pass), full suite, commit**

```bash
git commit -m "feat(memory): she can remember properly, and reach for what she knows"
```

---

## Task 10: The HTTP surface

**Files:** Modify `backend/yuri/api/routes.py`, `backend/yuri/api/schemas.py`; Test `backend/tests/test_memory_api.py`

**Endpoints:**
```
GET    /yuri/memories                 current, grouped, + the core-tier budget report
POST   /yuri/memories                 create
PUT    /yuri/memories/{id}            edit body/kind/pinned
DELETE /yuri/memories/{id}            hard delete (the panel is the only place this exists)
POST   /yuri/memories/{id}/supersede  {"by": "<id>"} or {"body": "..."} creating the replacement
GET    /yuri/memories/{id}/history    what this memory replaced
POST   /yuri/memories/search          recall, for the panel's search box
```

**Tests** (`test_memory_api.py`):
- `test_the_listing_reports_which_memories_are_not_reaching_her` — the budget indicator's data. Spec §6.
- `test_create_read_update_delete`
- `test_supersede_by_a_new_body_creates_the_replacement_and_links_it`
- `test_history_returns_what_was_replaced`
- `test_an_unknown_id_is_a_404_everywhere`
- `test_an_invalid_kind_is_a_400_naming_the_value` — `InvalidMemory` → 400, not 500. The Phase 7 lesson.
- `test_search_answers_without_a_key` — degraded, 200, and says so.
- `test_every_route_is_behind_require_auth` — the existing sweep covers it; raise its floor.

- [ ] **Steps: write the tests, run (fail), implement, run (pass), full suite, commit**

```bash
git commit -m "feat(memory): the HTTP surface, including which memories are not reaching her"
```

---

## Task 11: Her prompt stops carrying the journal tail

**Files:** Modify `backend/yuri/api/routes.py` (`/context`), `frontend/lib/instructions.ts`, `frontend/lib/instructions.test.ts`

**The change:** `/context` returns `memory_core: str` (Task 3's rendered
block) in place of `memory_user` and `journal_today`. `yuriContextBlock`
renders it under WHAT YOU REMEMBER ABOUT THEM and drops the YOUR DAY SO FAR
tail. Today's journal is reachable through `recall`.

**Tests** (extend `instructions.test.ts`):
- `test the core block is rendered where memory used to be`
- `test an empty core block does not render a heading with nothing under it`
- `test the raw journal is no longer in the block` — asserts the absence, so a revert is caught.
- `test the block is smaller than what it replaced` — measured: 2,405 chars of memory+journal becomes at most 2,000.
- Keep every existing assertion in that file green.

- [ ] **Steps: write the tests, run (fail), implement, run (pass), commit**

```bash
git commit -m "feat(memory): the core tier replaces the journal tail in her prompt"
```

---

## Task 12: The Memory panel

**Files:** Create `frontend/lib/memory.ts`, `frontend/lib/memory.test.ts`, `frontend/app/memory/page.tsx`, `frontend/components/MemoryList.tsx`, `frontend/components/MemoryForm.tsx`; Modify `frontend/components/shell/Rail.tsx`, `frontend/app/globals.css`

**`lib/memory.ts` (pure, so `node --test` reaches it):**
- `KINDS`, `SOURCES`, `KIND_LABEL`, `SOURCE_LABEL` — "you told me" / "happened" / "she thinks"
- `validateMemory(form) -> FieldErrors`
- `groupByKind(rows) -> [kind, rows][]` in display order
- `rowActions(row) -> {edit, pin, unpin, supersede, delete}` — a pinned row offers Unpin, a superseded row offers no Supersede
- `budgetSummary(report) -> {used, budget, omitted, tone}`

**Tests** (`memory.test.ts`): the enums match the backend; every kind and source has a label; a pinned row offers Unpin and not Pin; a superseded row offers no Supersede; the budget summary reads as a warning only when something is omitted; validation refuses an empty body, an unknown kind, and a project memory with no slug.

**Rail:** a ninth item, `/memory`, plain-word label "Memory".

- [ ] **Steps: write lib + tests, run (fail), implement, run (pass), build, verify in the browser, commit**

Browser verification is required, not optional: create a memory, see it listed, pin it, supersede it, confirm the history view, and confirm `GET /yuri/memories` agrees.

```bash
git commit -m "feat(memory): the Memory panel, and a ninth rail item"
```

---

## Task 13: Live verification

**Files:** Create `docs/yuri/memory-verification.md`

Against the real key and a copy of the real database: import the user's actual
`user.md`; embed a real memory and confirm the vector's shape and timing;
recall by filter (no embedding) and by meaning (embedding), recording both
latencies; roll up a real past journal into a `day` summary; confirm the
markdown files are byte-identical afterwards; confirm the core block is smaller
than the 2,405 chars it replaced. **What was measured, not what was expected.**

```bash
git commit -m "docs(memory): live verification against the real store"
```

---

## Self-review

**Spec coverage.** §3 → Task 1. §4.1 → Tasks 3, 11. §4.2 → Task 6. §5.1 →
Tasks 4, 9. §5.2 → Tasks 10, 12. §5.3 → Task 8. §6 → Task 12. §7.1 → Task 5.
§7.2 → Tasks 7, 9. §8 → Task 2. §9 → every task's file list. §10 → every
task's tests + Task 13.

**Two gaps found while reviewing and closed above:** the background embedder
had no home (§7.2 requires it and no task owned it) — it is now Task 7. And
`recall` needed the model to be *unable* to delete a memory; that was in
neither spec nor plan, and is now an asserted test in Task 9, matching the
existing no-voice-tool-creates-a-specialist guard.

**One risk carried, not solved.** Spec §7.4: she may over-use `recall`. No
task fixes it because no test can catch it — it shows up as her being slow in
conversation. Watch for it during Task 13 and treat the fix as prompt work.
