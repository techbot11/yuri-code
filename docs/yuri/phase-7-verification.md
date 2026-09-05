# Phase 7 — live acceptance run

**Date:** 2026-09-05 · **Plan:** `docs/superpowers/plans/2026-09-04-yuri-phase-7.md` Task 16
**Subject:** a throwaway repo with a real bug — `has_cycle` shares its `visited`
set across branches, so an acyclic diamond reports a cycle. Two of its three
tests genuinely failed before the run.

Real `claude` 2.1.260, real `opencode serve` 1.18.27, real models. What was
measured, not what was expected.

---

## What it found

**Three bugs, all invisible to 1,548 passing tests, all now fixed.** Each was
invisible for the same reason: every workflow test used `FakeAgentProvider`,
which pushes events and always succeeds.

### 1. A mission with an OpenCode agent hung forever (`79feb32`)

OpenCode is poll-only — `supports_events=False`, and its `set_observer` stores
the callback and never invokes it. `SessionService.poll()` is what publishes
`session.turn_completed` for such a provider. `WorkflowDispatcher` is entirely
event-driven. **Nothing joined the two**, so the only poller in the system was
the browser's loop.

Observed: the researcher's turn ended 14 seconds in and the task was still
`dispatched` twenty minutes later.

A background mission that only runs in the foreground is not a background
mission. The driver now polls in-flight tasks whose provider cannot push.

### 2. A crashed turn was reported as a successful one (`67ddcf0`)

The completion check was `any(m.get("finish") for m in fresh)`. `finish` is
truthy either way — it is the string `"error"` on a failure. So this:

```json
{"type":"assistant","finish":"error","content":[],
 "error":{"message":"Invalid opencode/openai-compatible-chat stream event"}}
```

came back as `status: "completed"` with empty text.

**Live, that carried two workflow tasks to `completed` having changed
nothing.** `git status` was clean, the bug was still there, both steps green.
A task with no declared check has only the agent's word, and the agent's word
was a crash reported as success.

The only reason it was visible at all was the handoff's honest fallback:
*"the agent finished without producing any text at all"* — which is what
sent me looking.

### 3. An agent that died mid-task was never noticed (`67ddcf0`)

A tmux session Yuri started died seconds later; the task sat at `dispatched`
for ten minutes. Polling covers an agent that cannot TELL us it finished; this
is the other half — one that cannot tell us anything because it is gone.
Claude Code pushes events so it is excluded from polling, but a dead session
pushes nothing either, and `reconcile()` only looks at startup.

Fixing it exposed a fourth, smaller thing: the retry reused the DEAD session
row, because `_reusable()` picks the specialist's existing session. The row is
now marked lost before the failure is reported.

## What it confirmed

| Plan's check | Result |
|---|---|
| The OpenCode agent file is picked up by a real `POST /session {agent}` | **Yes.** The assistant message came back tagged `"agent": "researcher"` — the materialiser worked against a real server. |
| The handoff text actually reaches the agent | **Yes**, for the researcher. The session's user message was the rendered brief: `THE MISSION: … YOUR TASK: Find the root cause of: …` |
| `claude --agents <json>` is accepted by the installed version | **Partially.** The flag was accepted — no usage error — but the process then failed on authentication, so acceptance is not fully proven. |
| A real failing test drives the task to `failed` rather than `completed` | **Not reached.** See below. |

Recovery was also confirmed incidentally, which no test had done end to end
on real agents: after a restart, `rehydrate()` marked the dead session `lost`,
`reconcile()` re-queued the task, and `advance()` dispatched a FRESH Claude
Code session — attempt 2, new handle.

## Why it stopped

```
$ claude --model sonnet --permission-mode default --agents '…' --agent tester -p "say OK"
Failed to authenticate: OAuth session expired and could not be refreshed
```

**Not a Yuri bug.** The machine's Claude Code login has expired, so every
`claude` Yuri launches exits within seconds. Both Claude Code steps — the
tester and the reviewer — are blocked on that.

The two OpenCode steps ran against a free model
(`nemotron-3-ultra-free`) that errored on every turn, which is what surfaced
bug 2. A paid model would have produced real work.

## What remains unverified

- **The verification gate against a genuinely failing test.** This was the
  single most valuable check in the plan — a task must not complete when the
  suite is red — and it needs a working Claude Code login to reach.
- **`review_approved`**, for the same reason.
- **A handoff arriving at a LATER step.** Confirmed at step one only; both
  upstream agents produced no text, so there was nothing for step two to
  receive.

Re-run after `claude` is re-authenticated and with an OpenCode model that
works. The three fixes above stand on their own — each has tests that fail
without them.
