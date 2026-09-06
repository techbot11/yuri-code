import test from "node:test";
import assert from "node:assert/strict";
import { isUnreachable, proxyFailure } from "./proxyError.ts";

test("a refused connection is unreachable, not a server error", () => {
  // What fetch actually throws when nothing is listening.
  assert.equal(isUnreachable(new TypeError("fetch failed")), true);
  assert.equal(isUnreachable(new Error("connect ECONNREFUSED 127.0.0.1:8000")), true);
  assert.equal(isUnreachable(new Error("getaddrinfo ENOTFOUND localhost")), true);
});

test("an ordinary bug is NOT reported as an absent backend", () => {
  // The inverse mistake: disguising a real defect as "still starting up" would
  // send the reader to wait for something that is never coming.
  assert.equal(isUnreachable(new RangeError("index out of range")), false);
  assert.equal(isUnreachable(new Error("Cannot read properties of undefined")), false);
});

test("unreachable is 503 and says so in words the field can render", () => {
  const f = proxyFailure(new TypeError("fetch failed"));
  assert.equal(f.status, 503);
  assert.match(f.detail, /not answering/);
  // The bug this replaces: a bare 500 whose only text was "HTTP 500".
  assert.doesNotMatch(f.detail, /^HTTP/);
});

test("anything else keeps its own message and a 500", () => {
  const f = proxyFailure(new RangeError("bad index"));
  assert.equal(f.status, 500);
  assert.match(f.detail, /bad index/);
});

test("a thrown non-Error still produces a message", () => {
  assert.match(proxyFailure("boom").detail, /boom/);
});
