import test from "node:test";
import assert from "node:assert/strict";
import { isAppUrl } from "./urls.ts";

const APP = "http://localhost:3000";

test("the app's own pages are the app's", () => {
  assert.equal(isAppUrl("http://localhost:3000", APP), true);
  assert.equal(isAppUrl("http://localhost:3000/", APP), true);
  assert.equal(isAppUrl("http://localhost:3000/missions/templates", APP), true);
  assert.equal(isAppUrl("http://localhost:3000/setup?x=1#y", APP), true);
});

test("a userinfo prefix does not make evil.com ours", () => {
  // The verified bypass: a VALID url whose host is evil.com and whose
  // username is "localhost", which begins with the app's origin exactly.
  assert.equal(isAppUrl("http://localhost:3000@evil.com/", APP), false);
  assert.equal(isAppUrl("http://localhost:3000:pw@evil.com/", APP), false);
});

test("a longer port that shares a prefix is not ours", () => {
  assert.equal(isAppUrl("http://localhost:30001", APP), false);
  assert.equal(isAppUrl("http://localhost:3000.evil.com", APP), false);
});

test("a different scheme or host is not ours", () => {
  assert.equal(isAppUrl("https://localhost:3000/", APP), false, "https is a different origin");
  assert.equal(isAppUrl("http://127.0.0.1:3000/", APP), false, "not the same host name");
  assert.equal(isAppUrl("http://evil.com/", APP), false);
});

test("what cannot be parsed is not ours", () => {
  // Failing closed sends it to the browser, which is safe. Failing open
  // navigates the trusted window.
  for (const bad of ["", "not a url", "javascript:alert(1)", "//evil.com"]) {
    assert.equal(isAppUrl(bad, APP), false, bad);
  }
});

test("a dangerous scheme is never ours, even pointing at our own host", () => {
  assert.equal(isAppUrl("javascript:location='http://localhost:3000'", APP), false);
  assert.equal(isAppUrl("file:///etc/passwd", APP), false);
});
