// The Memory panel's rules. Pure, so `node --test` reaches it.
//
// The one that carries the phase: the panel must show which memories are NOT
// reaching her. The old store truncated silently, so "in her prompt" versus
// "not" being visible and fixable by pinning is the whole point of this view.

export const KINDS = ["preference", "fact", "observation", "day", "project"] as const;
export type Kind = (typeof KINDS)[number];

export const SOURCES = ["stated", "observed", "inferred"] as const;
export type Source = (typeof SOURCES)[number];

/** What each kind IS, in the user's words. "observation" alone does not say
 *  who made it or why it is there. */
export const KIND_LABEL: Record<Kind, string> = {
  preference: "How you want her to behave",
  fact: "About you",
  observation: "Something that happened",
  day: "A day",
  project: "About a project",
};

/** The honesty distinction, in words rather than an enum. These must stay
 *  three DIFFERENT phrases — her guess reading like your instruction is the
 *  failure `source` exists to prevent, and a test asserts it. */
export const SOURCE_LABEL: Record<Source, string> = {
  stated: "you told her",
  observed: "it happened",
  inferred: "she thinks",
};

export type Memory = {
  id: string;
  body: string;
  kind: string;
  subject: string;
  source: string;
  origin: string;
  pinned: boolean;
  superseded_by?: string | null;
  created_at: string;
  in_prompt?: boolean;
  embedded?: boolean;
};

export type Budget = {
  used: number;
  budget: number;
  omitted: number;
  total: number;
  in_prompt: string[];
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind as Kind] || kind;
}

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source as Source] || source;
}

/** Display order: what she is told to DO first, then who you are, then the
 *  derived things. A day or an observation is context; a preference is a
 *  standing instruction, and it belongs at the top of a page about memory for
 *  the same reason it is exempt from the budget. */
const ORDER: Kind[] = ["preference", "fact", "project", "observation", "day"];

export function groupByKind(rows: Memory[]): [string, Memory[]][] {
  const seen = new Map<string, Memory[]>();
  for (const m of rows) {
    seen.set(m.kind, [...(seen.get(m.kind) || []), m]);
  }
  const out: [string, Memory[]][] = [];
  for (const kind of ORDER) {
    const group = seen.get(kind);
    if (group?.length) {
      out.push([kind, group]);
      seen.delete(kind);
    }
  }
  // An unrecognised kind still renders. A memory the panel silently hides is
  // a memory the user cannot delete.
  for (const [kind, group] of seen) out.push([kind, group]);
  return out;
}

/** A control that would fail is not rendered (GUIDE.md §6). */
export function rowActions(m: Memory): {
  pin: boolean; unpin: boolean; supersede: boolean; remove: boolean;
} {
  const superseded = Boolean(m.superseded_by);
  return {
    // A preference is exempt from the budget, so pinning one changes nothing
    // and offering it would imply otherwise.
    pin: !m.pinned && !superseded && m.kind !== "preference",
    unpin: m.pinned && !superseded,
    supersede: !superseded,
    remove: true,
  };
}

/** Why a memory is or is not in her prompt, in one phrase. The point of the
 *  panel, so it never says just "no". */
export function promptState(m: Memory): { in: boolean; why: string } {
  if (m.superseded_by) return { in: false, why: "replaced by a newer one" };
  if (m.kind === "preference") return { in: true, why: "always — it's an instruction" };
  if (m.pinned) return { in: true, why: "pinned" };
  if (m.in_prompt) return { in: true, why: "fits" };
  return { in: false, why: "didn't fit — pin it to change that" };
}

export function budgetSummary(b: Budget | null): {
  tone: "good" | "warn"; text: string;
} {
  if (!b) return { tone: "good", text: "" };
  if (b.omitted > 0) {
    return {
      tone: "warn",
      text: `${b.omitted} of ${b.total} aren't reaching her — pin the ones that should.`,
    };
  }
  return { tone: "good", text: `All ${b.total} reach her (${b.used} of ${b.budget} characters).` };
}

export type MemoryForm = { body: string; kind: Kind; subject: string; source: Source };

export const EMPTY_MEMORY: MemoryForm = {
  body: "", kind: "fact", subject: "user", source: "stated",
};

/** Mirrors the domain's rules: a project memory needs a slug, and the other
 *  kinds do not take one. Kept in step by the backend refusing anyway — this
 *  is for immediate feedback, not the lock. */
export function validateMemory(form: MemoryForm): Partial<Record<keyof MemoryForm, string>> {
  const errors: Partial<Record<keyof MemoryForm, string>> = {};
  if (!form.body.trim()) errors.body = "Say what she should remember.";
  else if (form.body.trim().length > 500) errors.body = "One sentence — that's over 500 characters.";
  if (!KINDS.includes(form.kind)) errors.kind = "That isn't a kind of memory.";
  if (!SOURCES.includes(form.source)) errors.source = "That isn't a source.";
  if (needsSlug(form.kind) && !/^[a-z0-9-]{1,64}$/.test(form.subject.trim())) {
    errors.subject = "Needs a project folder name (lowercase letters, digits, dashes).";
  }
  return errors;
}

export function needsSlug(kind: string): boolean {
  return kind === "project" || kind === "observation";
}

export function canSaveMemory(form: MemoryForm): boolean {
  return Object.keys(validateMemory(form)).length === 0;
}

export function memoryBody(form: MemoryForm): Record<string, unknown> {
  return {
    body: form.body.trim(),
    kind: form.kind,
    source: form.source,
    subject: needsSlug(form.kind) ? form.subject.trim() : "user",
  };
}
