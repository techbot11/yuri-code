// The boot splash's checklist: three named things Yuri needs, and which of
// them is still going.
//
// The splash used to be one sentence ("Still starting up — this can take a
// little while on a cold start"), which told the reader nothing during the
// 6-16s a cold backend takes. Meanwhile the desktop shell was already
// pushing per-child state over boot:state and the UI was discarding it. So
// this is not new information — it is information that was being thrown
// away.
//
// Pure so `node --test` reaches it: there is no DOM test environment here.

export type ChildState = "starting" | "ready" | "failed";

/** Pushed by the desktop shell's main process over boot:state (see
 *  desktop/main/index.ts's pushBoot) — present only inside Electron. */
export type YuriBootState = {
  phase: "starting" | "ready" | "failed";
  env: ChildState;
  envDetail: string;
  backend: ChildState;
  frontend: ChildState;
  errorDetail: string;
};

export type BootRow = {
  key: "env" | "frontend" | "backend";
  label: string;
  state: ChildState;
  /** Elapsed seconds, on the one row still working. "" on every other row. */
  note: string;
};

/** Boot order, and also reading order: the row that keeps the user waiting
 *  is last, so a checklist filling downward reads as progress. `frontend`
 *  before `backend` is honest rather than cosmetic — the window is only
 *  shown once the frontend answers, so by the time this renders the
 *  interface really is up and the backend really is the one outstanding. */
const ROWS: { key: BootRow["key"]; label: string }[] = [
  { key: "env", label: "Environment" },
  { key: "frontend", label: "Interface" },
  { key: "backend", label: "Backend" },
];

/** The checklist, or [] outside Electron — with no bridge there is no state
 *  to report, and a checklist of three permanent question marks is worse
 *  than no checklist (GUIDE.md §6: a control that cannot work is not
 *  rendered). The caller falls back to the status line alone.
 *
 *  `elapsedMs` is time since the first backend check. It is shown against
 *  the FIRST still-starting row only: two counters ticking in step read as
 *  two separate measurements of different things, when it is one clock. */
export function bootRows(
  s: YuriBootState | null | undefined,
  elapsedMs: number,
): BootRow[] {
  if (!s) return [];
  let noted = false;
  return ROWS.map(({ key, label }) => {
    const state = s[key];
    // Sub-second elapsed shows nothing: a "0s" that appears for one frame
    // and is gone reads as a glitch, not as a measurement.
    const wants = state === "starting" && !noted && elapsedMs >= 1000;
    if (wants) noted = true;
    return { key, label, state, note: wants ? `${Math.floor(elapsedMs / 1000)}s` : "" };
  });
}

/** The one detail worth printing under a failed boot.
 *
 *  A failed environment capture has no other home — `envDetail` is not
 *  rendered anywhere else, so before this it was collected and silently
 *  dropped. It wins over `errorDetail` because it comes first causally: if
 *  resolving the shell environment failed, whatever the backend then said
 *  about a missing key is a symptom of it. */
export function bootDetail(s: YuriBootState | null | undefined): string {
  if (!s) return "";
  if (s.env === "failed" && s.envDetail) return s.envDetail;
  return s.errorDetail || "";
}
