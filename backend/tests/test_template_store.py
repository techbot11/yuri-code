"""Editing a workflow template (the user asked for this).

Two rules do most of the work:

  * the git-tracked built-in templates are NEVER written to — a `git pull`
    would clobber an edit, and an app that rewrites its own source is an app
    whose diffs lie;
  * a save runs the SAME `loader.validate` the loader runs at startup, so a
    template that saves is a template that will still load. There is exactly
    one place that knows what a dependency cycle is.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from yuri.services.templates import TemplateStore  # noqa: E402
from yuri.workflows import loader  # noqa: E402
from yuri.workflows.loader import TemplateError  # noqa: E402

GOOD = {
    "description": "Look, then do.",
    "tasks": [
        {"id": "look", "role": "researcher", "title": "Look into it",
         "instruction": "Find out about {goal}.", "read_only": True},
        {"id": "do", "role": "developer", "title": "Do it",
         "instruction": "Fix {goal}.", "depends_on": ["look"]},
    ],
}


class TemplateStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.user_dir = os.path.join(self.tmp.name, "templates")
        self.store = TemplateStore(self.user_dir)
        self.addCleanup(self.tmp.cleanup)

    # --- reading ------------------------------------------------------------

    def test_the_builtins_are_there_with_no_user_dir_at_all(self):
        for name in ("bug-fix", "feature", "single"):
            self.assertIn(name, self.store.all())
        self.assertEqual(self.store.custom_names(), set())

    def test_a_new_name_is_added_to_the_set(self):
        self.store.save("my-plan", GOOD)
        self.assertIn("my-plan", self.store.all())
        self.assertIn("my-plan", self.store.custom_names())
        self.assertNotIn("my-plan", self.store.builtin_names())

    def test_a_user_template_overrides_the_builtin_of_the_same_name(self):
        before = self.store.all()["bug-fix"]
        self.assertEqual(len(before.tasks), 4)
        self.store.save("bug-fix", GOOD)
        after = self.store.all()["bug-fix"]
        self.assertEqual(len(after.tasks), 2)
        self.assertEqual(after.description, "Look, then do.")

    # --- the files that must not be touched ---------------------------------

    def test_the_git_tracked_templates_are_never_written_to(self):
        # THE rule.
        def digests():
            d = {}
            for f in sorted(os.listdir(loader._TEMPLATES_DIR)):
                if f.endswith(".json"):
                    with open(os.path.join(loader._TEMPLATES_DIR, f), "rb") as fh:
                        d[f] = hashlib.sha256(fh.read()).hexdigest()
            return d

        before = digests()
        self.store.save("bug-fix", GOOD)
        self.store.remove("bug-fix")
        self.assertEqual(before, digests())

    def test_a_save_writes_into_the_user_directory(self):
        self.store.save("my-plan", GOOD)
        self.assertTrue(os.path.exists(os.path.join(self.user_dir, "my-plan.json")))

    def test_a_save_leaves_no_temp_file_behind(self):
        self.store.save("my-plan", GOOD)
        self.assertEqual([f for f in os.listdir(self.user_dir) if f.endswith(".tmp")], [])

    # --- validation, which is the loader's -----------------------------------

    def test_a_dependency_cycle_is_refused_and_names_the_members(self):
        bad = {"tasks": [
            {"id": "a", "role": "developer", "title": "A", "instruction": "x",
             "depends_on": ["b"]},
            {"id": "b", "role": "developer", "title": "B", "instruction": "y",
             "depends_on": ["a"]}]}
        with self.assertRaises(TemplateError) as ctx:
            self.store.save("cyclic", bad)
        msg = str(ctx.exception)
        self.assertIn("a", msg)
        self.assertIn("b", msg)

    def test_an_unknown_role_is_refused(self):
        bad = {"tasks": [{"id": "a", "role": "wizard", "title": "A", "instruction": "x"}]}
        with self.assertRaises(TemplateError):
            self.store.save("bad-role", bad)

    def test_a_dependency_on_a_task_that_is_not_here_is_refused(self):
        bad = {"tasks": [{"id": "a", "role": "developer", "title": "A", "instruction": "x",
                          "depends_on": ["ghost"]}]}
        with self.assertRaises(TemplateError):
            self.store.save("dangling", bad)

    def test_an_unknown_verification_name_is_refused(self):
        bad = {"tasks": [{"id": "a", "role": "developer", "title": "A", "instruction": "x",
                          "verification": ["vibes_pass"]}]}
        with self.assertRaises(TemplateError):
            self.store.save("bad-check", bad)

    def test_too_many_tasks_is_refused(self):
        bad = {"tasks": [{"id": f"t{i}", "role": "developer", "title": f"T{i}",
                          "instruction": "x"} for i in range(loader.MAX_TASKS_PER_WORKFLOW + 1)]}
        with self.assertRaises(TemplateError):
            self.store.save("too-many", bad)

    def test_nothing_is_written_when_validation_fails(self):
        # A half-saved broken template would fail the NEXT startup's load,
        # which validates them all — so it would take every template with it.
        bad = {"tasks": [{"id": "a", "role": "wizard", "title": "A", "instruction": "x"}]}
        with self.assertRaises(TemplateError):
            self.store.save("bad-role", bad)
        self.assertFalse(os.path.exists(os.path.join(self.user_dir, "bad-role.json")))

    def test_a_saved_template_always_reloads(self):
        # The guarantee the shared validator buys.
        self.store.save("my-plan", GOOD)
        self.assertIn("my-plan", loader.load_templates(user_dir=self.user_dir))

    # --- names --------------------------------------------------------------

    def test_a_name_that_would_escape_the_directory_is_refused(self):
        for bad in ("../evil", "a/b", "..", "", "Not A Name", "with.dot"):
            with self.assertRaises(TemplateError):
                self.store.save(bad, GOOD)

    def test_the_path_name_wins_over_a_name_in_the_body(self):
        # A body that renamed itself would write one file and override a
        # different template — very hard to see afterwards.
        self.store.save("my-plan", {**GOOD, "name": "something-else"})
        self.assertEqual(self.store.all()["my-plan"].name, "my-plan")
        self.assertNotIn("something-else", self.store.all())

    # --- removing = reset ---------------------------------------------------

    def test_removing_an_override_brings_the_builtin_back(self):
        self.store.save("bug-fix", GOOD)
        self.assertEqual(len(self.store.all()["bug-fix"].tasks), 2)
        out = self.store.remove("bug-fix")
        self.assertTrue(out["reverted_to_default"])
        self.assertEqual(len(self.store.all()["bug-fix"].tasks), 4)

    def test_removing_a_user_only_template_deletes_it_entirely(self):
        self.store.save("my-plan", GOOD)
        out = self.store.remove("my-plan")
        self.assertTrue(out["removed"])
        self.assertFalse(out["still_exists"])
        self.assertNotIn("my-plan", self.store.all())

    def test_removing_something_that_was_never_customised_is_not_an_error(self):
        out = self.store.remove("bug-fix")
        self.assertFalse(out["removed"])
        self.assertTrue(out["still_exists"])
        self.assertIn("bug-fix", self.store.all())
