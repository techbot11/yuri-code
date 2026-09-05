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
  /** The row's own trailing detail, or "".
   *
   *  Two things can want this column, and they never want it on the same row
   *  at the same time — but the precedence is stated rather than left to
   *  that coincidence, because a row that DID want both would otherwise pick
   *  one at random:
   *
   *  1. The elapsed-seconds counter, on the first still-starting row. Wins,
   *     when it can collide. Its job is to say "not frozen", which is about
   *     right now; a detail is about a step that has already finished.
   *  2. The env row's `envDetail` — which of the two ways the environment
   *     was resolved. Only the env row has one, and only once the probe has
   *     settled (`pushBoot` sends "" while it is still "starting"), so in
   *     practice case 1 never fires on the row that has a detail. */
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
    // See BootRow.note for why the counter wins a collision.
    const note = wants ? `${Math.floor(elapsedMs / 1000)}s`
               : key === "env" ? s.envDetail
               : "";
    return { key, label, state, note };
  });
}

/** The one detail worth printing under a failed boot.
 *
 *  The `env === "failed"` branch is DEFENSIVE, not a live path: probeLoginEnv
 *  never fails outright — it resolves null and the shell falls back to known
 *  locations — so pushBoot only ever sends "starting" or "ready" for the env
 *  row (desktop/main/index.ts). It stays because the type permits "failed"
 *  and a future probe that can fail should not need to remember this file.
 *
 *  Which means `envDetail` is NOT rendered here in any real boot, and a
 *  comment claiming this branch was where it finally got shown was wrong.
 *  Its actual home is the env row's own note — see bootRows() — where it is
 *  visible on every boot, which is the point: "using known locations" means
 *  the login-shell probe failed and a shell-exported model, gateway or PATH
 *  entry did not reach the agents.
 *
 *  When the branch does fire, it wins over `errorDetail` because it comes
 *  first causally: if resolving the shell environment failed, whatever the
 *  backend then said about a missing key is a symptom of it. */
export function bootDetail(s: YuriBootState | null | undefined): string {
  if (!s) return "";
  if (s.env === "failed" && s.envDetail) return s.envDetail;
  return s.errorDetail || "";
}
