"use client";

// The first thing you see when Yuri OS opens: her, waking up.
//
// This replaces a `.setup-view` panel — a titled card reading "Starting
// Yuri" over one sentence. A panel is the wrong shape for a boot: panels
// are for content you read or fill in, and a boot is a moment you watch.
// It also said nothing for the 6-16s a cold backend takes, which is most of
// the time this screen is on screen.
//
// So: her actual orb (the same canvas the app uses, not a stand-in), her
// wordmark, one line, and the checklist of what is still going. The orb
// renders in her idle state here because nothing is connected yet, which is
// exactly right — she is asleep and coming round.
import { useEffect, useState } from "react";
import { Orb } from "@/components/shell/Orb";
import { bootDetail, bootRows, type YuriBootState } from "@/lib/bootRows.ts";
import { waitMessage, type WaitPhase } from "@/lib/backendWait.ts";

export function BootSplash({
  phase, boot, startedAtMs, onRetry, onQuit, onMicSettings,
}: {
  phase: WaitPhase;
  boot: YuriBootState | null;
  /** When the wait began, for the elapsed counter. Null before there is a
   *  wait to measure (the post-backend doctor check reuses this splash). */
  startedAtMs: number | null;
  /** Both come from the desktop shell's IPC bridge. Undefined in a plain
   *  browser tab, where the buttons are not rendered at all rather than
   *  rendered dead (GUIDE.md §6). */
  onRetry?: () => void;
  onQuit?: () => void;
  /** Opens System Settings at Privacy & Security -> Microphone. Same
   *  bridge-gated pattern as onRetry/onQuit: undefined outside Electron, so
   *  the button that cannot work is not rendered at all. */
  onMicSettings?: () => void;
}) {
  // The splash owns its own second hand. SetupGate's `elapsedMs` only moves
  // when a retry fires, and that backs off to one attempt every 3s — a
  // counter jumping 4s -> 7s -> 10s looks broken. Same clock, read more
  // often: `startedAtMs` stays the single source of when this began.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAtMs === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAtMs]);

  const elapsedMs = startedAtMs === null ? 0 : Math.max(0, now - startedAtMs);
  const rows = bootRows(boot, elapsedMs);
  const detail = phase === "failed" ? bootDetail(boot) : "";
  const failed = phase === "failed";

  return (
    <div className="boot">
      {/* Not engaged: `engaged` is the orb's "step aside, a panel is open"
          pose. Nothing is open here — she has the whole screen. */}
      <Orb engaged={false} />
      <div className="boot-mid">
        <div className="boot-name">YURI</div>
        <div className="boot-line" role="status">{waitMessage(phase)}</div>
        {/* Only while something is actually in progress: its whole job is to
            say "not frozen", and after a failure nothing is running for it
            to say that about. Dropping it also gives the two buttons below
            the room they need. */}
        {failed ? null : <div className="boot-sweep" aria-hidden="true" />}
        {rows.length > 0 ? (
          <ul className="boot-rows">
            {rows.map((r) => (
              <li key={r.key} data-state={r.state}>
                <span className="boot-mark" aria-hidden="true" />
                <span className="boot-rlabel">{r.label}</span>
                <span className="boot-rnote">{r.note}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {detail ? <pre className="boot-err">{detail}</pre> : null}
        {rows.some((r) => r.key === "mic") ? (
          <div className="boot-mic">
            She cannot hear you until macOS lets her.
            {onMicSettings ? (
              <button className="txtoggle" onClick={onMicSettings}>Open Settings</button>
            ) : null}
          </div>
        ) : null}
        {failed && onRetry && onQuit ? (
          <div className="boot-actions">
            <button className="txtoggle primary" onClick={onRetry}>Try again</button>
            <button className="txtoggle" onClick={onQuit}>Quit</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
