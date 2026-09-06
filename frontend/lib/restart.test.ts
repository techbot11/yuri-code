import test from "node:test";
import assert from "node:assert/strict";
import { restartImpact } from "./restart.ts";

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
  // still be named, because a restart drops it.
  const r = restartImpact(0, 2);
  assert.equal(r.safe, true);
  assert.match(r.warning, /2 sessions/);
});

test("both: the mission's refusal wins and both are named", () => {
  const r = restartImpact(2, 1);
  assert.equal(r.safe, false);
  assert.match(r.warning, /2 missions/);
  assert.match(r.warning, /1 session\b/);
});

test("negative or nonsense counts are treated as none, not as a refusal", () => {
  // A count arriving as -1 from a failed fetch must not permanently disable
  // the button with a warning about minus one mission.
  const r = restartImpact(-1, -5);
  assert.equal(r.safe, true);
  assert.equal(r.warning, "");
});
