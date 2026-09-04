"""The core tier: what is ALWAYS in her prompt (spec §4.1).

Two tests here are the reason the phase exists:

  * `test_every_preference_is_included_even_past_the_budget` — silently
    dropping "always ask before cancelling a mission" is the failure this
    replaces.
  * `test_two_hundred_memories_produce_a_bounded_block` and
    `test_no_memory_is_ever_truncated_mid_line` — the old tail cap returned
    `"r 15"` for 19 facts, cutting the survivor mid-line with no trace.
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from yuri.domain.memory import Memory  # noqa: E402
from yuri.services.recollection import (CORE_BUDGET_CHARS, CORE_DAYS,  # noqa: E402
                                        SOURCE_PHRASE, render_core, select_core)


def mem(body: str, kind: str = "fact", **over) -> Memory:
    m = Memory(body=body, kind=kind, **over)
    return m


def dated(body: str, day: int, kind: str = "fact", **over) -> Memory:
    m = mem(body, kind, **over)
    m.created_at = f"2026-09-{day:02d}T12:00:00+00:00"
    return m


class SelectionTests(unittest.TestCase):
    def test_a_pinned_memory_is_always_first(self):
        rows = [mem("ordinary"), mem("important", pinned=True)]
        chosen, _ = select_core(rows, [])
        self.assertEqual(chosen[0].body, "important")

    def test_every_preference_is_included_even_past_the_budget(self):
        # THE test. Preferences are behavioural rules; a rule that applies
        # only when it fits is not a rule.
        rows = [mem(f"rule number {i} " + "x" * 90, kind="preference") for i in range(50)]
        chosen, omitted = select_core(rows, [], budget=200)
        self.assertEqual(len(chosen), 50)
        self.assertEqual(omitted, 0)

    def test_facts_are_included_newest_first_until_the_budget(self):
        rows = [dated("f" * 60 + f" {i}", day=i + 1) for i in range(20)]
        chosen, omitted = select_core(rows, [], budget=200)
        self.assertGreater(omitted, 0)
        # Newest first: day 20 is in, day 1 is not.
        bodies = " ".join(m.body for m in chosen)
        self.assertIn(" 19", bodies)
        self.assertNotIn(" 0", bodies)

    def test_the_omitted_count_is_what_did_not_fit(self):
        rows = [dated("f" * 60 + f" {i}", day=i + 1) for i in range(20)]
        chosen, omitted = select_core(rows, [], budget=200)
        self.assertEqual(len(chosen) + omitted, 20)

    def test_no_memory_is_ever_truncated_mid_line(self):
        # The "r 15" failure: a memory is included whole or not at all.
        rows = [dated("a complete sentence that must not be cut " + str(i), day=i + 1)
                for i in range(30)]
        chosen, _ = select_core(rows, [], budget=300)
        block = render_core(chosen, 0)
        for m in chosen:
            self.assertIn(m.body, block, "a selected memory was cut")

    def test_two_hundred_memories_produce_a_bounded_block(self):
        # The regression guard. Against the old code this returned a 4000-char
        # tail beginning mid-word.
        rows = ([mem(f"rule {i}", kind="preference") for i in range(5)]
                + [dated(f"fact number {i} " + "y" * 40, day=(i % 28) + 1) for i in range(195)])
        chosen, omitted = select_core(rows, [])
        block = render_core(chosen, omitted)
        self.assertGreater(omitted, 0)
        # Preferences are exempt, so the bound is not the budget itself — but
        # it must be a small multiple of it, not a function of the store size.
        self.assertLess(len(block), CORE_BUDGET_CHARS * 2)

    def test_project_facts_only_for_the_named_slugs(self):
        rows = [mem("about this one", kind="project", subject="yuri-code"),
                mem("about that one", kind="project", subject="something-else")]
        chosen, _ = select_core(rows, ["yuri-code"])
        self.assertEqual([m.body for m in chosen], ["about this one"])

    def test_project_facts_are_dropped_when_no_project_is_active(self):
        # Not an omission to report: a project's notes are irrelevant when
        # nothing is running in it, and counting them as "not shown" would
        # invite her to recall things nobody asked about.
        rows = [mem("about this one", kind="project", subject="yuri-code")]
        chosen, omitted = select_core(rows, [])
        self.assertEqual(chosen, [])
        self.assertEqual(omitted, 0)

    def test_only_the_last_three_days_appear(self):
        rows = [dated(f"day {i} happened", day=i, kind="day") for i in range(1, 11)]
        chosen, _ = select_core(rows, [])
        days = [m for m in chosen if m.kind == "day"]
        self.assertEqual(len(days), CORE_DAYS)
        self.assertIn("day 10", days[0].body)

    def test_superseded_rows_are_never_selected(self):
        # select_core is given rows from repo.current(), but it must not rely
        # on the caller for this — a superseded memory reaching her prompt is
        # the "both versions of a preference" bug returning.
        rows = [mem("current"), mem("retired", superseded_by="x")]
        chosen, _ = select_core(rows, [])
        self.assertEqual([m.body for m in chosen], ["current"])


class RenderTests(unittest.TestCase):
    def test_the_block_names_how_many_it_left_out(self):
        block = render_core([mem("something")], omitted=4)
        self.assertIn("4 more", block)
        self.assertIn("recall", block.lower())

    def test_it_says_nothing_about_omissions_when_there_are_none(self):
        block = render_core([mem("something")], omitted=0)
        self.assertNotIn("more", block)

    def test_the_three_sources_render_as_three_different_phrases(self):
        rows = [mem("you said this", source="stated"),
                mem("this happened", source="observed", kind="observation", subject="p"),
                mem("she thinks this", source="inferred")]
        block = render_core(rows, 0)
        phrases = {SOURCE_PHRASE[s] for s in ("stated", "observed", "inferred")}
        self.assertEqual(len(phrases), 3, "two sources share a phrase")
        for phrase in phrases:
            self.assertIn(phrase, block)

    def test_an_empty_store_renders_nothing_misleading(self):
        # No heading with nothing under it, and no invitation to recall
        # something that does not exist.
        block = render_core([], 0)
        self.assertNotIn("more", block)
        self.assertEqual(block.strip(), "")

    def test_a_pinned_memory_is_not_labelled_as_pinned(self):
        # Pinning is a decision about the BUDGET, not a fact about the memory.
        # Telling her something is pinned invites her to mention it.
        block = render_core([mem("important", pinned=True)], 0)
        self.assertNotIn("pinned", block.lower())
