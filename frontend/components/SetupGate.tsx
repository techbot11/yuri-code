"use client";

// Shows Setup instead of the app when something required is missing.
//
// Rather than a UI whose every button fails: without a voice key she cannot
// talk, and without `claude` no session can start. The gate is checked ONCE
// per load — it is a first-run and misconfiguration gate, not a supervisor,
// and re-checking on every render would put a doctor probe (which touches the
// filesystem and the network) on the critical path of every navigation.
//
// It stays SHUT while the answer is unknown: opening on unknown state would
// render the whole app and then snatch it away. `/setup` itself is never
// gated, or a failing check would make the fix unreachable.
//
// This component STANDS IN FOR THE STAGE (see app/layout.tsx) rather than
// filling the stage's panel, so everything it renders — the waiting state
// included — has to carry the stage's own padding and scrolling. That is what
// `.setup-gate` is for. Rendering into `.vpanel` instead is what made the
// gate invisible on "/".
//
// An unreachable backend is NOT "render the app anyway" (a shipped bug: the
// app looks normal and every button in it fails). It also is not rare: the
// one-window desktop shell shows this frontend well before its backend
// answers (6-16s cold start), so the FIRST few seconds of most boots hit
// this exact path. lib/backendWait.ts owns the retry schedule and the
// give-up bound; this component just drives it and renders the phase.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { yget } from "@/lib/api";
import { gateOpen, type DoctorCheck } from "@/lib/setup";
import { retryDelayMs, shouldGiveUp, waitMessage, waitPhase } from "@/lib/backendWait";
import { SetupPanel } from "./SetupPanel";

/** Pushed by the desktop shell's main process over the boot:state channel
 *  (desktop/main/index.ts's pushBoot) — present only inside Electron.
 *  Informational only: whether the backend is reachable is always decided
 *  by actually reaching it over HTTP below, never by trusting this alone. */
type YuriBootState = {
  phase: "starting" | "ready" | "failed";
  env: string;
  envDetail: string;
  backend: string;
  frontend: string;
  errorDetail: string;
};

type YuriBootBridge = {
  onState: (cb: (s: YuriBootState) => void) => void;
  retry: () => void;
  quit: () => void;
};

/** Same pattern as VoiceProvider's yuriTray read: a plain cast, guarded, so a
 *  plain browser tab (no bridge at all) is a no-op rather than a crash. */
function yuriBoot(): YuriBootBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { yuriBoot?: YuriBootBridge }).yuriBoot;
}

export function SetupGate({ children }: { children: React.ReactNode }) {
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [wait, setWait] = useState<{ attempt: number; elapsedMs: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [boot, setBoot] = useState<YuriBootState | null>(null);
  const pathname = usePathname();
  const startedAt = useRef<number | null>(null);

  // Stable identity: SetupPanel's own load() now depends on `onPass` (it
  // fires load() as soon as nothing is left blocking, so a fix made through
  // the Rail's separate /setup panel also clears this gate). An inline arrow
  // here would get a new identity on every re-render of this gate — e.g. a
  // pathname change from clicking the Rail while still blocked — which would
  // re-trigger SetupPanel's mount effect and refetch on every such render.
  const handlePass = useCallback(() => setDismissed(true), []);

  // Electron progress detail, purely for display (see YuriBootState above).
  useEffect(() => { yuriBoot()?.onState((s) => setBoot(s)); }, []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function attempt(n: number) {
      yget<{ checks: DoctorCheck[] }>("doctor")
        .then((d) => {
          if (!live) return;
          setChecks(d.checks || []);
          setWait(null);
        })
        .catch(() => {
          if (!live) return;
          if (startedAt.current === null) startedAt.current = Date.now();
          const elapsedMs = Date.now() - startedAt.current;
          setWait({ attempt: n, elapsedMs });
          if (!shouldGiveUp(elapsedMs)) {
            timer = setTimeout(() => attempt(n + 1), retryDelayMs(n + 1));
          }
        });
    }
    attempt(0);
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, []);

  if (dismissed) return <>{children}</>;
  if (pathname === "/setup") return <>{children}</>;

  if (wait) {
    const phase = waitPhase(wait.attempt, wait.elapsedMs);
    const bridge = yuriBoot();
    return (
      <div className="setup-gate">
        <div className="setup-view">
          <h2 className="viewtitle">Starting Yuri</h2>
          <div className="mcp-blurb">{waitMessage(phase)}</div>
          {phase === "failed" && boot?.errorDetail ? (
            <pre className="mcp-err">{boot.errorDetail}</pre>
          ) : null}
          {/* A control that cannot work is not rendered (GUIDE.md §6): Retry
              and Quit both need the desktop shell's IPC bridge, so a plain
              browser tab gets the wait with no buttons at all. */}
          {phase === "failed" && bridge ? (
            <div className="mcp-actions">
              <button className="txtoggle primary" onClick={() => bridge.retry()}>
                Try again
              </button>
              <button className="txtoggle" onClick={() => bridge.quit()}>Quit</button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (checks === null) {
    return (
      <div className="setup-gate">
        <div className="setup-view">
          <h2 className="viewtitle">Checking your machine</h2>
          <div className="empty">
            Running the same checks as <code>yuri doctor</code>…
          </div>
        </div>
      </div>
    );
  }
  if (gateOpen(checks)) return <>{children}</>;

  return (
    <div className="setup-gate">
      <div className="setup-view">
        <h2 className="viewtitle">Before Yuri can start</h2>
        <SetupPanel onPass={handlePass} />
      </div>
    </div>
  );
}
