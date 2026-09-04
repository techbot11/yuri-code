# Memory — live verification

**Date:** 2026-09-05 · **Spec:** `docs/superpowers/specs/2026-09-04-yuri-memory-design.md`

Run against the real `GEMINI_API_KEY` and a **copy of the user's actual
`~/Yuri`** — the real `memory/user.md` and both real journal files. What was
measured, not what was expected.

---

## The import

```
memory: imported 3 line(s) from …/memory, skipped 0
```

The three real lines came in as `fact`/`stated`/`user` with their original
dates. Deliberately NOT classified as preferences: the import does not guess
what a rule means (spec §8), and all three of these ARE rules, to be flipped
in the panel.

**The files were not touched.** `diff -r` against the untouched original:
`memory/` IDENTICAL, `journal/` IDENTICAL.

## The rollup

```
memory: rolled up 2 day(s) and 0 observation(s)
```

Both real journals were summarised by `gemini-2.5-flash`. What it wrote,
verbatim:

> **2026-09-04** — They spent the day working on a "Yuri" project, attempting
> to make code improvements and create a landing page. Many of their missions
> were cancelled or paused throughout the day, suggesting workflow issues.

> **2026-09-03** — They spent the day starting, pausing, and cancelling
> numerous missions related to projects, code, and a billing service
> migration. One dangerous operation was denied, and no missions appear to
> have been completed.

Both are accurate. The 09-04 summary independently noticed the
`start_mission` duplication bug from its symptoms in the log — "many of their
missions were cancelled or paused … suggesting workflow issues" — which is
exactly what happened that evening.

Zero observations, correctly: this database has no repeated verification
failure and no mission picked back up three times.

## What reaches her prompt

```
WHAT YOU REMEMBER ABOUT THEM:
- Always ask for confirmation before cancelling a mission or stopping work in a session. (you told me, 2026-09-04)
- Always communicate in English or Gujarati. (you told me, 2026-09-04)
- Do not mix English and Gujarati; stick to one language throughout a conversation. (you told me, 2026-09-04)
- They spent the day working on a "Yuri" project … (happened, 2026-09-04)
- They spent the day starting, pausing, and cancelling … (happened, 2026-09-03)

memory_core:   797 chars of a 2000 budget, 0 omitted, 5 total
journal_today: 0 chars (a fresh home has no journal for today yet)
```

Note the two phrasings: `you told me` for what the user said, `happened` for
what the log showed. Three sources, three phrases, so her guess and the
user's instruction cannot read alike.

**Yesterday is now reachable.** Before this, `/context` sent `journal_today`
only; `2026-09-03.md` sat on disk and nothing opened it.

## Recall by meaning

Three questions with almost nothing lexical in common with what they found:

| question | how | time | top result |
|---|---|---|---|
| "can I cancel work without checking with you first" | semantic | 906 ms | *Always ask for confirmation before cancelling a mission…* |
| "what language should we speak" | semantic | 858 ms | *Always communicate in English or Gujarati.* |
| "how did things go the day before yesterday" | semantic | 815 ms | the 2026-09-03 day summary |

The first is the one that matters: nothing connects "checking with you first"
to "ask for confirmation" lexically.

Each result carries its attribution — `you told me on 2026-09-04`,
`I saw on 2026-09-03` — so she relays them as things that were said.

**The cheap path**, measured separately in the same run: **2.3 ms** for a
question carrying a project, with no embedding call at all.

## Correcting a memory

Superseding the real "English or Gujarati" preference with "Gujarati only":

```
{"superseded": "0084d60d…", "by": "1930a17a…"}

current:   Always communicate in Gujarati only.
           Always ask for confirmation before cancelling a mission…
           Do not mix English and Gujarati; stick to one language…

history of the replacement:  ["Always communicate in English or Gujarati."]
```

The old one is gone from her prompt and still readable in the panel. Under
the old store, both versions would have sat in her prompt at once, with no
way to retire either.

---

## What this does NOT verify

- **The panel was not driven by hand here.** Its logic is covered by
  `frontend/lib/memory.test.ts` (16 tests) and the endpoints it calls are the
  ones exercised above.
- **No observation was produced**, because this database contains none of the
  three patterns. `test_rollup.py` covers each pattern against synthetic
  events; none has been seen on real data.
- **Whether she over-uses `recall`** (spec §7.4). That shows up as her being
  slow in conversation and no test can catch it. Still unknown.
