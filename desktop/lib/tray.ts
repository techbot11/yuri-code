// The tray's vocabulary: which states exist, and what each one is called.
//
// It does NOT decide which state to show. That rule lives in exactly one
// place -- frontend/lib/trayState.ts -- because only the renderer knows the
// facts it needs (the voice session's state, running missions, pending
// approvals). The renderer decides and sends the answer over the tray:state
// channel; main/tray.ts validates it against TRAY_STATES and renders it.
//
// This file used to carry a second implementation of that rule (trayState()
// over a TrayFacts struct), with a comment on each side claiming their tests
// cross-checked the two. Nothing called it, nothing compared them, and the
// ten tests over it passed for the wrong reason -- so it is gone.
//
// What remains is a real seam, and worth stating plainly: the TrayState union
// below and the one in frontend/lib/trayState.ts are INDEPENDENT declarations
// in two separately compiled processes. There is no compile-time link between
// them and no test can create one. A state added to the frontend's union and
// not to TRAY_STATES here is caught only at runtime, by setTrayState()
// logging what it rejected (main/tray.ts).
//
// Pure so `node --test` reaches it.

export type TrayState =
  "asleep" | "listening" | "thinking" | "speaking" | "working" | "needs-you";

/** The menu's first line. Plain words, never the slug. */
export function trayLabel(s: TrayState): string {
  switch (s) {
    case "needs-you": return "Waiting on you";
    case "working": return "Working on something";
    case "speaking": return "Speaking";
    // Not "Working on something" -- that means missions are running, a
    // different fact this tray also reports and must not be confused with.
    case "thinking": return "Thinking";
    case "listening": return "Listening";
    case "asleep": return "Asleep — not listening";
  }
}

/** Every state, once. A Record rather than an array so `tsc` enforces
 *  completeness: a member added to TrayState with no key here fails to
 *  compile, and a key that is not a member fails too. An array literal could
 *  not do that -- which is precisely how the old hand-maintained list was
 *  free to drift from the union it claimed to cover. */
const ALL_STATES: Record<TrayState, true> = {
  asleep: true, listening: true, thinking: true,
  speaking: true, working: true, "needs-you": true,
};

/** Every state, for validating what a renderer sends -- and the only guard
 *  on the process boundary described at the top of this file. The IPC handler
 *  checks against it, so a value that is not a TrayState would otherwise
 *  reach setImage() and blank the icon. DERIVED from ALL_STATES, so it cannot
 *  fall behind this process's own union; the frontend's separate union is the
 *  one gap left, and setTrayState() logs what it rejects for that reason. */
export const TRAY_STATES: TrayState[] = Object.keys(ALL_STATES) as TrayState[];
