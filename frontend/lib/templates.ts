// Editing a workflow template: a plan shape you can change.
//
// Pure so `node --test` reaches it. What is here is DELIBERATELY only the
// cheap, immediate checks — is this JSON, does it have tasks, do the ids look
// sane. Everything semantic (unknown role, dependency cycle, a depends_on
// naming a task that isn't there, the task cap, an unknown verification name)
// is left to the backend's `loader.validate`, which is the same function the
// loader runs at startup.
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
  max_tasks: number;
  tasks: TemplateTask[];
};

/** The editable body: name is the path, so it is not part of the JSON you
 *  edit — a body that renamed itself would write one file and override a
 *  different template. */
export function editableBody(t: TemplateSummary): string {
  return JSON.stringify({ description: t.description, tasks: t.tasks }, null, 2);
}

export type ParseResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

/** Is this JSON, and does it have the shape of a template? Nothing semantic. */
export function parseBody(text: string): ParseResult {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (e) {
    // The parser's own message names the line and column, which is the whole
    // value of showing it rather than "invalid JSON".
    return { ok: false, error: e instanceof Error ? e.message : "That isn't valid JSON." };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "A template is a JSON object, not a list or a value." };
  }
  const tasks = (body as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, error: "A template needs a “tasks” list with at least one step." };
  }
  for (const [i, task] of tasks.entries()) {
    if (!task || typeof task !== "object") {
      return { ok: false, error: `Step ${i + 1} is not an object.` };
    }
    const t = task as Record<string, unknown>;
    for (const field of ["id", "title", "instruction"]) {
      if (!String(t[field] ?? "").trim()) {
        return { ok: false, error: `Step ${i + 1} needs a ${field}.` };
      }
    }
  }
  return { ok: true, body: body as Record<string, unknown> };
}

/** Save is possible when the text parses and differs from what is saved.
 *  Semantic validity is the backend's answer, so Save stays available and the
 *  server's reason is shown if it refuses — the same posture the MCP form
 *  takes, where a disabled button is a label and the server is the lock. */
export function canSave(text: string, original: string): boolean {
  return parseBody(text).ok && text.trim() !== original.trim();
}

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
