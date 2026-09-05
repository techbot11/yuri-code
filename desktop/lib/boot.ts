// The boot sequencer's state, as data.
//
// Pure so `node --test` reaches it, and separate from the spawning because
// the sequencing is the part that can be subtly wrong: an app that reports
// "ready" while one server is dead hands the user a UI whose every action
// fails, which is worse than a boot screen that says what broke.

export type ChildName = "backend" | "frontend";
export type ChildState = "starting" | "ready" | "failed";

export type BootEvent =
  | { type: "ready"; child: ChildName }
  | { type: "failed"; child: ChildName; detail: string };

export type BootState = {
  backend: ChildState;
  frontend: ChildState;
  /** The FIRST failure. A later one is usually its consequence -- the
   *  frontend cannot proxy to a backend that never started. */
  error?: { child: ChildName; detail: string };
};

export function initialBoot(): BootState {
  return { backend: "starting", frontend: "starting" };
}

export function applyBootEvent(state: BootState, ev: BootEvent): BootState {
  const next: BootState = { ...state };
  if (ev.type === "ready") {
    // A child that already failed does not become ready: a health check can
    // answer moments after the process died and be restarted by nothing.
    if (next[ev.child] !== "failed") next[ev.child] = "ready";
    return next;
  }
  next[ev.child] = "failed";
  if (!next.error) next.error = { child: ev.child, detail: ev.detail };
  return next;
}

export function bootPhase(state: BootState): "starting" | "ready" | "failed" {
  if (state.error) return "failed";
  return state.backend === "ready" && state.frontend === "ready" ? "ready" : "starting";
}
