import test from "node:test";
import assert from "node:assert/strict";
import { trayStateFor } from "./trayState.ts";

const f = (over: Partial<Parameters<typeof trayStateFor>[0]> = {}) => ({
  connected: false, vstate: "idle", missionsRunning: 0, approvalsPending: 0, ...over,
});

test("the priority order, highest first", () => {
  // This is the only implementation of the rule -- desktop/lib/tray.ts's
  // copy had no caller and has been deleted -- so these assertions are not
  // "both sides agree", they ARE the specification of the order.
  assert.equal(trayStateFor(f({ approvalsPending: 1, missionsRunning: 2,
                                connected: true, vstate: "speaking" })), "needs-you");
  assert.equal(trayStateFor(f({ missionsRunning: 1, connected: true,
                                vstate: "speaking" })), "working");
  assert.equal(trayStateFor(f({ connected: true, vstate: "speaking" })), "speaking");
  assert.equal(trayStateFor(f({ connected: true, vstate: "thinking" })), "thinking");
  assert.equal(trayStateFor(f({ connected: true })), "listening");
  assert.equal(trayStateFor(f()), "asleep");
});

test("thinking outranks listening but not speaking", () => {
  assert.equal(trayStateFor(f({ connected: true, vstate: "thinking" })), "thinking");
  assert.equal(trayStateFor(f({ connected: true, vstate: "speaking" })), "speaking");
});

test("hearing genuinely is listening", () => {
  assert.equal(trayStateFor(f({ connected: true, vstate: "hearing" })), "listening");
});

test("a pending approval reports even when voice is off", () => {
  assert.equal(trayStateFor(f({ approvalsPending: 3 })), "needs-you");
});
