import datetime
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from yuri.home import Home  # noqa: E402
from yuri.services.journal import Journal  # noqa: E402


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Home(os.path.join(self.tmp.name, "Yuri")).ensure()
        self.j = Journal(self.home)

    def tearDown(self):
        self.tmp.cleanup()

    def test_append_creates_dated_file_with_header(self):
        path = self.j.append("mission created: Fix it")
        today = datetime.date.today().isoformat()
        self.assertEqual(os.path.basename(path), f"{today}.md")
        with open(path) as f:
            text = f.read()
        self.assertTrue(text.startswith(f"# {today}\n"))
        self.assertRegex(text, r"\n- \d\d:\d\d  mission created: Fix it\n")
        self.j.append("second")
        self.assertIn("second", self.j.read_today())

    def test_read_today_caps_and_handles_missing(self):
        self.assertEqual(self.j.read_today(), "")
        self.j.append("x" * 5000)
        self.assertLessEqual(len(self.j.read_today(cap=100)), 100)

    def test_read_today_zero_and_negative_cap_return_empty(self):
        self.j.append("hello world")
        self.assertEqual(self.j.read_today(cap=0), "")
        self.assertEqual(self.j.read_today(cap=-1), "")

    def test_newlines_in_line_are_flattened(self):
        self.j.append("a\nb")
        self.assertIn("- ", self.j.read_today())
        self.assertNotIn("a\nb", self.j.read_today())

    def test_append_creates_journal_dir_if_missing(self):
        tmp2 = tempfile.TemporaryDirectory()
        try:
            home2 = Home(os.path.join(tmp2.name, "Yuri"))  # never ensure()d
            j2 = Journal(home2)
            path = j2.append("first ever line")
            self.assertTrue(os.path.exists(path))
        finally:
            tmp2.cleanup()


# The MemoryTests class that stood here tested yuri/services/memory.py, the
# append-only markdown writer. That service is deleted: memories are rows now
# (migration 0005), and the files are read once by legacy_memory.py and never
# written again.
#
# What its 19 tests protected, and where each property lives now:
#
#   * "a slug must be a slug" and path containment -> no longer reachable,
#     because nothing writes a path per memory. The slug rule itself is now
#     Memory.__post_init__'s subject validation, tested in
#     test_memory_domain.py (a project memory needs a slug, and "../etc" is
#     refused).
#   * reading a file's tail under a cap -> replaced by the core tier, which
#     selects whole memories by rule and SAYS what it left out, tested in
#     test_core_tier.py. That is the bug this phase existed to fix: the tail
#     cap dropped the oldest facts mid-line and kept 0 of 5 preferences.
#   * appending a dated line -> legacy_memory.py reads that shape back on
#     import, tested in test_legacy_memory.py against the user's real file.
