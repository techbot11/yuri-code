// What the desktop shell's tray should say, derived from what this app knows.
//
// The rule is duplicated from desktop/lib/tray.ts on purpose: the two run in
// different processes with no shared module, and a frontend that imported
// from desktop/ would break `next build` for the browser. The tests on both
// sides pin the same priority order, so a change to one that is not made to
// the other fails a test rather than drifting silently.

export type TrayState = "asleep" | "listening" | "speaking" | "working" | "needs-you";

export function trayStateFor(f: {
  connected: boolean; vstate: string;
  missionsRunning: number; approvalsPending: number;
}): TrayState {
  if (f.approvalsPending > 0) return "needs-you";
  if (f.missionsRunning > 0) return "working";
  if (f.vstate === "speaking") return "speaking";
  if (f.connected) return "listening";
  return "asleep";
}
