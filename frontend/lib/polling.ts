// When to stop polling a session.
//
// The loop in VoiceProvider treated every unusable response as "still
// working" and kept asking every 1.5 seconds, forever. Two things made that
// possible: `callTool` returns `data?.result`, so a soft error ({ok:false})
// arrives as `undefined` with the reason discarded, and the loop's own
// `catch` said "transient; keep polling" about every failure alike.
//
// The observed cost was 329 activity-log events for one stopped session,
// repeating indefinitely — burying real events and spending tokens on a
// question that can never be answered differently.
//
// Pure so `node --test` can reach it; the loop keeps the timer, this decides.

/** Consecutive unusable responses before we give up on a session that is not
 *  saying anything we can act on. At the loop's 1.5s interval this is roughly
 *  twelve seconds — long enough to ride out a backend restart, short enough
 *  that a dead session stops being asked about. */
export const MAX_UNANSWERED_POLLS = 8;

/** How often a session is polled, and how long one poll may take.
 *
 *  The loop used to be a bare `setInterval`, which fires on schedule whether
 *  or not the previous poll returned. When the server slowed past the
 *  interval -- a Next dev-mode recompile is enough -- every session
 *  accumulated one more outstanding request every tick, forever. Three
 *  sessions produced seventeen pending requests, which exhausts the browser's
 *  six-connection-per-origin budget and starves the whole app, page loads
 *  included.
 *
 *  Two things stop that: one poll per session in flight at a time, and a
 *  bound on how long a poll may hold a connection. `/api/tools/execute`
 *  allows 800s for turns that legitimately run for minutes, which is the
 *  right ceiling for a real tool call and catastrophic for a heartbeat.
 */
export const POLL_INTERVAL_MS = 1500;
export const POLL_TIMEOUT_MS = 10_000;

/** The raw shape /api/tools/execute returns. `result` is absent on a soft
 *  error, which is exactly the case the old code could not see. */
export type ToolEnvelope = {
  ok?: boolean;
  error?: string;
  result?: { status?: string; [k: string]: unknown };
} | null | undefined;

export type PollVerdict =
  | { action: "wait" }
  | { action: "handle" }
  | { action: "stop"; reason: string };

// A session the backend no longer knows about will never start answering, so
// retrying is not resilience — it is a loop with no exit. Matched on the
// message because the tool layer reports these as soft errors (plain strings
// the voice model reads aloud) rather than typed codes.
const GONE = /\b(unknown session|no such session|session not found|already closed|is closed|not running)\b/i;

/** What the poll loop should do next.
 *
 *  `unanswered` is how many consecutive responses have already been unusable;
 *  the caller keeps that count and resets it whenever this returns anything
 *  other than a `wait` caused by an unusable response.
 */
export function pollVerdict(env: ToolEnvelope, unanswered: number): PollVerdict {
  const soft = env && env.ok === false;
  if (soft) {
    const message = String(env.error || "").trim();
    if (GONE.test(message)) {
      return { action: "stop", reason: message || "the session is gone" };
    }
    return unanswered + 1 >= MAX_UNANSWERED_POLLS
      ? { action: "stop", reason: `${MAX_UNANSWERED_POLLS} polls in a row failed: ${message || "no reason given"}` }
      : { action: "wait" };
  }

  const status = env?.result?.status;
  if (status === "working") return { action: "wait" };
  // `idle` means the backend's queue is drained — the one clean exit.
  if (status === "idle") return { action: "stop", reason: "idle" };
  if (typeof status === "string" && status) return { action: "handle" };

  // No error, no status: nothing to act on. Counted, not trusted — this is the
  // response the old loop mistook for "still working".
  return unanswered + 1 >= MAX_UNANSWERED_POLLS
    ? { action: "stop", reason: `${MAX_UNANSWERED_POLLS} polls in a row returned nothing usable` }
    : { action: "wait" };
}

/** The running count of unusable responses after this verdict. */
export function nextUnanswered(env: ToolEnvelope, unanswered: number): number {
  const usable = env && env.ok !== false && typeof env.result?.status === "string";
  return usable ? 0 : unanswered + 1;
}
