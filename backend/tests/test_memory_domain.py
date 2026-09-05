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
