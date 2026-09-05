import test from "node:test";
import assert from "node:assert/strict";
import {
  blocking, canSave, effectLabel, effectsSentence, gateOpen, pendingChanges,
  type DoctorCheck, type ManagedKey,
} from "./setup.ts";

const check = (over: Partial<DoctorCheck> = {}): DoctorCheck => ({
  name: "claude", ok: true, detail: "/opt/homebrew/bin/claude", required: true, ...over,
});

const key = (over: Partial<ManagedKey> = {}): ManagedKey => ({
  name: "GEMINI_API_KEY", label: "Gemini API key", secret: true, effect: "now",
  blurb: "Lets her talk over Gemini Live.", set: false, hint: "", source: "not set",
  ...over,
});

test("only a FAILING REQUIRED check blocks", () => {
  // tmux failing costs the live terminal pane, not the app — so it must not
  // hold the whole UI hostage.
  const rows = [
    check({ name: "claude", ok: true }),
    check({ name: "tmux", ok: false, required: false }),
    check({ name: "voice keys", ok: false, required: true }),
  ];
  assert.deepEqual(blocking(rows).map((c) => c.name), ["voice keys"]);
});

test("the gate is open when every required check passes", () => {
  assert.equal(gateOpen([check({ ok: true }), check({ name: "tmux", ok: false, required: false })]), true);
  assert.equal(gateOpen([check({ ok: false })]), false);
});

test("the gate stays SHUT while the checks are unknown", () => {
  // null is "not loaded yet". Treating it as open would flash the whole app
  // and then yank it away; treating it as shut shows the boot state, which is
  // what is actually true.
  assert.equal(gateOpen(null), false);
});

test("an empty check list does not silently open the gate", () => {
  // No checks means the endpoint told us nothing, not that all is well.
  assert.equal(gateOpen([]), false);
});

test("each effect scope has plain words", () => {
  assert.match(effectLabel("now"), /now|straight away|immediately/i);
  assert.match(effectLabel("next-session"), /next/i);
  assert.match(effectLabel("restart"), /restart/i);
});

test("the effects sentence names the strongest requirement", () => {
  assert.match(effectsSentence(["now"]), /now|straight away|immediately/i);
  assert.match(effectsSentence(["now", "restart"]), /restart/i,
    "a change needing a restart must not be reported as taking effect now");
  assert.equal(effectsSentence([]), "");
});

test("a pending change is one that differs from what is saved", () => {
  const keys = [key({ name: "ANTHROPIC_MODEL", secret: false, set: true, hint: "claude-opus-5" }),
                key({ name: "GEMINI_API_KEY", set: true, hint: "…4f2a" })];
  // Same value as the visible hint on a NON-secret is not a change.
  assert.deepEqual(pendingChanges(keys, { ANTHROPIC_MODEL: "claude-opus-5" }), []);
  assert.deepEqual(pendingChanges(keys, { ANTHROPIC_MODEL: "claude-sonnet-5" }),
                   ["ANTHROPIC_MODEL"]);
});

test("typing into a SECRET field is always a change", () => {
  // Its current value is unknown to the client by design, so it can never be
  // compared — anything typed has to be treated as new.
  const keys = [key({ name: "GEMINI_API_KEY", set: true, hint: "…4f2a" })];
  assert.deepEqual(pendingChanges(keys, { GEMINI_API_KEY: "anything" }),
                   ["GEMINI_API_KEY"]);
});

test("clearing a set key is a change; clearing an unset one is not", () => {
  const set = [key({ name: "ANTHROPIC_MODEL", secret: false, set: true, hint: "m1" })];
  assert.deepEqual(pendingChanges(set, { ANTHROPIC_MODEL: "" }), ["ANTHROPIC_MODEL"]);
  const unset = [key({ name: "ANTHROPIC_MODEL", secret: false, set: false, hint: "" })];
  assert.deepEqual(pendingChanges(unset, { ANTHROPIC_MODEL: "" }), []);
});

test("an untouched field is never a change", () => {
  const keys = [key({ name: "GEMINI_API_KEY", set: true, hint: "…4f2a" })];
  assert.deepEqual(pendingChanges(keys, {}), []);
});

test("save needs at least one pending change", () => {
  const keys = [key({ name: "ANTHROPIC_MODEL", secret: false, set: false })];
  assert.equal(canSave(keys, {}), false);
  assert.equal(canSave(keys, { ANTHROPIC_MODEL: "  " }), false, "whitespace is not a value");
  assert.equal(canSave(keys, { ANTHROPIC_MODEL: "claude-opus-5" }), true);
});
