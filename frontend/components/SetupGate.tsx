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
import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { yget } from "@/lib/api";
import { gateOpen, type DoctorCheck } from "@/lib/setup";
import { SetupPanel } from "./SetupPanel";

export function SetupGate({ children }: { children: React.ReactNode }) {
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [reachable, setReachable] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const pathname = usePathname();

  // Stable identity: SetupPanel's own load() now depends on `onPass` (it
  // fires load() as soon as nothing is left blocking, so a fix made through
  // the Rail's separate /setup panel also clears this gate). An inline arrow
  // here would get a new identity on every re-render of this gate — e.g. a
  // pathname change from clicking the Rail while still blocked — which would
  // re-trigger SetupPanel's mount effect and refetch on every such render.
  const handlePass = useCallback(() => setDismissed(true), []);

  useEffect(() => {
    let live = true;
    yget<{ checks: DoctorCheck[] }>("doctor")
      .then((d) => live && setChecks(d.checks || []))
      // A backend that cannot be reached is not a failed check — it is a
      // different problem, and the app's own error surfaces say it better
      // than a Setup screen would.
      .catch(() => live && setReachable(false));
    return () => { live = false; };
  }, []);

  if (!reachable || dismissed) return <>{children}</>;
  if (pathname === "/setup") return <>{children}</>;
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
