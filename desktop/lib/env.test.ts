import test from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_PATH_DIRS, mergeEnv, parseEnvOutput, withFallbackPath,
} from "./env.ts";

test("a probed value wins over the inherited one", () => {
  // The whole point: launchd's environment is the one we must override.
  const got = mergeEnv({ PATH: "/usr/bin:/bin", TERM: "dumb" },
                       { PATH: "/opt/homebrew/bin:/usr/bin:/bin" });
  assert.equal(got.PATH, "/opt/homebrew/bin:/usr/bin:/bin");
  assert.equal(got.TERM, "dumb", "a variable the probe did not mention survives");
});

test("a blank probed value does not erase an inherited one", () => {
  // `env` in a login shell can print an empty assignment; treating that as
  // authoritative would blank a variable the app needs.
  const got = mergeEnv({ ANTHROPIC_BASE_URL: "https://gw/v1" },
                       { ANTHROPIC_BASE_URL: "" });
  assert.equal(got.ANTHROPIC_BASE_URL, "https://gw/v1");
});

test("a failed probe changes nothing", () => {
  const base = { PATH: "/usr/bin:/bin" };
  assert.deepEqual(mergeEnv(base, null), base);
});

test("env -0 output parses, including values containing '='", () => {
  // A base URL with a query string, or a token with padding, both contain '='.
  const text = "PATH=/usr/bin\0TOKEN=abc=def=\0EMPTY=\0";
  const got = parseEnvOutput(text);
  assert.equal(got.PATH, "/usr/bin");
  assert.equal(got.TOKEN, "abc=def=", "only the FIRST '=' separates name from value");
  assert.equal(got.EMPTY, "");
});

test("a line without '=' is skipped rather than becoming a blank key", () => {
  const got = parseEnvOutput("PATH=/usr/bin\0garbage\0HOME=/Users/x\0");
  assert.deepEqual(Object.keys(got).sort(), ["HOME", "PATH"]);
});

test("a shell banner does not swallow the first variable", () => {
  // Measured against a fake shell: without this, PATH was lost under a key
  // made of the banner while every later variable survived.
  const text = "Welcome!\nLast login: whenever\nPATH=/opt/homebrew/bin\0ANTHROPIC_MODEL=m\0";
  const got = parseEnvOutput(text);
  assert.equal(got.PATH, "/opt/homebrew/bin");
  assert.equal(got.ANTHROPIC_MODEL, "m");
  assert.equal(Object.keys(got).length, 2, "the banner must not become a key");
});

test("a name that is not a variable name is dropped", () => {
  // Junk with an '=' in it must not become a key just because it parses.
  const got = parseEnvOutput("not a name=value\0GOOD=1\0also-bad=2\0");
  assert.deepEqual(Object.keys(got), ["GOOD"]);
});

test("a value containing a newline still round-trips", () => {
  // The reason the delimiter is NUL and not newline in the first place. Only
  // the KEY is newline-trimmed; the value is untouched.
  const got = parseEnvOutput("MULTI=first\nsecond\0");
  assert.equal(got.MULTI, "first\nsecond");
});

test("a banner containing '=' still does not swallow the first variable", () => {
  // A "====" divider is the common MOTD shape, and it puts an '=' before the
  // real assignment's.
  const got = parseEnvOutput(
    "========================\nWelcome\nPATH=/opt/homebrew/bin\0ANTHROPIC_MODEL=m\0");
  assert.equal(got.PATH, "/opt/homebrew/bin");
  assert.equal(got.ANTHROPIC_MODEL, "m");
  assert.equal(Object.keys(got).length, 2);
});

test("the fallback PATH covers where the tools actually live", () => {
  // These are the install locations that matter on macOS. Homebrew on Apple
  // Silicon is /opt/homebrew; Intel and older installs are /usr/local.
  assert.ok(FALLBACK_PATH_DIRS.includes("/opt/homebrew/bin"));
  assert.ok(FALLBACK_PATH_DIRS.includes("/usr/local/bin"));
});

test("the fallback PATH is appended, never substituted", () => {
  // Substituting would lose whatever the probe or launchd did give us.
  const got = withFallbackPath({ PATH: "/usr/bin:/bin" }, "/Users/x");
  const dirs = got.PATH.split(":");
  assert.equal(dirs[0], "/usr/bin", "the existing PATH keeps priority");
  assert.ok(dirs.includes("/opt/homebrew/bin"));
  assert.ok(dirs.includes("/Users/x/.local/bin"), "$HOME is expanded");
});

test("the fallback PATH does not duplicate what is already there", () => {
  const got = withFallbackPath({ PATH: "/opt/homebrew/bin:/usr/bin" }, "/Users/x");
  const count = got.PATH.split(":").filter((d) => d === "/opt/homebrew/bin").length;
  assert.equal(count, 1);
});

test("a missing PATH still gets the fallback", () => {
  const got = withFallbackPath({}, "/Users/x");
  assert.ok(got.PATH.includes("/opt/homebrew/bin"));
});

test("a trailing slash on an inherited entry still dedupes", () => {
  // "/opt/homebrew/bin/" and "/opt/homebrew/bin" are the same directory;
  // comparing literal strings would append a redundant second entry.
  const got = withFallbackPath({ PATH: "/opt/homebrew/bin/" }, "/Users/x");
  const count = got.PATH.split(":").filter((d) => d.replace(/\/+$/, "") === "/opt/homebrew/bin").length;
  assert.equal(count, 1);
});
