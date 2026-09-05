// When SetupGate should retry reaching the backend, and what to say while it
// waits.
//
// SetupGate used to fall through to the real app the moment the backend was
// unreachable (`if (!reachable || dismissed) return <>{children}</>`) — a
// shipped bug, and also the exact case this file exists for. The one-window
// boot means the frontend is on screen well before the backend answers, so
// "unreachable" is now the ordinary first few seconds of most boots, not
// only a broken install. A poll loop has to get two things right for that:
// back off (the backend's own cold start — config, MCP connect, tmux
// rehydration — measures 6-16s; a naive 250ms poll would fire 24-64 requests
// for nothing) and eventually give up (a genuinely broken install must not
// sit on "Starting Yuri…" forever).
//
// Pure so `node --test` reaches it — there is no DOM test environment.

/** Delay before the first retry (attempt 1). The very first check, attempt
 *  0, runs immediately on mount — the backend may already be up. */
const FIRST_DELAY_MS = 300;
/** Geometric growth factor between one retry and the next. */
const GROWTH = 1.6;
/** The delay never grows past this — a long wait still checks a few times
 *  every ten seconds rather than tailing off to almost nothing. */
export const MAX_DELAY_MS = 3000;

/** How long to keep retrying before calling the backend unreachable.
 *  Roughly double the slow end of the measured 6-16s cold start, so a
 *  merely-slow machine is never told it's broken. */
export const GIVE_UP_AFTER_MS = 30_000;

/** Delay in ms before retry attempt `n` (1-indexed: `n=1` is the delay
 *  before the first retry, after the immediate attempt 0). Negative or zero
 *  `n` is treated as "before attempt 1" rather than throwing — the caller's
 *  own attempt counter starts at 0 for the initial, non-retry check. */
export function retryDelayMs(n: number): number {
  if (n < 1) return FIRST_DELAY_MS;
  return Math.min(Math.round(FIRST_DELAY_MS * GROWTH ** (n - 1)), MAX_DELAY_MS);
}

/** Whether `elapsedMs` (time since the first check) is past the give-up
 *  bound. A separate function, not just inlined into `waitPhase`, because
 *  the caller also needs it to decide whether to schedule another retry at
 *  all. */
export function shouldGiveUp(elapsedMs: number): boolean {
  return elapsedMs >= GIVE_UP_AFTER_MS;
}

export type WaitPhase = "checking" | "waiting" | "failed";

/** What SetupGate should show. `attempt` is how many checks have already
 *  happened (0 on the very first, pre-retry check); `elapsedMs` is time
 *  since that first check. Once given up, the phase stays "failed"
 *  regardless of `attempt` — there is no bound on how long a caller might
 *  (incorrectly) keep counting attempts after it should have stopped. */
export function waitPhase(attempt: number, elapsedMs: number): WaitPhase {
  if (shouldGiveUp(elapsedMs)) return "failed";
  return attempt === 0 ? "checking" : "waiting";
}

/** The line to show for each phase, in plain words — the reader does not
 *  know what a health check or a poll is.
 *
 *  Short, because the line is no longer carrying the whole splash on its
 *  own: the checklist beside it names what is still going and how long it
 *  has been going for (lib/bootRows.ts), so this does not have to hedge
 *  about cold starts taking a while. */
export function waitMessage(phase: WaitPhase): string {
  if (phase === "checking") return "Waking her up…";
  if (phase === "waiting") return "Warming up her backend.";
  return "Yuri's backend did not start.";
}
