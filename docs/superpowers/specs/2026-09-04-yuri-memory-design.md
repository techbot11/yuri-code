# Yuri's Memory — Design Spec (Phase 8)

**Date:** 2026-09-04
**Base:** `main` at `eaf8c40` (Phase 7 merged)
**Supersedes:** the file-based `Memory` service (`yuri/services/memory.py`)
**Measured, not assumed:** every number in §4 and §7 came from a run against
the real key and the real database — see the inline figures.

---

## 1. Why

Her personality shipped in Phase 7. Her memory did not keep up, and the gap
is the next layer of the complaint that started that work: *"this doesn't feel
like my AI companion."* A companion who forgets is not one.

What she has today, verified by reading it:

```
~/Yuri/memory/user.md            3 dated lines, appended, read back as a blob
~/Yuri/memory/projects/*.md      same shape, per project
~/Yuri/journal/YYYY-MM-DD.md     one file per day
```

Four concrete failures, each reproduced rather than inferred:

1. **Project memory is write-only.** `Memory.read_project` has **zero
   callers** outside its own definition. She can file a fact under a project
   and never see it again.
2. **The 4000-char cap drops the OLDEST facts and cuts the survivor
   mid-line.** Run against 19 synthetic facts, the block began `"r 15"`. The
   user's own first memory — *"always ask for confirmation before cancelling
   a mission"* — is the first thing that would go.
3. **Yesterday is unreachable.** `/context` sends `journal_today` only.
   `2026-09-03.md` exists on disk and nothing opens it. Worse,
   `read_today_personal(cap=2000)` returned **exactly 2000** on a real day, so
   *today* is already being truncated too.
4. **Append-only, so nothing can be corrected.** A changed preference leaves
   both versions in her prompt, and she has no way to supersede or delete.

And one thing that is not a failure but a limit: she only remembers what she
is explicitly told.

---

## 2. Scope

**In:** facts that survive and can be corrected; days beyond today; memories
she forms from what happened; semantic recall over all of it; a panel to see
and edit everything.

**Out:** decay of old memories (§5.4 says why), similarity-based dedup (§5.4),
a vector database (§4 shows why none is needed), memory shared between users
(single-user by construction), and anything that edits the user's existing
markdown files (§8).

---

## 3. What a memory is

One table, `memories`, added by migration 0005.

| Column | Meaning |
|---|---|
| `id` | |
| `created_at` | When the memory was formed. **Preserved on import** and never changed, because "you told me this in September" is part of what the memory means. |
| `updated_at` | When the row was last edited, superseded or pinned. Distinct from `created_at` so the panel can order by either. |
| `body` | The text. One sentence. |
| `kind` | `preference` · `fact` · `observation` · `day` · `project` |
| `subject` | A **hard filter before similarity**, so recall about one project never scores the whole store. Defined per kind, with no other values allowed: `preference`/`fact`/`day` → `user`; `project` → the project slug; `observation` → the project slug of the mission it came from (the mission id goes in the body, so a slug filter still finds it). |
| `source` | `stated` (you said it) · `observed` (it verifiably happened) · `inferred` (she concluded it) |
| `origin` | `voice` · `ui` · `journal` · `mission`. Where it arrived from, which is a different question from whether you said it. |
| `superseded_by` | The id of the memory that replaced this one. `NULL` = current. |
| `pinned` | Always in the core tier, whatever the budget. |
| `embedding` | 768 float32 as a BLOB. `NULL` until embedded (§7.2). |

### 3.1 Three rules

1. **Superseding, not appending.** A memory that replaces another sets
   `superseded_by` on it; superseded rows stop being sent. They are **not
   deleted** — visible in the panel, marked, with what replaced them — because
   "you used to want X" is occasionally the thing you need.
2. **Nothing is dropped silently.** The core tier is selected by rule, and
   when it does not fit the block SAYS how many it left out. This is the
   direct fix for §1.2.
3. **The source is structural, not a promise.** The three values render as
   three different phrasings, so her guess and your instruction can never read
   alike.

### 3.2 What is deliberately absent

