// Which voice-connect status the shell interrupts the user with.
//
// The provider tracks a running status string — "Minting token...",
// "Negotiating WebRTC...", "Connected — start talking.", and on failure
// "Failed: <reason>". For a long time NOTHING rendered it: the reason was
// computed and thrown away, so a user whose connect failed saw neither
// "connected" nor a cause. This decides what is worth showing, and lives in
// lib/ so `node --test` can reach it (there is no DOM test environment).

/** The failure reason to show, or "" when there is nothing worth interrupting
 *  for. Progress lines and the idle prompt are noise beside a button that
 *  already says what it does; a failure is the one thing the user cannot infer
 *  from the UI. The "Failed:" prefix is stripped, because the message it
 *  wraps usually starts with a verb of its own. */
export function failure(status: string | undefined): string {
  const s = (status || "").trim();
  return s.startsWith("Failed:") ? s.replace(/^Failed:\s*/, "").trim() : "";
}
