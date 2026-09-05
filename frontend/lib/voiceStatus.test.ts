import test from "node:test";
import assert from "node:assert/strict";
import { failure } from "./voiceStatus.ts";

test("progress and the idle prompt are not interruptions", () => {
  // A button that already says "Connect voice" does not need a caption
  // repeating that you may connect.
  assert.equal(failure("Tap connect and start talking."), "");
  assert.equal(failure("Minting token..."), "");
  assert.equal(failure("Opening WebRTC..."), "");
  assert.equal(failure("Connected — start talking."), "");
});

test("nothing at all is not an interruption either", () => {
  assert.equal(failure(undefined), "");
  assert.equal(failure(""), "");
  assert.equal(failure("   "), "");
});

test("a failure is surfaced, with its prefix stripped", () => {
  // The wrapped message usually starts with a verb, so "Failed: Microphone
  // access was refused" reads worse than the reason alone.
  assert.equal(failure("Failed: Microphone access was refused."),
               "Microphone access was refused.");
  assert.equal(failure("Failed:   SDP exchange failed: 400"),
               "SDP exchange failed: 400");
});

test("only the exact prefix counts", () => {
  // "Failed" appearing mid-sentence is a progress line, not a verdict.
  assert.equal(failure("Negotiating (last attempt Failed) ..."), "");
});
