"""Resolving "the bit about language" to the memory it means (spec §5.1).

She judges that one memory replaces another; the backend's job is to refuse
when the phrase could mean two things. Same rule `_resolve_task` follows for
a spoken step, and it imports the SAME stopword list — two lists that drift is
how "run the tests" once matched every step in the plan.
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from yuri.domain.memory import Memory  # noqa: E402
from yuri.services.recollection import resolve_replaces  # noqa: E402


def mem(body: str, **over) -> Memory:
    return Memory(body=body, kind=over.pop("kind", "preference"), **over)


ROWS = [
    mem("Always communicate in English or Gujarati"),
    mem("Do not mix English and Gujarati in one conversation"),
    mem("Always ask before cancelling a mission"),
    mem("Prefers short answers"),
]


class ResolveTests(unittest.TestCase):
    def test_an_exact_id_resolves(self):
        self.assertIs(resolve_replaces(ROWS[2].id, ROWS), ROWS[2])

    def test_an_exact_body_wins_over_a_substring(self):
        rows = [mem("short"), mem("short answers please")]
        self.assertIs(resolve_replaces("short", rows), rows[0])

    def test_a_unique_substring_resolves(self):
        self.assertIs(resolve_replaces("ask before cancelling", ROWS), ROWS[2])

    def test_it_is_case_insensitive(self):
        self.assertIs(resolve_replaces("PREFERS SHORT ANSWERS", ROWS), ROWS[3])

    def test_an_ambiguous_phrase_refuses_and_lists_what_matched(self):
        # "Gujarati" is in two memories. Picking one would retire the wrong
        # rule, silently.
        with self.assertRaises(ValueError) as ctx:
            resolve_replaces("Gujarati", ROWS)
        msg = str(ctx.exception)
        self.assertIn("English or Gujarati", msg)
        self.assertIn("Do not mix", msg)
        self.assertIn("ask which", msg.lower())

    def test_a_phrase_matching_nothing_lists_the_current_memories(self):
        with self.assertRaises(ValueError) as ctx:
            resolve_replaces("something about deployment", ROWS)
        self.assertIn("Prefers short answers", str(ctx.exception))

    def test_an_empty_phrase_asks_which(self):
        for bad in ("", "   ", None):
            with self.assertRaises(ValueError) as ctx:
                resolve_replaces(bad, ROWS)
            self.assertIn("which", str(ctx.exception).lower())

    def test_stopwords_alone_never_match(self):
        # "the task" is nothing BUT stopwords, so the overlap pass has no
        # words left and must find nothing rather than everything.
        with self.assertRaises(ValueError) as ctx:
            resolve_replaces("the task", ROWS)
        self.assertNotIn("matches several", str(ctx.exception))

    def test_it_uses_the_same_stopwords_as_the_spoken_step_matcher(self):
        # Asserted by identity, so the two cannot drift apart.
        import tools
        from yuri.services import recollection
        self.assertIs(recollection.STOPWORDS, tools.STOPWORDS)

    def test_a_superseded_row_is_never_a_candidate(self):
        # You cannot replace something already replaced. Asked for by its
        # EXACT body, which would win the exact-match pass outright if it were
        # still a candidate — and the surviving row shares no meaningful word
        # with it, so nothing else can match either.
        rows = [mem("the retired rule", superseded_by="x"), mem("something else entirely")]
        with self.assertRaises(ValueError):
            resolve_replaces("the retired rule", rows)

    def test_a_word_overlap_resolves_when_it_is_unique(self):
        # Not a substring of anything — both words appear only in ROWS[2], so
        # this exercises the overlap pass rather than the substring pass.
        self.assertIs(resolve_replaces("mission cancelling", ROWS), ROWS[2])

    def test_no_candidates_at_all_says_there_is_nothing_to_replace(self):
        with self.assertRaises(ValueError) as ctx:
            resolve_replaces("anything", [])
        self.assertIn("nothing", str(ctx.exception).lower())
