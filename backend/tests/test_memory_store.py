"""The memories table and its repository.

`embedding` is a BLOB and is deliberately NOT registered in _JSON_COLS:
sqlite3 maps `bytes` to a BLOB natively, and registering it would store the
repr of a bytes object with no error at all. `pinned` IS registered in
_BOOL_COLS, because without it `row.pinned is True` fails while
`if row.pinned:` works — the exact trap that registry's comment warns about.
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
        # A real bool, not 1 — see the module docstring.
        self.assertIs(back.pinned, True)

    def test_an_embedding_survives_as_bytes(self):
        m = self._add("with a vector")
        m.embedding = vec(0.5)
        self.repo.update(m)
        back = self.repo.get(m.id)
        self.assertIsInstance(back.embedding, bytes)
        self.assertEqual(len(back.embedding), 768 * 4)
        self.assertAlmostEqual(struct.unpack("<768f", back.embedding)[0], 0.5, places=6)

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
