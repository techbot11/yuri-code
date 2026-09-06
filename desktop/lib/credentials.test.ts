import test from "node:test";
import assert from "node:assert/strict";
import {
  isSecretKey, parseCredentials, serializeCredentials, SECRET_KEYS,
} from "./credentials.ts";

test("a round trip preserves every value", () => {
  const values = { GEMINI_API_KEY: "g-1", ANTHROPIC_AUTH_TOKEN: "a-2" };
  assert.deepEqual(parseCredentials(serializeCredentials(values)), values);
});

test("values containing newlines and quotes survive", () => {
  // The reason this is JSON and not dotenv: a token with a newline in it
  // silently truncates a KEY=VALUE file, and one with a quote corrupts it.
  const values = { ANTHROPIC_AUTH_TOKEN: 'a\n"b"\nc', GEMINI_API_KEY: "x=y#z" };
  assert.deepEqual(parseCredentials(serializeCredentials(values)), values);
});

test("unreadable ciphertext yields no credentials rather than throwing", () => {
  // A corrupt or truncated file must degrade to "no keys set", which Setup
  // already handles, not crash the main process before a window exists.
  for (const raw of ["", "not json", "{}", '{"version":1}', "null", "[]"]) {
    assert.deepEqual(parseCredentials(raw), {}, raw);
  }
});

test("a future version is not guessed at", () => {
  assert.deepEqual(parseCredentials('{"version":2,"values":{"A":"b"}}'), {});
});

test("non-string values are dropped, not coerced", () => {
  assert.deepEqual(
    parseCredentials('{"version":1,"values":{"A":"b","B":7,"C":null,"D":{}}}'),
    { A: "b" });
});

test("the secret set matches config.py's MANAGED_KEYS with secret=True", () => {
  // Kept in step by hand across a process boundary; this test is the record
  // of what it must match. backend/config.py is the source of truth.
  //
  // Verified directly against config.py (2026-09-06):
  //   .venv/bin/python -c "import config; print(sorted(k.name for k in
  //   config.MANAGED_KEYS if k.secret))"
  // -> ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, AZURE_OPENAI_API_KEY,
  //    GEMINI_API_KEY, OPENAI_API_KEY -- five keys, not four. An earlier
  //    draft of this list omitted AZURE_OPENAI_API_KEY, which would have
  //    left that one credential being written to a plaintext dotfile while
  //    the other four moved to the Keychain.
  assert.deepEqual([...SECRET_KEYS].sort(), [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AZURE_OPENAI_API_KEY",
    "GEMINI_API_KEY", "OPENAI_API_KEY",
  ]);
});

test("only secret keys are accepted for encryption", () => {
  assert.equal(isSecretKey("GEMINI_API_KEY"), true);
  assert.equal(isSecretKey("AZURE_OPENAI_API_KEY"), true);
  // Non-secrets belong in the .env file, not the Keychain: they are paths and
  // ports a user may reasonably want to read and edit in a text editor.
  assert.equal(isSecretKey("YURI_HOME"), false);
  assert.equal(isSecretKey("ALLOWED_PROJECT_ROOTS"), false);
  assert.equal(isSecretKey(""), false);
});
