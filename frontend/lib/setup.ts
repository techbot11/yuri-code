// Setup: the environment checks that must pass, and the settings a user can
// change from inside the app.
//
// Pure so `node --test` reaches it. The rules here are the ones that can be
// wrong in a way nobody notices — a gate that opens while the checks are
// still loading flashes the whole app and yanks it back; a "takes effect now"
// label on a setting that needs a restart is simply a lie.

export type Effect = "now" | "next-session" | "restart";

/** The action that fixes a failing check, as the backend sends it
 *  (yuri/doctor.py's `Fix`). Optional: most checks have no single action. */
export type Fix = {
  /** "url" (open it) or "command" (offer it as copyable text). Typed as a
   *  string, not a union, because it arrives over HTTP — an unrecognised kind
   *  must render nothing rather than crash a screen whose whole job is to be
   *  reachable when everything else is broken. */
  kind: string;
  payload: string;
  label: string;
};

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  /** Yuri cannot work without this one. tmux is NOT required: without it the
   *  live terminal pane is unavailable, but agents still run. */
  required: boolean;
  /** Spec §6.2: each failing check carries the action that fixes it. Absent
   *  on the checks that have none, and on every passing check. */
  fix?: Fix | null;
};

/** A fix affordance reduced to what the UI actually renders. `null` means
 *  render nothing at all. */
export type FixAction =
  | { kind: "url"; href: string; label: string }
  | { kind: "command"; command: string; label: string }
  | null;

/** What (if anything) to render beside a check as its fix.
 *
 *  Lives here rather than in the component because there is no DOM test
 *  environment: a rule inside JSX is untestable by construction, and two of
 *  these rules are ones that fail silently — an unknown `kind` from a newer
 *  backend must render NOTHING rather than a mystery control, and a `url`
 *  whose scheme isn't http(s) must never become an href (an unchecked scheme
 *  is a `javascript:`/`data:` sink one backend bug away). */
export function fixAction(check: DoctorCheck): FixAction {
  const fix = check.fix;
  // A passing check gets none, even if one came down the wire: "here is how
  // to install claude" beside a green tick is noise.
  if (!fix || check.ok) return null;
  const payload = (fix.payload || "").trim();
  if (!payload) return null;
  if (fix.kind === "url") {
    if (!/^https?:\/\//i.test(payload)) return null;
    return { kind: "url", href: payload, label: fix.label || "Open" };
  }
  if (fix.kind === "command") {
    return { kind: "command", command: payload, label: fix.label || "Copy" };
  }
  return null;
}

export type ManagedKey = {
  name: string;
  label: string;
  /** A credential. Its value is never sent to the client, so a secret field
   *  starts empty and anything typed into it counts as new. */
  secret: boolean;
  effect: Effect;
  blurb: string;
  set: boolean;
  /** Identifies the value without revealing it ("…4f2a"), or the value itself
   *  for a non-secret. Empty when unset. */
  hint: string;
  source: string;
};

/** The failing checks that actually stop Yuri working. */
export function blocking(checks: DoctorCheck[]): DoctorCheck[] {
  return checks.filter((c) => c.required && !c.ok);
}

/** Whether the app may render instead of the Setup screen.
 *
 *  `null` (not loaded) and `[]` (the endpoint told us nothing) both keep it
 *  SHUT. Opening on unknown state would show the whole app and then remove
 *  it, and an empty list is an absence of information rather than a clean
 *  bill of health. */
export function gateOpen(checks: DoctorCheck[] | null): boolean {
  if (!checks || checks.length === 0) return false;
  return blocking(checks).length === 0;
}

export function effectLabel(e: Effect): string {
  if (e === "now") return "takes effect straight away";
  if (e === "next-session") return "applies to the next agent session";
  return "needs Yuri to restart";
}

/** One sentence for a set of effects, naming the STRONGEST — a change that
 *  needs a restart must not be reported as taking effect now. */
export function effectsSentence(effects: Effect[]): string {
  if (effects.length === 0) return "";
  const strongest: Effect =
    effects.includes("restart") ? "restart"
      : effects.includes("next-session") ? "next-session" : "now";
  return `Saved — ${effectLabel(strongest)}.`;
}

const touched = (draft: Record<string, string>, name: string) =>
  Object.prototype.hasOwnProperty.call(draft, name);

/** Which keys the draft actually changes.
 *
 *  A secret's current value is unknown to the client by design, so it cannot
 *  be compared: anything typed is new. A non-secret can be compared against
 *  the hint, which for a non-secret IS the value. */
export function pendingChanges(
  keys: ManagedKey[], draft: Record<string, string>,
): string[] {
  return keys
    .filter((k) => {
      if (!touched(draft, k.name)) return false;
      const next = (draft[k.name] || "").trim();
      if (!next) return k.set;           // clearing matters only if it was set
      if (k.secret) return true;
      return next !== k.hint;
    })
    .map((k) => k.name);
}

export function canSave(keys: ManagedKey[], draft: Record<string, string>): boolean {
  return pendingChanges(keys, draft).length > 0;
}

/** The provenance label the backend uses (config._source_of) for a value that
 *  came from the launching shell rather than from any file Setup writes. */
export const SHELL_SOURCE = "process environment";

/** Whether a save to this key will be quietly undone by the user's shell.
 *
 *  Precedence in backend/config.py is: real environment > the out-of-tree
 *  config dir > $YURI_HOME/config/.env > backend/.env. PUT /yuri/config
 *  writes the file AND this process's os.environ, so the save genuinely works
 *  NOW — and then the exported variable wins again at the next start and the
 *  saved value silently disappears, having been reported as "Saved — takes
 *  effect straight away". Provenance is how a user is supposed to discover
 *  this (spec §6.3), so it has to be said out loud, on the field, before the
 *  save rather than after the restart. */
export function shadowedByShell(key: ManagedKey): boolean {
  return key.set && key.source === SHELL_SOURCE;
}

/** The warning to show on that field, or "" for no warning. Plain words: the
 *  reader is someone who exported a variable in a terminal, not someone who
 *  knows what "precedence" means here. */
export function shellShadowWarning(key: ManagedKey): string {
  if (!shadowedByShell(key)) return "";
  return `${key.name} is set in the shell Yuri was started from. Saving here `
    + `changes it straight away, but that exported value wins again the next `
    + `time Yuri starts — unset it in your shell to make this stick.`;
}