**A numeric confidence score.** An earlier draft had one. `source` already
carries the honest distinction; a number would be invented precision that she
would then assert as if it meant something.

---

## 4. Two tiers, and why

`/yuri/context` is fetched **exactly once, at connect**, and baked into
`instructions` (`VoiceProvider.tsx:1050`). There is no mid-conversation
refresh. That single fact decides the architecture:

**At connect there is no query.** She does not yet know whether the
conversation is about the billing bug or the weekend. Similarity search needs
something to be similar *to*, so "relevant at connect" collapses into
"recent" — which is what the current blob already does, with none of the
machinery. Retrieval therefore cannot live at connect.

Rejected alternatives, for the record:

- **Everything retrieved at connect** — fails on the above.
- **Everything retrieved, nothing unconditional** — a safety regression: if
  retrieval misses *"always ask before cancelling"*, she cancels without
  asking. A behavioural rule that applies conditionally is not a rule.

### 4.1 Tier one: the core

Always in her prompt. Budget **2000 chars** — about what memory + journal
occupy today (405 + 2000 of a measured 10,273-char prompt), spent on curated
memories instead of a log tail. Selected in this order:

1. Every `pinned` row.
2. Every current `preference`. **Exempt from the budget** — if preferences
   alone exceeded it they would still all go in and the panel would warn,
   because silently dropping a behavioural rule is the failure this replaces.
3. Current `fact` rows about `user`, newest first.
4. Current `project` facts **for the projects of active missions**. This is
   what finally makes project memory readable (§1.1).
5. The last **three** `day` summaries — "past days, not just today".

Whatever does not fit is counted and named: *"(4 more memories not shown —
ask me to recall them)"*. That ends the silent loss and advertises recall in
the same line.

**The raw journal leaves her prompt.** Once a day has a summary she does not
need 2000 chars of log tail; she needs today's summary, with the raw journal
reachable through recall. The block gets smaller and more useful at once.

### 4.2 Tier two: `recall`, a tool

`recall(query, subject?, since?)` → at most 5 memories, each with kind,
source and date, phrased as attribution: *"you told me on 2 Sep"* versus
*"I noticed on 3 Sep"*. It searches current rows; superseded history lives in
the panel, not in her answers. The result reports how many matched in total,
so "top 5 of 40" never reads as "there were 5".

**Cheap path first.** A query carrying a subject or a time window is answered
by SQL — measured **0.22 ms** — with no embedding at all. Only a genuinely
fuzzy query pays for an embedding. Most recalls are therefore instant.

**When embeddings are unavailable** (no key, API down) recall falls back to
keyword-and-recency over the same rows **and says it did**. Degraded, not
broken, and never silently pretending the ranking was semantic.

---

## 5. How a memory gets made

### 5.1 `voice` — you told her

The existing `remember` tool, now writing a row.

Replacement is decided **in words**: `remember(fact, replaces="the bit about
language")`. The backend resolves that phrase against current memories exactly
as `_resolve_task` resolves a spoken step — narrowest match first, **refusing
on ambiguity and listing what matched**.

Rejected: passing an id (clutters her prompt with ids) and inferring
replacement from similarity (needs the embedding, which is deliberately
asynchronous, and needs a threshold — a guess that silently merges two things
you meant to keep). Judging "this replaces that" is what a model is good at;
refusing to guess is what the backend is for.

### 5.2 `ui` — you typed it

The panel (§6). Add, edit, supersede, pin, delete.

### 5.3 `journal` and `mission` — unprompted

**`day` summaries.** One per date, summarised from that day's journal by a
Gemini flash call — the model `yuri/own/search.py` already uses. Run **in the
background at startup**, beside `reconcile()`, for any past day that has a
journal and no summary. Not at connect: a 1–3s model call is exactly what
connect must not carry. A day with no summary makes recall read the raw
journal file instead, so a gap degrades rather than hides.

**`observed` memories from missions.** Derived from events the engine already
publishes: a task that failed the same check twice, a verification that could
never run, a mission returned to repeatedly. Mechanical and verifiable, with
no inference about the user — which is where most of the value in
"unprompted" actually is, at no risk of her inventing something about you.

