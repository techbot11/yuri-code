"""Shared helpers with no dependencies of their own.

`_tail` caps a read to the tail of a file. `STOPWORDS` is used by two
different fuzzy matchers — the spoken-step resolver in tools.py and the
supersede resolver in recollection.py — and lives here rather than in either
of them because two stopword lists that drift is how "run the tests" once
matched every step in a plan. tools.py re-exports it for its existing
callers.
"""
from __future__ import annotations


def _tail(text: str, cap: int) -> str:
    if cap <= 0:
        return ""
    return text if len(text) <= cap else text[-cap:]


# Words that carry no identifying information in a short spoken phrase. Without
# this, "run the tests" overlapped every title in the bug-fix template through
# "the", and every spoken reference came back ambiguous.
STOPWORDS: frozenset[str] = frozenset({
    "the", "and", "for", "with", "into", "that", "this", "from", "step",
    "task", "one", "its", "our", "any", "all", "out",
})
