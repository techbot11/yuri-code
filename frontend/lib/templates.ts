// Editing a workflow template: a plan shape you can change.
//
// Pure so `node --test` reaches it. The checks here are DELIBERATELY only the
// ones the form can point AT a field for. Everything semantic — a dependency
// cycle above all, plus the task cap and anything about roles the server
// knows and this file does not — is left to the backend's `loader.validate`,
// the same function the loader runs at startup.
//
// That is a choice: mirroring cycle detection into TypeScript would mean two
// implementations of "what is a cycle", and the one that drifts is the one
// that lets a bad template through. So there is exactly one, the save round
// trip is milliseconds against localhost, and the error it returns names the
// members of the cycle.

export type TemplateTask = {
  id: string;
  role?: string | null;
  title: string;
  instruction: string;
  depends_on?: string[];
  read_only?: boolean;
  requires?: string[];
  verification?: string[];
  kind?: string;
};

export type TemplateSummary = {
  name: string;
  description: string;
  custom: boolean;
  has_default: boolean;
  verify_names: string[];
  /** The closed vocabularies, sent by the server so the form's choices and
   *  the validator's accepted values cannot drift apart. */
  roles: string[];
  kinds: string[];
  capabilities: string[];
  max_tasks: number;
  tasks: TemplateTask[];
};

/** A template offers Reset only when there is a default to go back to. A
 *  control that cannot work is not rendered (GUIDE.md §6). */
export function templateActions(t: TemplateSummary): { reset: boolean; remove: boolean } {
  return { reset: t.custom && t.has_default, remove: t.custom && !t.has_default };
}

/** One line under the name, so the list says which have been changed. */
export function templateSubtitle(t: TemplateSummary): string {
  const steps = `${t.tasks.length} step${t.tasks.length === 1 ? "" : "s"}`;
  const checks = t.tasks.filter((x) => (x.verification || []).length > 0).length;
  const checked = checks ? `, ${checks} checked` : "";
  return `${steps}${checked}${t.custom ? " · yours" : ""}`;
}


// ---------------------------------------------------------------------------
// The FORM model. Everything in a template except id/title/instruction comes
// from a closed vocabulary, so a form can make whole classes of error
// impossible rather than reporting them after a save: an unknown role, a
// check that does not exist, a depends_on naming a step that isn't there.
//
// These are pure so `node --test` reaches them. What stays the backend's job
// is unchanged and deliberate — cycles above all. Mirroring cycle detection
// here would mean two implementations of "what is a cycle", and the one that
// drifts is the one that lets a bad template through.
// ---------------------------------------------------------------------------

export type FormTask = {
  id: string;
  title: string;
  instruction: string;
  role: string;          // "" means none, which only a non-agent step may have
  kind: string;
  depends_on: string[];
  verification: string[];
  requires: string[];
  read_only: boolean;
};

export type TemplateForm = { description: string; tasks: FormTask[] };

export const DEFAULT_KIND = "agent_task";

/** The saved template as form state. Absent optional fields become their
 *  empty value, so every control has something concrete to bind to. */
export function toForm(t: TemplateSummary): TemplateForm {
  return {
    description: t.description,
    tasks: t.tasks.map((x) => ({
      id: x.id,
      title: x.title,
      instruction: x.instruction,
      role: x.role ?? "",
      kind: x.kind || DEFAULT_KIND,
      depends_on: [...(x.depends_on || [])],
      verification: [...(x.verification || [])],
      requires: [...(x.requires || [])],
      read_only: Boolean(x.read_only),
    })),
  };
}

/** Form state as the body to PUT. `name` is the path, so it is not in the
 *  body — a body that renamed itself would write one file and override a
 *  different template. Empty optional fields are omitted rather than sent as
 *  empty lists, so a template saved from the form reads like one written by
 *  hand. */
export function toBody(form: TemplateForm): Record<string, unknown> {
  return {
    description: form.description.trim(),
    tasks: form.tasks.map((t) => {
      const out: Record<string, unknown> = {
        id: t.id.trim(),
        title: t.title.trim(),
        instruction: t.instruction.trim(),
      };
      if (t.role) out.role = t.role;
      if (t.kind && t.kind !== DEFAULT_KIND) out.kind = t.kind;
      if (t.depends_on.length) out.depends_on = [...t.depends_on];
      if (t.verification.length) out.verification = [...t.verification];
      if (t.requires.length) out.requires = [...t.requires];
      if (t.read_only) out.read_only = true;
      return out;
    }),
  };
}

