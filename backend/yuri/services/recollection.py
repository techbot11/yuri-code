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
from yuri.services.embedding import EmbeddingUnavailable, cosine

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


# --- recall (spec §4.2) -----------------------------------------------------
#
# Three paths, tried in order, because the cheap one is 6,000 times faster
# than the slow one (0.22ms of SQL against a 1,370ms embedding call):
#
#   filtered  a subject or a date window narrows it enough that SQL answers.
#   semantic  embed the query, score every embedded row by cosine.
#   keyword   the embedder is unavailable — substring and recency, and it SAYS
#             the ranking is not semantic rather than pretending.

RECALL_MAX = 5
RECALL_BODY_MAX = 300
# Rows the semantic path will score. A write is NEVER refused for being the
# ten-thousandth — declining to remember something because the store is full
# is worse than a slower search — so this bounds the scan only, and the result
# says when it was hit.
SEMANTIC_SCAN_MAX = 10_000

FILTERED, SEMANTIC, KEYWORD = "filtered", "semantic", "keyword"

_SAID = {
    "stated": "you told me",
    "observed": "I saw",
    "inferred": "I thought",
}


def _said(m: Memory) -> str:
    """How a result is attributed. Her prompt separates what was SAID from
    what was verified, and a memory is the former — so a result reads "you
    told me on 2 Sep", never as a bare assertion."""
    return f"{_SAID.get(m.source, 'you told me')} on {(m.created_at or '')[:10]}"


def _result(m: Memory) -> dict:
    body = m.body if len(m.body) <= RECALL_BODY_MAX else m.body[: RECALL_BODY_MAX - 1] + "…"
    return {"body": body, "kind": m.kind, "source": m.source,
            "when": (m.created_at or "")[:10], "said": _said(m),
            "about": m.subject if m.subject != "user" else None}


def _keywords(query: str) -> set[str]:
    low = "".join(c if c.isalnum() else " " for c in (query or "").lower())
    return {w for w in low.split() if len(w) > 2 and w not in STOPWORDS}


def _answer(rows: list[Memory], matched: int, how: str, degraded: bool,
            capped: int = 0) -> dict:
    out = {"results": [_result(m) for m in rows[:RECALL_MAX]],
           "matched": matched, "how": how, "degraded": degraded}
    if not rows:
        out["message"] = ("Nothing in memory matches that. Say so — do not invent "
                          "something that sounds like it might be there.")
        return out
    # "Top 5 of 40" must never read as "there were 5".
    more = (f" There are {matched} in total; these are the closest {len(out['results'])}."
            if matched > len(out["results"]) else "")
    warn = ("" if not degraded else
            " I could not search by meaning, so these are matched on words and "
            "recency — say that, and say the right one may not be here.")
    # `capped` is the scan limit, passed ONLY when the scan actually hit it.
    # An earlier version compared matched > scanned, which is never true when
    # the scan is what capped the count — so the bound never announced itself.
    limit = (f" I only looked at the {capped} most recent memories, so there may be older "
             f"ones I did not see." if capped else "")
    out["message"] = ("Read these back as things that were said, not as facts — each one "
                      "carries who said it and when." + more + warn + limit)
    return out


async def recall(repo, embedder, query: str, subject: str | None = None,
                 since: str | None = None) -> dict:
    """Find memories. Cheap path first (spec §7.2).

    `subject` or `since` means SQL can answer it, and SQL is 0.22ms against a
    1.37s embedding call — so a question with either is never embedded at all.
    Only a genuinely fuzzy query pays.
    """
    query = " ".join(str(query or "").split())

    if subject or since:
        rows = repo.for_subject(subject) if subject else repo.current(limit=400)
        if since:
            rows = [m for m in rows if (m.created_at or "") >= since]
        if query:
            # Rank within the filter by word overlap. No embedding: the filter
            # has already done the narrowing that similarity would be for.
            words = _keywords(query)
            if words:
                rows = sorted(
                    rows,
                    key=lambda m: (len(words & _keywords(m.body)), m.created_at),
                    reverse=True)
        return _answer(rows, len(rows), FILTERED, degraded=False)

    if not query:
        # Nothing to filter on and nothing to be similar to. The most recent
        # is the only honest answer, and it says that is what it did.
        rows = repo.current(limit=RECALL_MAX)
        return _answer(rows, repo.count(), FILTERED, degraded=False)

    candidates = repo.with_embeddings(limit=SEMANTIC_SCAN_MAX)
    try:
        if embedder is None:
            raise EmbeddingUnavailable("no embedder is configured")
        [vector] = await embedder.embed([query])
    except EmbeddingUnavailable:
        # Degraded, not broken. Everything is still findable; the ranking is
        # just worse, and the caller is told so.
        words = _keywords(query)
        pool = repo.current(limit=400)
        hits = [m for m in pool
                if query.lower() in m.body.lower() or (words & _keywords(m.body))]
        hits.sort(key=lambda m: (len(words & _keywords(m.body)), m.created_at), reverse=True)
        return _answer(hits, len(hits), KEYWORD, degraded=True)

    scored: list[tuple[float, Memory]] = []
    for m in candidates:
        try:
            scored.append((cosine(vector, m.embedding), m))
        except EmbeddingUnavailable:
            # One malformed stored vector must not sink the whole search.
            continue
    scored.sort(key=lambda pair: pair[0], reverse=True)
    rows = [m for _, m in scored]
    # Asked for at most N and got exactly N: there may be more behind it, and
    # saying so is the difference between "these are the closest" and "these
    # are the closest of everything".
    hit_the_cap = len(candidates) >= SEMANTIC_SCAN_MAX
    return _answer(rows, len(rows), SEMANTIC, degraded=False,
                   capped=SEMANTIC_SCAN_MAX if hit_the_cap else 0)
