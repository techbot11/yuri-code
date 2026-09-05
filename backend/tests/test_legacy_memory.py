"""Importing ~/Yuri/memory/*.md into the memories table, once (spec §8).

The rule that matters most here is the last test: the user's files are never
modified. They were handed to them as "plain markdown — edit or delete
anything you like", and a migration that rewrote them would be taking that
back without asking.
"""
from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from yuri.home import Home  # noqa: E402
from yuri.services.legacy_memory import IMPORT_FLAG, import_legacy  # noqa: E402
from yuri.store.sqlite import SqliteStore  # noqa: E402

# The header ~/Yuri/memory/user.md really ships with, verbatim, so the test is
# about the file that exists rather than one invented for it.
REAL_USER_MD = """# What Yuri knows about you

Plain markdown. Yuri appends dated lines here when you tell her to remember
something; edit or delete anything you like.

- 2026-09-04  Always ask for confirmation before cancelling a mission or stopping work in a session.
- 2026-09-04  Always communicate in English or Gujarati.
- 2026-09-03  Do not mix English and Gujarati; stick to one language throughout a conversation.
"""


class LegacyImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Home(os.path.join(self.tmp.name, "Yuri")).ensure()
        self.store = SqliteStore(self.home.db_path)
        self.store.migrate()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.store.close)

    def _write_user(self, text: str = REAL_USER_MD) -> None:
        with open(self.home.user_memory_path, "w", encoding="utf-8") as f:
            f.write(text)

    def _write_project(self, slug: str, text: str) -> str:
        path = os.path.join(self.home.projects_memory_dir, f"{slug}.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def _bodies(self, **filters):
        return sorted(m.body for m in self.store.memories.current(**filters))

    # --- what comes in ------------------------------------------------------

    def test_it_imports_dated_lines_from_user_md(self):
        self._write_user()
        out = import_legacy(self.store, self.home)
        self.assertEqual(out["imported"], 3)
        rows = self.store.memories.current()
        self.assertEqual(len(rows), 3)
        for m in rows:
            self.assertEqual((m.kind, m.source, m.origin, m.subject),
                             ("fact", "stated", "ui", "user"))

    def test_the_original_date_is_preserved(self):
        # "You told me this in September" is part of what the memory means.
        self._write_user()
        import_legacy(self.store, self.home)
        dates = {m.created_at[:10] for m in self.store.memories.current()}
        self.assertEqual(dates, {"2026-09-04", "2026-09-03"})

    def test_the_header_and_prose_are_not_imported(self):
        self._write_user()
        import_legacy(self.store, self.home)
        bodies = " ".join(self._bodies())
        self.assertNotIn("What Yuri knows", bodies)
        self.assertNotIn("Plain markdown", bodies)
        self.assertNotIn("edit or delete anything", bodies)

    def test_project_files_become_project_memories_under_their_slug(self):
        self._write_project("yuri-code", "# Project notes: yuri-code\n\n"
                                         "- 2026-09-01  The frontend has no jsdom harness.\n")
        out = import_legacy(self.store, self.home)
        self.assertEqual(out["imported"], 1)
        [m] = self.store.memories.current(kinds=["project"])
        self.assertEqual((m.kind, m.subject), ("project", "yuri-code"))
        self.assertIn("jsdom", m.body)

    def test_a_file_whose_name_is_not_a_slug_is_skipped_not_crashed(self):
        self._write_project("Not A Slug", "- 2026-09-01  something\n")
        out = import_legacy(self.store, self.home)
        self.assertEqual(out["imported"], 0)
        self.assertEqual(out["skipped"], 1)

    def test_it_does_not_guess_preference_vs_fact(self):
        # Spec §8: a migration that guessed at what a rule means would be
        # worse than one that files everything as a fact and lets the panel
        # fix it in one click.
        self._write_user()
        import_legacy(self.store, self.home)
        self.assertEqual(self.store.memories.current(kinds=["preference"]), [])
        self.assertEqual(len(self.store.memories.current(kinds=["fact"])), 3)

    # --- idempotence and safety --------------------------------------------

    def test_running_it_twice_imports_nothing_the_second_time(self):
        self._write_user()
        first = import_legacy(self.store, self.home)
        second = import_legacy(self.store, self.home)
        self.assertEqual(first["imported"], 3)
        self.assertEqual(second["imported"], 0)
        self.assertTrue(second["already_done"])
        self.assertEqual(len(self.store.memories.current()), 3)

    def test_the_flag_is_only_set_on_success(self):
        # A failed import must retry at the next startup rather than being
        # recorded as done.
        self._write_user()
        broken = object()          # not a Store; the first write will raise
        with self.assertRaises(Exception):
            import_legacy(broken, self.home)
        self.assertEqual(self.store.settings.get(IMPORT_FLAG, ""), "")

    def test_the_markdown_files_are_never_modified(self):
        # THE test. Spec §8.
        self._write_user()
        p2 = self._write_project("yuri-code", "- 2026-09-01  a note\n")
        def digest(path: str) -> str:
            with open(path, "rb") as f:
                return hashlib.sha256(f.read()).hexdigest()
        before = {p: digest(p) for p in (self.home.user_memory_path, p2)}
        import_legacy(self.store, self.home)
        after = {p: digest(p) for p in before}
        self.assertEqual(before, after)

    def test_an_absent_memory_dir_is_not_an_error(self):
        import shutil
        shutil.rmtree(self.home.memory_dir)
        out = import_legacy(self.store, self.home)
        self.assertEqual(out["imported"], 0)
        self.assertTrue(self.store.settings.get(IMPORT_FLAG, ""))

    def test_a_duplicate_line_in_the_file_becomes_one_memory(self):
        self._write_user("- 2026-09-01  the same thing\n- 2026-09-02  the same thing\n")
        out = import_legacy(self.store, self.home)
        self.assertEqual(out["imported"], 1)
        self.assertEqual(out["skipped"], 1)

    def test_a_line_that_is_not_dated_is_skipped(self):
        # Anything the user hand-wrote in another shape stays in the file,
        # which is still theirs, rather than being imported as a mystery.
        self._write_user("- just a bullet\n- 2026-09-01  a real one\n")
        out = import_legacy(self.store, self.home)
        self.assertEqual(out["imported"], 1)
