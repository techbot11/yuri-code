import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { TRAY_STATES, trayLabel, type TrayState } from "./tray.ts";

// This file used to spend most of its tests on a trayState(TrayFacts)
// function in lib/tray.ts that nothing outside this file called -- including
// one named for cross-checking frontend/lib/trayState.ts that never
// referenced it. Both are gone. What is left is what main/tray.ts actually
// uses: the list it validates the renderer's answer against, the icon each
// entry needs, and the labels.
//
// TRAY_STATES matching the TrayState union is no longer a test's job at all:
// it is derived from a Record<TrayState, true> in lib/tray.ts, so `tsc`
// rejects a drift that a test here could only notice after the fact.

test("every state in TRAY_STATES has a menu-bar icon on disk", () => {
  // main/tray.ts's iconFor() builds this exact path, and nativeImage returns
  // an EMPTY image for a missing file rather than throwing -- so a state
  // added without its asset shows a blank menu bar and says nothing.
  for (const s of TRAY_STATES) {
    const asset = path.join(import.meta.dirname, "..", "assets", `${s}Template@2x.png`);
    assert.ok(fs.existsSync(asset), `${s} has no icon at assets/${s}Template@2x.png`);
  }
});

test("TRAY_STATES has no duplicates and is not empty", () => {
  assert.ok(TRAY_STATES.length > 0);
  assert.equal(new Set(TRAY_STATES).size, TRAY_STATES.length);
});

test("asleep says so honestly rather than calling itself idle", () => {
  // "Idle" would imply she is listening and merely quiet. She is not.
  assert.match(trayLabel("asleep"), /not listening/i);
});

test("every state has a label a person would understand", () => {
  for (const s of TRAY_STATES) {
    const label = trayLabel(s as TrayState);
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