**Derived by `rollup.py`, reading the event log at startup — not by a bus
subscriber.** A subscriber would have to decide "failed the same check twice"
from a single event, which means holding state, which means being wrong after
a restart. Reading the log asks the question of the whole history at once,
lands off the hot path beside the day summaries, and is idempotent: the same
log produces the same memories, so a re-run writes nothing new (§5.4's
identical-body no-op).

**Genuine inference** goes through the same `remember` tool with
`source: "inferred"`, set by her, governed by her instructions rather than by
a separate mechanism. Inferred memories do reach the core tier — a memory
that influences nothing is not a memory — but they render as a guess and are
never auto-pinned.

### 5.4 Two mechanisms deliberately not built

- **Decay.** An inferred memory that quietly expires is worse than one you can
  see and delete: expiry hides a wrong guess instead of surfacing it.
- **Similarity-based dedup.** Identical bodies (whitespace-normalised) are a
  no-op that returns the existing row. Near-duplicates stay separate, because
  a wrong automatic merge destroys information while a visible duplicate
  merely annoys.

---

## 6. The panel

**A ninth rail item, "Memory."** The rail has held at eight, but that rule was
about not putting jargon beside plain words — "Memory" is a plain word and a
genuinely distinct thing, and the Dashboard route renders nothing (it is the
closed state of the panel), so there is no existing home.

Current memories, grouped by kind. Each row: body, subject, date, and its
source **in words** — "you told me" / "happened" / "she thinks". Per row:
edit, pin, supersede, delete. A toggle reveals superseded history with what
replaced what. You can add one by hand.

**A budget indicator showing which memories are not reaching her.** This is
§3.1's rule 2 made visible: today's silent truncation becomes something you
can see and fix by pinning.

Follows `docs/yuri/design/GUIDE.md`: a pinned row offers Unpin rather than a
disabled Pin, a superseded row offers no Supersede, empty reads differently
from failed, and no literal colours.

---

## 7. Bounds, and the numbers behind them

### 7.1 Measured

Against the real `GEMINI_API_KEY` and a 1,000-row table:

```
gemini-embedding-001, outputDimensionality=768   works (3072 default)
one embedding call                             1,370 ms   <- the only slow thing
batch of 10                                    2,200 ms
core-tier query over 1,000 memories                0.91 ms
filtered recall, no embedding                      0.22 ms
loading 1,000 vectors from sqlite                  1.37 ms
cosine over 1,000 x 768, pure Python              31 ms
cosine over 5,000 x 768                          157 ms
```

**No vector database, no numpy, no new dependency.** sqlite BLOBs and a dot
product. That holds to roughly 10,000 memories, at which point recall costs
300ms+ and the fix is numpy or `sqlite-vec` — not needed now, and named here
so the ceiling is known rather than discovered.

**A write is never refused for being the ten-thousandth.** An earlier draft
capped the table, which would mean declining to remember something because
the store was full — worse than a slower search. The bound is on the
SEMANTIC path only: beyond `SEMANTIC_SCAN_MAX` it scores the most recent rows
and says it did. The cheap path and the core tier are unaffected.

768 dimensions rather than the default 3072: 4x less storage and 4x faster
search, measured, for a store this size.

### 7.2 The two rules that keep her fast

1. **Writes never block.** `remember` writes the row and returns
   (sub-millisecond); embedding happens in the background. Inline embedding
   would leave her silent for 1.4s before saying "Noted." A row without an
   embedding is still findable by the cheap path, so a new memory is
   *findable* immediately and *semantically* searchable a second later.
2. **Recall tries the cheap path first** (§4.2), so the 1.4s is paid only when
   nothing cheaper could have answered.

Net: nothing in the everyday path slows down, and the one slow operation is
opt-in and behaves like `web_search` already does.

### 7.3 Constants