/** The first thing wrong with the form, in the words of the field it is
 *  about, or "" when the cheap checks all pass. One message rather than a
 *  list: the form shows it next to Save, and a wall of errors for a
 *  half-filled step is noise while you are still typing it. */
export function formError(form: TemplateForm): string {
  if (!form.description.trim()) return "The plan shape needs a description.";
  if (form.tasks.length === 0) return "A plan shape needs at least one step.";
  const seen = new Set<string>();
  for (const [i, t] of form.tasks.entries()) {
    const n = i + 1;
    if (!t.id.trim()) return `Step ${n} needs an id.`;
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(t.id.trim())) {
      return `Step ${n}'s id can only use letters, numbers, - and _.`;
    }
    if (seen.has(t.id.trim())) return `Two steps share the id "${t.id.trim()}".`;
    seen.add(t.id.trim());
    if (!t.title.trim()) return `Step ${n} needs a title.`;
    if (!t.instruction.trim()) return `Step ${n} needs an instruction.`;
    // The validator's rule, checked here only because the form can point at
    // the step rather than naming it in a sentence from the server.
    if (t.kind === DEFAULT_KIND && !t.role) return `Step ${n} is an agent step, so it needs a role.`;
    if (t.depends_on.includes(t.id.trim())) return `Step ${n} depends on itself.`;
  }
  // Checked last: an id being edited mid-typing makes earlier steps'
  // dependencies briefly dangle, and complaining about step 1 while you are
  // typing in step 3 is the wrong place to look.
  for (const [i, t] of form.tasks.entries()) {
    for (const d of t.depends_on) {
      if (!seen.has(d)) return `Step ${i + 1} depends on "${d}", which is not a step here.`;
    }
  }
  return "";
}

/** Save is possible when the cheap checks pass and something actually
 *  changed. Semantic validity stays the backend's answer, so Save is NOT
 *  disabled for anything only it can know — a disabled button is a label,
 *  the server is the lock. */
export function canSaveForm(form: TemplateForm, original: TemplateForm): boolean {
  return formError(form) === "" && !sameForm(form, original);
}

export function sameForm(a: TemplateForm, b: TemplateForm): boolean {
  return JSON.stringify(toBody(a)) === JSON.stringify(toBody(b));
}

/** A new step, with an id that does not collide with one already there. */
export function blankTask(form: TemplateForm): FormTask {
  const taken = new Set(form.tasks.map((t) => t.id.trim()));
  let id = "step";
  for (let n = 2; taken.has(id); n++) id = `step_${n}`;
  return { id, title: "", instruction: "", role: "", kind: DEFAULT_KIND,
           depends_on: [], verification: [], requires: [], read_only: false };
}

/** Move a step. Order is how the plan READS — what runs when is decided by
 *  each step's dependencies — so this changes nothing but legibility. */
export function moveTask(form: TemplateForm, from: number, to: number): TemplateForm {
  if (to < 0 || to >= form.tasks.length || from === to) return form;
  const tasks = [...form.tasks];
  const [moved] = tasks.splice(from, 1);
  tasks.splice(to, 0, moved);
  return { ...form, tasks };
}

/** Remove a step, and with it every dependency on it — leaving those behind
 *  makes a template the server refuses to load, reported as a dangling
 *  depends_on rather than as the deletion that caused it. */
export function removeTask(form: TemplateForm, index: number): TemplateForm {
  const gone = form.tasks[index]?.id.trim();
  return {
    ...form,
    tasks: form.tasks
      .filter((_, i) => i !== index)
      .map((t) => ({ ...t, depends_on: t.depends_on.filter((d) => d !== gone) })),
  };
}

/** Rename a step's id, carrying every dependency on it across. */
export function renameTask(form: TemplateForm, index: number, id: string): TemplateForm {
  const was = form.tasks[index]?.id.trim();
  return {
    ...form,
    tasks: form.tasks.map((t, i) =>
      i === index
        ? { ...t, id }
        : { ...t, depends_on: t.depends_on.map((d) => (d === was ? id.trim() : d)) }),
  };
}
