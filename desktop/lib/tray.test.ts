import test from "node:test";
import assert from "node:assert/strict";
import { TRAY_STATES, trayLabel, trayState, type TrayFacts, type TrayState } from "./tray.ts";

const facts = (over: Partial<TrayFacts> = {}): TrayFacts => ({
  voiceConnected: false, speaking: false, thinking: false,
  missionsRunning: 0, approvalsPending: 0, ...over,
});

test("not connected is asleep, and says so honestly", () => {
  // "Idle" would imply she is listening and merely quiet. She is not.
  assert.equal(trayState(facts()), "asleep");
  assert.match(trayLabel("asleep"), /not listening/i);
});

test("connected and quiet is listening", () => {
  assert.equal(trayState(facts({ voiceConnected: true })), "listening");
});

test("speaking outranks listening", () => {
  assert.equal(trayState(facts({ voiceConnected: true, speaking: true })), "speaking");
});

test("thinking outranks listening", () => {
  assert.equal(trayState(facts({ voiceConnected: true, thinking: true })), "thinking");
});

test("speaking outranks thinking", () => {
  assert.equal(trayState(facts({ voiceConnected: true, thinking: true, speaking: true })),
               "speaking");
});

test("a running mission shows as working even while she talks", () => {
  // Work continuing in the background is the more useful fact: the user can
  // hear that she is speaking.
  assert.equal(trayState(facts({ voiceConnected: true, speaking: true, missionsRunning: 1 })),
               "working");
});

test("a pending approval outranks EVERYTHING", () => {
  // This is the state the tray exists for. A blocked agent behind a hidden
  // window is invisible without it.
  assert.equal(trayState(facts({ approvalsPending: 1 })), "needs-you");
  assert.equal(trayState(facts({ voiceConnected: true, speaking: true,
                                 missionsRunning: 3, approvalsPending: 1 })), "needs-you");
});

test("needs-you is reported even while she is asleep", () => {
  // Voice being disconnected does not make a blocked agent less blocked.
  assert.equal(trayState(facts({ voiceConnected: false, approvalsPending: 2 })), "needs-you");
});

test("every state has a label a person would understand", () => {
  for (const s of
    ["asleep", "listening", "thinking", "speaking", "working", "needs-you"] as const) {
    const label = trayLabel(s);
    assert.ok(label.length > 4, s);
    assert.doesNotMatch(label, /-/, `${s}: the label must not be the slug`);
  }
});

test("thinking's label reads distinct from working's", () => {
  // "Working on something" means missions are running -- a different fact.
  // "Thinking" must not be confusable with it.
  assert.notEqual(trayLabel("thinking"), trayLabel("working"));
  assert.doesNotMatch(trayLabel("thinking"), /working on something/i);
});

test("TRAY_STATES covers every state trayState can return", () => {
  // The IPC handler validates against this list, so a state missing from it
  // is a state the tray silently refuses to show.
  const reachable = new Set<TrayState>([
    trayState(facts()),
    trayState(facts({ voiceConnected: true })),
    trayState(facts({ voiceConnected: true, thinking: true })),
    trayState(facts({ voiceConnected: true, speaking: true })),
    trayState(facts({ missionsRunning: 1 })),
    trayState(facts({ approvalsPending: 1 })),
  ]);
  for (const s of reachable) {
    assert.ok(TRAY_STATES.includes(s), `${s} is reachable but not in TRAY_STATES`);
  }
  assert.equal(TRAY_STATES.length, reachable.size,
    "TRAY_STATES has an entry no input can produce, or is missing one");
  assert.equal(new Set(TRAY_STATES).size, TRAY_STATES.length, "no duplicates");
});
