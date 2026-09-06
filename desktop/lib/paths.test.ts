import test from "node:test";
import assert from "node:assert/strict";
import { backendCwd, pythonPath, type PathEnv } from "./paths.ts";

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