```python
CORE_BUDGET_CHARS = 2000        # tier one
RECALL_MAX = 5                  # results per recall
RECALL_BODY_MAX = 300           # per result
EMBED_DIMS = 768
EMBED_MODEL = "gemini-embedding-001"
EMBED_TIMEOUT_S = 20
DAY_SUMMARY_MODEL = "gemini-2.5-flash"
CORE_DAYS = 3                   # day summaries in the core tier
BODY_MAX = 500                  # one memory
SEMANTIC_SCAN_MAX = 10_000      # rows the semantic path will score (§7.1)
```

### 7.4 The risk to watch

**She may over-use recall.** Her persona already says *use the smallest thing
that answers the question*, but a tool that is cheap to call gets called, and
1.4s of silence per turn would be a real regression. If it happens the fix is
in her instructions, not the code — recorded here so it is not discovered as
a surprise.

---

## 8. Migration, and your existing files

Migration 0005 creates the table and imports:

- `user.md`'s dated lines → `fact`, `stated`, `subject=user`, original dates
  preserved.
- `memory/projects/*.md` → `project` facts, subject = the slug.

The import is **mechanical and does not guess `preference` vs `fact`**. The
user's three current lines are all really behavioural rules and will land as
`fact`, to be flipped in the panel in one click. A migration that guessed at
what a rule means would be worse.

**The files are never touched** — not deleted, not rewritten, not marked. They
simply stop being read, and each imported row records where it came from.
Journals keep being written exactly as now: they are the raw record and the
source for day summaries.

---

## 9. Where the code goes

| File | Responsibility |
|---|---|
| `yuri/store/migrations/0005_memories.sql` | The table, its indexes, and the import |
| `yuri/domain/memory.py` | `Memory` row, `KINDS`, `SOURCES`, `ORIGINS`, validation |
| `yuri/store/base.py`, `sqlite.py` | `MemoryRepo`: insert/get/update/current/for_subject/with_embeddings |
| `yuri/services/recollection.py` | Core-tier selection, supersede resolution, recall (cheap path, then semantic) |
| `yuri/services/embedding.py` | The one HTTP call, behind an interface so tests use a fake |
| `yuri/services/rollup.py` | The two unprompted paths, both run in the background at startup: journal → `day` summary, and the event log → `observed` memories. One module because both are "read history, write memories, idempotently". |
| `tools.py` | `remember` rewritten (writes a row, takes `replaces`); `recall` added. Both `tier: "safe"`, `category: "herself"` — she is the only one who uses them, and neither changes anything outside her own memory. |
| `yuri/api/routes.py` | `/yuri/memories` CRUD, `/yuri/memories/search` |
| `frontend/lib/memory.ts` | Core-tier rendering and form rules — pure, so `node --test` reaches it |
| `frontend/app/memory/page.tsx` | The panel |
| `frontend/lib/instructions.ts` | The core tier replaces `memory_user` + `journal_today` |

`yuri/services/memory.py` is **deleted** once the import lands, and
`Container.memory` goes with it. Its three callers move: `/yuri/context`'s
`memory_user` becomes the core tier, `read_project` had no callers at all
(§1.1), and the `remember` tool writes a row instead of appending a line.
Leaving it in place "until nothing calls it" would mean two stores that can
disagree, which is the failure §3.1's rule 1 exists to prevent.

---

## 10. Testing

**Pure, no database:** core-tier selection order; the budget; preferences
exempt from it; the "N more not shown" line; the three sources rendering
differently; supersede-phrase resolution **including its refusal on an
ambiguous phrase**.

**Against sqlite:** importing the user's real markdown; the dedup no-op;
superseded rows excluded from selection but present in history; the subject
filter.

**Embeddings behind an interface**, so tests use a fake. **One live run
recorded** in `docs/yuri/memory-verification.md` — what was measured, not what
was expected, the same discipline as `mcp-verification.md`.

**Recall:** the cheap path taken when a filter exists; the semantic path when
not; the keyword fallback with no key, **and that the fallback says it is
degraded**.

**Frontend, pure:** the panel's form rules in `lib/memory.ts`.

**The regression guard for the bug that started this:** 200 memories must
produce a bounded block that NAMES how many it left out. That test fails
against today's code, which returns `"r 15"`.
