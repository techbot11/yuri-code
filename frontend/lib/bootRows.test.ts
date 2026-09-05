import test from "node:test";
import assert from "node:assert/strict";
import { bootDetail, bootRows, type YuriBootState } from "./bootRows.ts";

function state(over: Partial<YuriBootState> = {}): YuriBootState {
  return {
    phase: "starting", env: "ready", envDetail: "",
    backend: "starting", frontend: "ready", errorDetail: "", ...over,
  };
}

test("no bridge means no checklist, not a checklist of unknowns", () => {
  assert.deepEqual(bootRows(null, 5000), []);
  assert.deepEqual(bootRows(undefined, 5000), []);
});

test("rows are env, interface, backend in that order", () => {
  assert.deepEqual(bootRows(state(), 0).map((r) => r.key),
    ["env", "frontend", "backend"]);
  assert.deepEqual(bootRows(state(), 0).map((r) => r.label),
    ["Environment", "Interface", "Backend"]);
});

test("each row carries its own state through", () => {
  const rows = bootRows(state({ env: "failed", frontend: "ready", backend: "starting" }), 0);
  assert.deepEqual(rows.map((r) => r.state), ["failed", "ready", "starting"]);
});

test("elapsed shows against the still-starting row", () => {
  const rows = bootRows(state(), 12_400);
  assert.equal(rows.find((r) => r.key === "backend")?.note, "12s");
  assert.equal(rows.find((r) => r.key === "env")?.note, "");
  assert.equal(rows.find((r) => r.key === "frontend")?.note, "");
});

test("only the FIRST still-starting row is noted — one clock, one counter", () => {
  const rows = bootRows(state({ frontend: "starting", backend: "starting" }), 9000);
  assert.equal(rows.find((r) => r.key === "frontend")?.note, "9s");
  assert.equal(rows.find((r) => r.key === "backend")?.note, "",
    "a second counter ticking in step reads as a second measurement");
});

test("nothing is starting: no counter anywhere", () => {
  const rows = bootRows(state({ backend: "ready" }), 30_000);
  assert.deepEqual(rows.map((r) => r.note), ["", "", ""]);
});

test("sub-second elapsed shows no counter", () => {
  // A "0s" visible for one frame reads as a glitch, not a measurement.
  assert.deepEqual(bootRows(state(), 0).map((r) => r.note), ["", "", ""]);
  assert.deepEqual(bootRows(state(), 999).map((r) => r.note), ["", "", ""]);
  assert.equal(bootRows(state(), 1000).find((r) => r.key === "backend")?.note, "1s");
});

test("a failed environment reports its own detail, which has no other home", () => {
  assert.equal(
    bootDetail(state({ env: "failed", envDetail: "login shell exited 127", errorDetail: "no key" })),
    "login shell exited 127",
    "the env failure comes first causally; the backend's complaint is its symptom");
});

test("otherwise the boot error is the detail", () => {
  assert.equal(bootDetail(state({ backend: "failed", errorDetail: "port 8000 in use" })),
    "port 8000 in use");
  assert.equal(bootDetail(state()), "");
  assert.equal(bootDetail(null), "");
});

test("a failed env with no detail falls back rather than showing nothing", () => {
  assert.equal(bootDetail(state({ env: "failed", envDetail: "", errorDetail: "backend died" })),
    "backend died");
});
