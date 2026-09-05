// Setup: the environment checks that must pass, and the settings a user can
// change from inside the app.
//
// Pure so `node --test` reaches it. The rules here are the ones that can be
// wrong in a way nobody notices — a gate that opens while the checks are
// still loading flashes the whole app and yanks it back; a "takes effect now"
// label on a setting that needs a restart is simply a lie.

export type Effect = "now" | "next-session" | "restart";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  /** Yuri cannot work without this one. tmux is NOT required: without it the
   *  live terminal pane is unavailable, but agents still run. */
  required: boolean;
};

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
