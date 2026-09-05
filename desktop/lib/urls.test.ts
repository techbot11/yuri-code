import test from "node:test";
import assert from "node:assert/strict";
import { externalOpenScheme, isAppUrl } from "./urls.ts";

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

test("only http and https may be handed to the OS to open", () => {
  // shell.openExternal() launches whatever the OS has registered for the
  // scheme. `file:` opens a local path; a custom scheme starts a local app
  // with an argument the page chose.
  assert.equal(externalOpenScheme("https://example.com/x").ok, true);
  assert.equal(externalOpenScheme("http://example.com/x").ok, true);
  for (const bad of [
    "file:///etc/passwd",
    "file:///Applications/Calculator.app",
    "smb://attacker/share",
    "vscode://file/Users/me/.ssh/id_rsa",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ms-msdt:/id",
    "not a url at all",
    "",
  ]) {
    assert.equal(externalOpenScheme(bad).ok, false, bad);
  }
});

test("the rejected scheme is reported, so a refusal can say what it refused", () => {
  // The scheme and nothing else: a URL can carry a token in its query, and
  // the main process's log is the wrong place for that to turn up.
  assert.equal(externalOpenScheme("file:///etc/passwd").scheme, "file:");
  assert.equal(externalOpenScheme("vscode://file/x").scheme, "vscode:");
  assert.equal(externalOpenScheme("garbage").scheme, "", "unparseable has no scheme");
});
