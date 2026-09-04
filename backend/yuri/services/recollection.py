"""What Yuri remembers, and how it reaches her (spec §4).

Two tiers, and the reason is a measured fact rather than a preference:
`/yuri/context` is fetched ONCE, at connect, and baked into her instructions.
**At connect there is no query** — she does not yet know whether the
conversation is about the billing bug or the weekend — so similarity search
has nothing to be similar to and "relevant" would collapse into "recent".

So:

  * The CORE TIER is selected by rule and always present. Small, bounded, and
    it says what it left out.
  * RECALL is a tool she calls mid-conversation, which is the only moment a
    similarity query actually exists.

`select_core` and `render_core` are pure so they can be tested without a
store; `core_block` is the one impure entry point.
"""
from __future__ import annotations

from yuri.domain.memory import Memory

# About what memory + journal occupy in her prompt today (405 + 2000 of a
# measured 10,273 chars), spent on curated memories instead of a log tail.
CORE_BUDGET_CHARS = 2000
CORE_DAYS = 3

# One phrase per source, and they must stay three DIFFERENT phrases: her guess
# and the user's instruction reading alike is the failure `source` exists to
# prevent. A test asserts they are distinct.
SOURCE_PHRASE: dict[str, str] = {
    "stated": "you told me",
    "observed": "happened",
    "inferred": "I think",
}

HEADING = "WHAT YOU REMEMBER ABOUT THEM:"
_OMITTED = ("({n} more {noun} not shown — use recall if the conversation needs "
            "something you cannot see here)")


def _fits(rows: list[Memory], budget: int) -> tuple[list[Memory], int]:
    """Take rows until the budget is spent. Whole rows only.

    A memory is included complete or not at all. The old implementation
    tail-capped the whole blob, which cut the first surviving memory mid-word
    — for 19 facts it produced a block beginning `"r 15"`.
    """
    kept: list[Memory] = []
    used = 0
    omitted = 0
    for m in rows:
        cost = len(m.body) + 24            # the rendered line's own overhead
        if used + cost > budget:
            omitted += 1
            continue
        kept.append(m)
        used += cost
    return kept, omitted


def select_core(rows: list[Memory], project_slugs: list[str],
                budget: int = CORE_BUDGET_CHARS) -> tuple[list[Memory], int]:
    """Choose what is always in her prompt, and count what did not fit.

    Order is spec §4.1, and the second entry is the one that matters:
    **preferences are exempt from the budget.** They are behavioural rules,
    and a rule that applies only when it fits is not a rule. If they ever
    exceed the budget alone they still all go in, and the panel's budget
    report is what tells the user their prompt is crowded.
    """
    # Defensive rather than trusting the caller: a superseded memory reaching
    # her prompt is the "both versions of a preference" bug coming back.
    current = [m for m in rows if m.is_current]
    slugs = set(project_slugs or ())

    pinned = [m for m in current if m.pinned]
    seen = {m.id for m in pinned}

    def rest(kind: str, subjects: set[str] | None = None) -> list[Memory]:
        out = [m for m in current
               if m.kind == kind and m.id not in seen
               and (subjects is None or m.subject in subjects)]
        # Newest first, so a budget spent early keeps the most recent.
        return sorted(out, key=lambda m: m.created_at, reverse=True)

    preferences = rest("preference")
    seen.update(m.id for m in preferences)

    # Everything below competes for what is left.
    facts = rest("fact")
    projects = rest("project", slugs) if slugs else []
    days = rest("day")[:CORE_DAYS]

    budgeted, omitted = _fits(facts + projects + days, budget)
    return pinned + preferences + budgeted, omitted


def _line(m: Memory) -> str:
    phrase = SOURCE_PHRASE.get(m.source, SOURCE_PHRASE["stated"])
    when = (m.created_at or "")[:10]
    where = f" · about {m.subject}" if m.subject != "user" else ""
    return f"- {m.body} ({phrase}, {when}{where})"


def render_core(chosen: list[Memory], omitted: int) -> str:
    """The block that goes in her prompt.

    Empty when there is nothing: a heading with nothing under it invites her
    to talk about the absence, and an invitation to recall something that does
    not exist is worse than silence.
    """
    if not chosen:
        return ""
    lines = [HEADING, *(_line(m) for m in chosen)]
    if omitted > 0:
        noun = "memory" if omitted == 1 else "memories"
        lines.append(_OMITTED.format(n=omitted, noun=noun))
    return "\n".join(lines)


def core_block(repo, project_slugs: list[str]) -> str:
    """The impure entry point: read the store, select, render."""
    rows = repo.current(limit=400)
    chosen, omitted = select_core(rows, project_slugs)
    return render_core(chosen, omitted)
