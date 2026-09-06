import test from "node:test";
import assert from "node:assert/strict";
import { backendCwd, frontendCommand, pythonPath, type PathEnv } from "./paths.ts";

const packaged: PathEnv = {
  packaged: true,
  resourcesPath: "/Applications/Yuri OS.app/Contents/Resources",
  repoRoot: "/ignored/when/packaged",
};
const dev: PathEnv = {
  packaged: false,
  resourcesPath: "/ignored/in/dev",
  repoRoot: "/Users/me/yuri-code",
};

test("packaged: the interpreter comes from the bundle, never the repo", () => {
  assert.equal(pythonPath(packaged),
    "/Applications/Yuri OS.app/Contents/Resources/python/bin/python3");
});

test("dev: the interpreter is the repo's venv", () => {
  // A packaged path in dev would mean editing backend code and running a
  // stale bundled copy of it.
  assert.equal(pythonPath(dev), "/Users/me/yuri-code/backend/.venv/bin/python");
});

test("packaged: the backend's cwd is the bundled backend, not the repo", () => {
  assert.equal(backendCwd(packaged),
    "/Applications/Yuri OS.app/Contents/Resources/backend");
});

test("dev: the backend's cwd is the repo's backend", () => {
  assert.equal(backendCwd(dev), "/Users/me/yuri-code/backend");
});

test("a path with spaces is returned intact, not escaped or quoted", () => {
  // "Yuri OS.app" always contains a space. Quoting belongs to whoever builds
  // a command line, and a pre-quoted path here would be quoted twice.
  assert.ok(pythonPath(packaged).includes("Yuri OS.app"));
  assert.ok(!pythonPath(packaged).includes("\\"));
  assert.ok(!pythonPath(packaged).includes('"'));
});

test("dev: the frontend runs via `next start`, with the port as an argument", () => {
  const cmd = frontendCommand(dev, 3000);
  assert.equal(cmd.cwd, "/Users/me/yuri-code/frontend");
  assert.deepEqual(cmd.args, [
    "/Users/me/yuri-code/frontend/node_modules/next/dist/bin/next",
    "start", "-H", "127.0.0.1", "-p", "3000",
  ]);
  // No node_modules in the packaged bundle -- but this is dev, so nothing
  // here should reach for it.
  assert.deepEqual(cmd.env, {});
});

test("packaged: the frontend runs the standalone server, with the port as env", () => {
  const cmd = frontendCommand(packaged, 3000);
  assert.equal(cmd.cwd,
    "/Applications/Yuri OS.app/Contents/Resources/frontend/standalone");
  assert.deepEqual(cmd.args, [
    "/Applications/Yuri OS.app/Contents/Resources/frontend/standalone/server.js",
  ]);
  // The standalone server.js reads PORT/HOSTNAME from its environment, not
  // argv -- unlike `next start`, which takes -H/-p on the command line.
  assert.equal(cmd.env.PORT, "3000");
  assert.equal(cmd.env.HOSTNAME, "127.0.0.1");
});

test("packaged: a different port produces a different PORT env, same argv", () => {
  const cmd = frontendCommand(packaged, 8123);
  assert.equal(cmd.env.PORT, "8123");
  assert.deepEqual(cmd.args, [
    "/Applications/Yuri OS.app/Contents/Resources/frontend/standalone/server.js",
  ]);
});

test("packaged: the frontend command never reaches for the repo", () => {
  const cmd = frontendCommand(packaged, 3000);
  assert.ok(!cmd.cwd.includes("/ignored/when/packaged"));
  assert.ok(!cmd.args.some((a) => a.includes("/ignored/when/packaged")));
});

test("dev: the frontend command never reaches for a packaged bundle path", () => {
  const cmd = frontendCommand(dev, 3000);
  assert.ok(!cmd.cwd.includes("Resources"));
  assert.ok(!cmd.args.some((a) => a.includes("Resources")));
});
