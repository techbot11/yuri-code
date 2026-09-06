import test from "node:test";
import assert from "node:assert/strict";
import { bootDetail, bootRows, type YuriBootState } from "./bootRows.ts";

function state(over: Partial<YuriBootState> = {}): YuriBootState {
  return {
    phase: "starting", env: "ready", envDetail: "",
    backend: "starting", frontend: "ready", errorDetail: "", mic: "granted", ...over,
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

test("the env row carries envDetail as its note, so the two cases look different", () => {
  // The whole point: the row goes green either way, but "using known
  // locations" means the login-shell probe FAILED and fell back — so a
  // model, gateway or PATH entry exported in the user's shell did not reach
  // the agents. Identical-looking rows hid exactly that.
  const shell = bootRows(state({ envDetail: "from your shell", backend: "ready" }), 0);
  const fallback = bootRows(state({ envDetail: "using known locations", backend: "ready" }), 0);
  assert.equal(shell.find((r) => r.key === "env")?.note, "from your shell");
  assert.equal(fallback.find((r) => r.key === "env")?.note, "using known locations");
  assert.notEqual(shell.find((r) => r.key === "env")?.note,
                  fallback.find((r) => r.key === "env")?.note);
});

test("only the env row gets envDetail — it is not a general note channel", () => {
  const rows = bootRows(state({ envDetail: "from your shell", backend: "ready" }), 0);
  assert.deepEqual(rows.map((r) => r.note), ["from your shell", "", ""]);
});

test("no envDetail yet means no note, not an empty gap with a stale value", () => {
  assert.equal(bootRows(state({ envDetail: "", backend: "ready" }), 0)
                 .find((r) => r.key === "env")?.note, "");
});

test("the elapsed counter beats envDetail on a row that could have both", () => {
  // Stated precedence, not an accident of ordering: "not frozen" is about
  // right now, a detail is about a step already finished. pushBoot never
  // actually sends a detail for a still-starting env, so this is the rule
  // for a case that should not arise rather than one that does.
  const rows = bootRows(state({ env: "starting", envDetail: "from your shell" }), 4000);
  assert.equal(rows.find((r) => r.key === "env")?.note, "4s");
  assert.equal(rows.find((r) => r.key === "backend")?.note, "",
    "and it is still only ONE counter");
});

test("a failed environment's detail outranks the boot error", () => {
  // Defensive: probeLoginEnv never fails outright, so nothing sends
  // env: "failed" today (see bootDetail). The precedence is what is pinned —
  // the env failure comes first causally, and the backend's complaint about
  // a missing key would be its symptom.
  assert.equal(
    bootDetail(state({ env: "failed", envDetail: "login shell exited 127", errorDetail: "no key" })),
    "login shell exited 127");
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

test("a denied microphone gets a failed row, after the others", () => {
  // Last, because it is a warning about something that will not work rather
  // than a step of the boot -- and the boot rows are in boot order.
  const rows = bootRows(state({ mic: "denied" }), 0);
  const last = rows[rows.length - 1];
  assert.equal(last.key, "mic");
  assert.equal(last.label, "Microphone");
  assert.equal(last.state, "failed");
});

test("a working microphone gets no row at all", () => {
  // An always-green row is furniture; the checklist is for what needs saying.
  for (const mic of ["granted", "not-determined", "unknown"] as const) {
    const keys = bootRows(state({ mic }), 0).map((r) => r.key);
    assert.ok(!keys.includes("mic"), `${mic} should be silent`);
    assert.equal(keys.length, 3, `${mic} should leave the three boot rows alone`);
  }
});

test("restricted says so too — it is not the same as granted", () => {
  assert.equal(bootRows(state({ mic: "restricted" }), 0).length, 4);
});

test("the elapsed counter never lands on the microphone row", () => {
  // The counter marks the first STILL-STARTING row; the mic row is failed, so
  // it must not absorb the count and leave the real one unmarked.
  const rows = bootRows(state({ mic: "denied", backend: "starting" }), 9000);
  assert.equal(rows.find((r) => r.key === "backend")?.note, "9s");
  assert.equal(rows.find((r) => r.key === "mic")?.note, "");
});
