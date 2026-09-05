import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  GIVE_UP_AFTER_MS, MAX_DELAY_MS,
  retryDelayMs, shouldGiveUp, waitMessage, waitPhase,
} from "./backendWait.ts";

test("the first check (attempt 0) has no delay of its own", () => {
  // retryDelayMs is only ever consulted BEFORE a retry, i.e. for n >= 1, but
  // a caller passing 0 (or a negative attempt count) must still get a sane,
  // small delay rather than NaN or a throw.
  assert.equal(retryDelayMs(0), retryDelayMs(1));
  assert.ok(retryDelayMs(0) > 0);
});

test("delays grow between retries, monotonically", () => {
  const delays = [1, 2, 3, 4, 5].map(retryDelayMs);
  for (let i = 1; i < delays.length; i++) {
    assert.ok(delays[i] >= delays[i - 1], `attempt ${i + 1} did not grow: ${delays}`);
  }
});

test("delay is capped, so a long wait never goes past MAX_DELAY_MS", () => {
  for (const n of [10, 20, 50, 1000]) {
    assert.ok(retryDelayMs(n) <= MAX_DELAY_MS);
  }
});

test("do not hammer: a full give-up window of retries is far fewer than a 250ms poll would be", () => {
  // The reported concern: a naive 250ms poll for the backend's measured
  // 6-16s cold start is 24-64 pointless requests. Sum how many retries this
  // schedule actually fires inside the give-up window.
  let elapsed = 0;
  let attempts = 0;
  while (elapsed < GIVE_UP_AFTER_MS) {
    attempts++;
    elapsed += retryDelayMs(attempts);
  }
  assert.ok(attempts < 20, `expected well under 20 requests in ${GIVE_UP_AFTER_MS}ms, got ${attempts}`);
});

test("give-up is a hard bound at GIVE_UP_AFTER_MS", () => {
  assert.equal(shouldGiveUp(GIVE_UP_AFTER_MS - 1), false);
  assert.equal(shouldGiveUp(GIVE_UP_AFTER_MS), true);
  assert.equal(shouldGiveUp(GIVE_UP_AFTER_MS + 1000), true);
});

test("phase is 'checking' only for the very first attempt, before giving up", () => {
  assert.equal(waitPhase(0, 0), "checking");
  assert.equal(waitPhase(0, 1000), "checking");
});

test("phase is 'waiting' once a retry has happened, before giving up", () => {
  assert.equal(waitPhase(1, 2000), "waiting");
  assert.equal(waitPhase(5, GIVE_UP_AFTER_MS - 1), "waiting");
});

test("phase is 'failed' once the give-up bound passes, regardless of attempt count", () => {
  assert.equal(waitPhase(0, GIVE_UP_AFTER_MS), "failed");
  assert.equal(waitPhase(1, GIVE_UP_AFTER_MS), "failed");
  assert.equal(waitPhase(99, GIVE_UP_AFTER_MS + 5000), "failed");
});

test("every phase has its own, non-empty message", () => {
  const phases: Array<"checking" | "waiting" | "failed"> = ["checking", "waiting", "failed"];
  const messages = phases.map(waitMessage);
  assert.ok(messages.every((m) => m.trim().length > 0));
  assert.equal(new Set(messages).size, messages.length, "messages must not collide");
});

test("the failed message does not read as a still-in-progress state", () => {
  assert.doesNotMatch(waitMessage("failed"), /starting|looking/i);
});
