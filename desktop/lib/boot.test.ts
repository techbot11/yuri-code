import test from "node:test";
import assert from "node:assert/strict";
import { applyBootEvent, bootPhase, initialBoot } from "./boot.ts";

test("both children start out starting, and the phase is starting", () => {
  const s = initialBoot();
  assert.equal(s.backend, "starting");
  assert.equal(s.frontend, "starting");
  assert.equal(bootPhase(s), "starting");
});

test("the phase is ready only when BOTH are ready", () => {
  let s = applyBootEvent(initialBoot(), { type: "ready", child: "backend" });
  assert.equal(bootPhase(s), "starting", "one ready child is not a ready app");
  s = applyBootEvent(s, { type: "ready", child: "frontend" });
  assert.equal(bootPhase(s), "ready");
});

test("either child failing fails the boot, and carries the reason", () => {
  const s = applyBootEvent(initialBoot(),
    { type: "failed", child: "backend", detail: "ModuleNotFoundError: uvicorn" });
  assert.equal(bootPhase(s), "failed");
  assert.equal(s.error?.child, "backend");
  assert.match(s.error!.detail, /uvicorn/);
});

test("a failure survives the other child succeeding afterwards", () => {
  // Otherwise the boot window would flip to "ready" while one server is dead,
  // and the user would get an app whose every action fails.
  let s = applyBootEvent(initialBoot(),
    { type: "failed", child: "backend", detail: "port in use" });
  s = applyBootEvent(s, { type: "ready", child: "frontend" });
  assert.equal(bootPhase(s), "failed");
  assert.equal(s.error?.child, "backend");
});

test("the FIRST failure is the one reported", () => {
  // The second is usually a consequence -- the frontend cannot proxy to a
  // backend that never came up -- and the first is the one worth showing.
  let s = applyBootEvent(initialBoot(),
    { type: "failed", child: "backend", detail: "first" });
  s = applyBootEvent(s, { type: "failed", child: "frontend", detail: "second" });
  assert.equal(s.error?.detail, "first");
});

test("applying an event does not mutate the state it was given", () => {
  // The boot window renders from this; a mutated object would make a stale
  // render indistinguishable from a fresh one.
  const before = initialBoot();
  const after = applyBootEvent(before, { type: "ready", child: "backend" });
  assert.equal(before.backend, "starting");
  assert.notEqual(before, after);
});

test("a child that failed never becomes ready afterwards", () => {
  // The false-ready bug: a stranger answering on the port reported ready
  // while the real child was still dying. Whatever order the events arrive
  // in, a failure must stick.
  let s = applyBootEvent(initialBoot(), { type: "failed", child: "backend", detail: "port busy" });
  s = applyBootEvent(s, { type: "ready", child: "backend" });
  assert.equal(s.backend, "failed");
  assert.equal(bootPhase(s), "failed");
});
