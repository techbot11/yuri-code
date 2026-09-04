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
from yuri.services._util import STOPWORDS

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


# --- supersede resolution (spec §5.1) --------------------------------------


def _preview(rows: list[Memory], limit: int = 6) -> str:
    shown = [f'"{m.body}"' for m in rows[:limit]]
    more = len(rows) - len(shown)
    return ", ".join(shown) + (f", and {more} more" if more > 0 else "")


def resolve_replaces(phrase: str, rows: list[Memory]) -> Memory:
    """Resolve "the bit about language" to the memory it means.

    She judges that one memory replaces another — that is what a model is
    good at. This function's job is the opposite: to REFUSE when the phrase
    could mean two things, because retiring the wrong rule is silent and
    permanent. Same rule and the same stopword list as `_resolve_task`'s
    spoken-step matcher.

    Narrowest match first, so a phrase that IS a memory resolves before the
    fuzzy pass runs at all.

    **The last pass is deliberately loose** — a single shared meaningful word
    resolves, so "the language thing" finds the language rule. That means it
    can also resolve "old rule" to "the current rule" on `rule` alone. The
    mitigation is not a tighter threshold (which would refuse real paraphrases)
    but visibility: the `remember` tool returns WHICH memory it replaced, so
    she says "I replaced X with Y" and a wrong resolution is audible
    immediately rather than discovered later in the panel.
    """
    candidates = [m for m in rows if m.is_current]
    if not candidates:
        raise ValueError("there is nothing in memory to replace yet.")

    ref = " ".join(str(phrase or "").split())
    if not ref:
        raise ValueError(
            "which memory should this replace? Name a few words from it, or leave "
            "replaces out to add this as a new memory.")

    for m in candidates:
        if m.id == ref:
            return m

    low = ref.lower()
    exact = [m for m in candidates if m.body.lower() == low]
    if len(exact) == 1:
        return exact[0]

    substring = [m for m in candidates if low in m.body.lower()]
    if len(substring) == 1:
        return substring[0]

    words = {w for w in low.replace(",", " ").replace(".", " ").split()
             if len(w) > 2 and w not in STOPWORDS}
    hits = substring or [m for m in candidates
                         if words and words & set(m.body.lower().split())]
    if not hits:
        raise ValueError(
            f"no memory matches {ref!r}. What you remember: {_preview(candidates)}.")
    if len(hits) > 1:
        raise ValueError(
            f"{ref!r} matches several memories: {_preview(hits)}. Read those back and "
            "ask which one they mean, then pass a phrase that picks just that one.")
    return hits[0]
