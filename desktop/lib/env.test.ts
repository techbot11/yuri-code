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

test("a plain assignment parses", () => {
  const got = parseEnvOutput("PATH=/usr/bin\0TOKEN=abc=def=\0EMPTY=\0");
  assert.equal(got.PATH, "/usr/bin");
  assert.equal(got.TOKEN, "abc=def=", "only the assignment's own '=' separates");
  assert.equal(got.EMPTY, "");
});

test("a banner is skipped, with or without an '=' in it", () => {
  // A "====" divider is the common MOTD shape and puts an '=' before the
  // real one; the banner's '=' implies the name "====", which is not a name.
  for (const banner of ["Welcome!\nLast login: whenever\n", "====================\nWelcome\n"]) {
    const got = parseEnvOutput(`${banner}PATH=/opt/homebrew/bin\0ANTHROPIC_MODEL=m\0`);
    assert.equal(got.PATH, "/opt/homebrew/bin", banner);
    assert.equal(got.ANTHROPIC_MODEL, "m", banner);
    assert.equal(Object.keys(got).length, 2, `${banner}: the banner must not become a key`);
  }
});

test("a value containing a newline round-trips, banner or not", () => {
  // This is why the delimiter is NUL and not newline.
  assert.equal(parseEnvOutput("MULTI=first\nsecond\0").MULTI, "first\nsecond");
  assert.equal(parseEnvOutput("Welcome\nMULTI=first\nsecond\0").MULTI, "first\nsecond");
});

test("a continuation line that looks like an assignment stays in the value", () => {
  // NUL is the only record separator, so this is ONE record: A, whose value
  // happens to contain a newline and then something assignment-shaped.
  const got = parseEnvOutput("A=x\nB=y\0");
  assert.deepEqual(got, { A: "x\nB=y" });
});

test("junk with an '=' does not become a variable", () => {
  const got = parseEnvOutput("not a name=value\0GOOD=1\0also-bad=2\0");
  assert.deepEqual(Object.keys(got), ["GOOD"]);
});

test("a chunk with no assignment at all is dropped", () => {
  assert.deepEqual(parseEnvOutput("Welcome to zsh\nType help\0"), {});
  assert.deepEqual(parseEnvOutput("=novalue\0"), {}, "an empty name is not a name");
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
