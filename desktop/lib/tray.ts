// What the tray says she is doing.
//
// Pure so `node --test` reaches it. The ORDER is the substance: this is a
// priority list, not a set of independent flags, and getting it wrong means
// the one state worth interrupting for gets hidden behind a chattier one.

export type TrayState =
  "asleep" | "listening" | "thinking" | "speaking" | "working" | "needs-you";

export type TrayFacts = {
  voiceConnected: boolean;
  speaking: boolean;
  thinking: boolean;
  missionsRunning: number;
  approvalsPending: number;
};

/** Highest priority first.
 *
 *  `needs-you` outranks everything including `asleep`: voice being
 *  disconnected does not make a blocked agent less blocked, and a blocked
 *  agent behind a hidden window is exactly what this tray is for.
 *
 *  `working` outranks `speaking` because the user can already HEAR that she
 *  is speaking; that work is continuing in the background is the fact the
 *  tray can add.
 *
 *  `thinking` outranks `listening` but not `speaking`: composing a reply or
 *  running a tool call between turns is not the same as taking input, and
 *  claiming "listening" through a long agent-driving stretch is exactly the
 *  lie this state exists to fix. It does NOT outrank `speaking` -- she can
 *  only be doing one at a time, and the user can already hear her voice. */
export function trayState(f: TrayFacts): TrayState {
  if (f.approvalsPending > 0) return "needs-you";
  if (f.missionsRunning > 0) return "working";
  if (f.speaking) return "speaking";
  if (f.thinking) return "thinking";
  if (f.voiceConnected) return "listening";
  return "asleep";
}

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

/** Every state, for validating what a renderer sends. The IPC handler checks
 *  against this, so a value missing here silently ignores a real state and a
 *  value that is not a TrayState would blank the icon. */
export const TRAY_STATES: TrayState[] =
  ["asleep", "listening", "thinking", "speaking", "working", "needs-you"];
