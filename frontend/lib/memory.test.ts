import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_MEMORY, KINDS, KIND_LABEL, SOURCES, SOURCE_LABEL, budgetSummary,
  canSaveMemory, groupByKind, kindLabel, memoryBody, needsSlug, promptState,
  rowActions, sourceLabel, validateMemory, type Memory, type MemoryForm,
} from "./memory.ts";

const mem = (over: Partial<Memory> = {}): Memory => ({
  id: "m1", body: "prefers dark mode", kind: "fact", subject: "user",
  source: "stated", origin: "voice", pinned: false, created_at: "2026-09-04T12:00:00Z",
  in_prompt: true, ...over,
});

test("the enums match the backend's", () => {
  assert.deepEqual([...KINDS], ["preference", "fact", "observation", "day", "project"]);
  assert.deepEqual([...SOURCES], ["stated", "observed", "inferred"]);
});

test("every kind and source has a label in the user's words", () => {
  for (const k of KINDS) assert.ok(KIND_LABEL[k].length > 4, k);
  for (const s of SOURCES) assert.ok(SOURCE_LABEL[s].length > 4, s);
  // "observation" alone does not say who made it or why it is there.
  assert.notEqual(kindLabel("observation"), "observation");
  assert.equal(kindLabel("something-new"), "something-new");
  assert.equal(sourceLabel("mystery"), "mystery");
});

test("the three sources read as three different things", () => {
  // Her guess reading like your instruction is the failure `source` exists to
  // prevent.
  const phrases = new Set(SOURCES.map((s) => SOURCE_LABEL[s]));
  assert.equal(phrases.size, 3);
});

test("preferences come first, because they are standing instructions", () => {
  const rows = [mem({ kind: "day" }), mem({ kind: "fact" }), mem({ kind: "preference" })];
  assert.deepEqual(groupByKind(rows).map(([k]) => k), ["preference", "fact", "day"]);
});

test("an unrecognised kind still renders", () => {
  // A memory the panel hides is a memory the user cannot delete.
  const out = groupByKind([mem({ kind: "wat" })]);
  assert.deepEqual(out.map(([k]) => k), ["wat"]);
});

test("the panel says WHY a memory is or is not in her prompt", () => {
  // The point of the view. It must never say just "no".
  assert.deepEqual(promptState(mem({ kind: "preference" })),
                   { in: true, why: "always — it's an instruction" });
  assert.deepEqual(promptState(mem({ pinned: true })), { in: true, why: "pinned" });
  assert.deepEqual(promptState(mem({ in_prompt: true })), { in: true, why: "fits" });
  const out = promptState(mem({ in_prompt: false }));
  assert.equal(out.in, false);
  assert.match(out.why, /pin it/);
  assert.match(promptState(mem({ superseded_by: "x" })).why, /replaced/);
});

test("a preference is never offered a pin, because it is already exempt", () => {
  // Offering it would imply pinning changes something.
  assert.equal(rowActions(mem({ kind: "preference" })).pin, false);
  assert.equal(rowActions(mem({ kind: "fact" })).pin, true);
});

test("a pinned row offers Unpin and not Pin", () => {
  const a = rowActions(mem({ pinned: true }));
  assert.equal(a.pin, false);
  assert.equal(a.unpin, true);
});

test("a superseded row offers Bring back, and nothing that assumes it is live", () => {
  // Restore is the way out of a wrong replacement — the loose supersede
  // matcher can retire the wrong memory, and without this it was permanent.
  const a = rowActions(mem({ superseded_by: "x" }));
  assert.deepEqual(a, { pin: false, unpin: false, supersede: false,
                        restore: true, remove: true });
});

test("a live row is never offered Bring back", () => {
  assert.equal(rowActions(mem()).restore, false);
  assert.equal(rowActions(mem({ pinned: true })).restore, false);
});

test("the budget summary warns only when something is being left out", () => {
  assert.equal(budgetSummary({ used: 100, budget: 2000, omitted: 0, total: 3,
                               in_prompt: [] }).tone, "good");
  const warn = budgetSummary({ used: 2000, budget: 2000, omitted: 12, total: 40,
                               in_prompt: [] });
  assert.equal(warn.tone, "warn");
  assert.match(warn.text, /12 of 40/);
  assert.match(warn.text, /pin/);
});

test("no budget yet renders nothing rather than a zero", () => {
  assert.equal(budgetSummary(null).text, "");
});

const form = (over: Partial<MemoryForm> = {}): MemoryForm => ({
  ...EMPTY_MEMORY, body: "prefers dark mode", ...over,
});

test("a complete form is valid", () => {
  assert.deepEqual(validateMemory(form()), {});
  assert.ok(canSaveMemory(form()));
});

test("an empty or enormous body is refused", () => {
  assert.ok(validateMemory(form({ body: "   " })).body);
  assert.ok(validateMemory(form({ body: "x".repeat(600) })).body);
});

test("a project memory needs a slug and the others do not", () => {
  assert.ok(needsSlug("project") && needsSlug("observation"));
  assert.ok(!needsSlug("fact") && !needsSlug("preference") && !needsSlug("day"));
  assert.ok(validateMemory(form({ kind: "project", subject: "" })).subject);
  assert.ok(validateMemory(form({ kind: "project", subject: "Not A Slug" })).subject);
  assert.deepEqual(validateMemory(form({ kind: "project", subject: "yuri-code" })), {});
});

test("the body sent forces subject to user for the kinds that take none", () => {
  // Matching the domain, which corrects rather than refuses — a slug on a
  // preference is meaningless and would make it unselectable.
  assert.equal(memoryBody(form({ kind: "fact", subject: "yuri-code" })).subject, "user");
  assert.equal(memoryBody(form({ kind: "project", subject: "yuri-code" })).subject, "yuri-code");
});

test("the body sent is trimmed", () => {
  assert.equal(memoryBody(form({ body: "  spaced  " })).body, "spaced");
});
