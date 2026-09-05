// What the desktop shell's tray should say, derived from what this app knows.
//
// This is the ONLY implementation of that rule. It lives here because only
// the renderer has the facts it needs -- the voice session's state, running
// missions, pending approvals -- and it sends its answer to the main process
// over the tray:state channel, which validates the string against
// desktop/lib/tray.ts's TRAY_STATES and renders it.
//
// desktop/lib/tray.ts once carried a second copy of this rule, and a comment
// here claimed the two sides' tests cross-checked each other. They never
// did, and the copy had no caller; it has been deleted.
//
// What IS a live seam: the TrayState union below and the one in
// desktop/lib/tray.ts are independent declarations in two separately
// compiled processes, with no compile-time link and no test that can create
// one. Adding a state here means adding it to TRAY_STATES there (and giving
// it a menu-bar icon) -- otherwise the main process rejects it at runtime.
// It says so in the log when it does (desktop/main/tray.ts's setTrayState),
// which is the whole of the safety net.

export type TrayState =
  "asleep" | "listening" | "thinking" | "speaking" | "working" | "needs-you";

export function trayStateFor(f: {
  connected: boolean; vstate: string;
  missionsRunning: number; approvalsPending: number;
}): TrayState {
  if (f.approvalsPending > 0) return "needs-you";
  if (f.missionsRunning > 0) return "working";
  if (f.vstate === "speaking") return "speaking";
  // "thinking" ranks above "listening": composing a reply or running a tool
  // call is not the same as taking input, and claiming "listening" during a
  // long agent-driving stretch is exactly the lie this state exists to fix.
  // "hearing" is not listed here on purpose -- it IS listening, just with
  // voice activity detected, so it falls through to the connected check below.
  if (f.vstate === "thinking") return "thinking";
  if (f.connected) return "listening";
  return "asleep";
}
