import test from "node:test";
import assert from "node:assert/strict";
import { restartImpact, restartRanNote } from "./restart.ts";

test("nothing running: safe, and no warning to show", () => {
  const r = restartImpact(0, 0);
  assert.equal(r.safe, true);
  assert.equal(r.warning, "");
});

test("a running mission is named and blocks the restart", () => {
  // The spec's requirement: refuse while a mission is running, or say what it
  // will interrupt. A mission is work she is doing unattended, so it is
  // refused rather than merely warned about.
  const r = restartImpact(1, 0);
  assert.equal(r.safe, false);
  assert.match(r.warning, /1 mission/);
});

test("several missions are counted, not pluralised wrongly", () => {
  assert.match(restartImpact(3, 0).warning, /3 missions/);
  assert.match(restartImpact(1, 0).warning, /1 mission\b/);
});

test("live sessions warn but do not block", () => {
  // A session is attended -- someone is sitting there and can decide. It must
  // still be named, because a restart interrupts it.
  const r = restartImpact(0, 2);
  assert.equal(r.safe, true);
  assert.match(r.warning, /2 sessions/);
});

test("a session is NOT described as stopped, because it is not stopped", () => {
  // The claim being guarded, and the one this sentence used to get wrong:
  // stopServers() leaves tmux panes alone, KILL_SESSIONS_ON_SHUTDOWN defaults
  // to False so tmux_runner.shutdown() detaches rather than kills, and
  // backend/main.py rehydrates on the next start. So "Restarting stops 2
  // sessions" was false. Asserted as an ABSENCE on purpose: the four bugs of
  // this shape on this branch were all a string asserting something untrue,
  // which a test that only checks the true cases cannot catch.
  const r = restartImpact(0, 2);
  assert.doesNotMatch(r.warning, /stops/, "nothing about a session is stopped");
  assert.match(r.warning, /interrupts/, "what actually happens: a gap");
  assert.match(r.warning, /keep running/, "the agents outlive the restart");
  assert.match(r.warning, /come back/, "and she re-adopts the ones that do");
});

test("one session reads as one session, agent and all", () => {
  const r = restartImpact(0, 1);
  assert.match(r.warning, /1 session\b/);
  assert.match(r.warning, /its agent keeps running/);
  assert.doesNotMatch(r.warning, /stops/);
});

test("both: the mission's refusal wins, and each is described its own way", () => {
  const r = restartImpact(2, 1);
  assert.equal(r.safe, false);
  assert.match(r.warning, /stops 2 missions/, "a mission really does stop");
  assert.match(r.warning, /interrupts 1 session/, "a session does not");
});

// --- a restart the shell declined to run ----------------------------------

test("a declined cycle is reported as nothing having happened", () => {
  // runBootCycle() returns ran:false when its `booting` guard swallowed the
  // request. Nothing drained, nothing respawned, no error -- and the panel
  // used to show a plain success for it.
  const note = restartRanNote(false);
  assert.match(note, /Nothing was restarted/);
  assert.match(note, /already starting up/, "and why");
});

test("a cycle that ran, or a shell too old to say, gets no note", () => {
  // undefined is an older shell answering without the field: unknown is not
  // "declined", and inventing a claim from a missing field is the bug class
  // this whole round is about.
  assert.equal(restartRanNote(true), "");
  assert.equal(restartRanNote(undefined), "");
});

test("negative or nonsense counts are treated as none, not as a refusal", () => {
  // A count arriving as -1 from a failed fetch must not permanently disable
  // the button with a warning about minus one mission.
  const r = restartImpact(-1, -5);
  assert.equal(r.safe, true);
  assert.equal(r.warning, "");
});
