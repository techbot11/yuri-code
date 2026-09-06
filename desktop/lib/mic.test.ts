import test from "node:test";
import assert from "node:assert/strict";
import { MIC_SETTINGS_URL, micNeedsSaying, normalizeMicStatus } from "./mic.ts";

test("Electron's four statuses pass through", () => {
  for (const s of ["not-determined", "granted", "denied", "restricted"]) {
    assert.equal(normalizeMicStatus(s), s);
  }
});

test("anything else is unknown, not a crash and not a silent 'granted'", () => {
  // getMediaAccessStatus is documented for macOS and Windows; a future value
  // or another platform must not be read as permission we do not have.
  for (const s of ["", "GRANTED", "yes", "undefined"]) {
    assert.equal(normalizeMicStatus(s), "unknown", s);
  }
});

test("only denied and restricted are worth a row", () => {
  // Granted needs no row: an always-green checklist entry is furniture.
  // not-determined needs none either: the TCC prompt appears on the first
  // getUserMedia, and pre-announcing it tells the reader nothing to act on.
  assert.equal(micNeedsSaying("denied"), true);
  assert.equal(micNeedsSaying("restricted"), true);
  assert.equal(micNeedsSaying("granted"), false);
  assert.equal(micNeedsSaying("not-determined"), false);
  assert.equal(micNeedsSaying("unknown"), false);
});

test("the settings URL opens the microphone pane specifically", () => {
  assert.equal(MIC_SETTINGS_URL,
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
});
