import test from "node:test";
import assert from "node:assert/strict";
import { MIC_TIMED_OUT, MIC_TIMEOUT_MS, micErrorMessage } from "./mic.ts";

const err = (name: string, message = "") => Object.assign(new Error(message), { name });

test("a refused permission says how to un-refuse it", () => {
  for (const name of ["NotAllowedError", "SecurityError"]) {
    const msg = micErrorMessage(err(name));
    assert.match(msg, /refused/i);
    assert.match(msg, /address bar/i, `${name} must say where to fix it`);
  }
});

test("a device already in use names the likely culprit", () => {
  // The reported case: a second tab of this same app was holding the mic.
  for (const name of ["NotReadableError", "AbortError"]) {
    assert.match(micErrorMessage(err(name)), /in use|another tab/i, name);
  }
});

test("a missing device is not reported as a permission problem", () => {
  // These are different fixes: plug something in vs allow the site.
  for (const name of ["NotFoundError", "OverconstrainedError"]) {
    const msg = micErrorMessage(err(name));
    assert.match(msg, /no microphone/i, name);
    assert.doesNotMatch(msg, /refused|address bar/i, name);
  }
});

test("a timeout tells the user to close the other tab", () => {
  const msg = micErrorMessage(err(MIC_TIMED_OUT));
  assert.match(msg, /didn't respond|did not respond/i);
  assert.match(msg, /other Yuri tab/i);
});

test("an unknown failure still says something concrete", () => {
  // Never an empty string: a silent failure is the bug this file exists for.
  assert.match(micErrorMessage(err("SomethingNew", "gremlins")), /gremlins/);
  assert.match(micErrorMessage(err("SomethingNew")), /Could not open the microphone/);
  assert.match(micErrorMessage(null), /Could not open the microphone/);
  assert.match(micErrorMessage("a bare string"), /Could not open the microphone/);
});

test("the timeout leaves room to answer a permission prompt", () => {
  // Short enough that a wedged device does not hang the connect forever, long
  // enough that a user reading the browser's prompt is not cut off.
  assert.ok(MIC_TIMEOUT_MS >= 15_000, "too short to answer a prompt");
  assert.ok(MIC_TIMEOUT_MS <= 60_000, "too long to be a bound worth having");
});
