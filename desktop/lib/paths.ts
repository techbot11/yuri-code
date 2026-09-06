// Where the backend's interpreter and code live, which differs between a
// packaged app and a dev run.
//
// Pure, and takes its inputs rather than reading `app.isPackaged` and
// `process.resourcesPath` itself, so `node --test` can reach it -- the
// desktop suite has no Electron.
//
// Getting this wrong is not a subtle failure but it IS a confusing one: a dev
// run pointed at a bundled interpreter silently runs a stale copy of the
// backend while you edit the real one.

import path from "node:path";

export type PathEnv = {
  /** Electron's `app.isPackaged`. */
  packaged: boolean;
  /** Electron's `process.resourcesPath` -- Contents/Resources in a bundle. */
  resourcesPath: string;
  /** The repo root, for a dev run. */
  repoRoot: string;
};

/** The Python that runs uvicorn.
 *
 *  Packaged: the payload electron-builder copied into Resources/python (see
 *  desktop/electron-builder.yml's extraResources and
 *  desktop/scripts/build-python.py). Dev: the repo's own venv, so editing
 *  backend code takes effect.
 *
 *  Returned unescaped and unquoted. "Yuri OS.app" always contains a space,
 *  and quoting is the job of whoever builds a command line -- a path quoted
 *  here would be quoted twice. `spawn` with an argv array needs no quoting at
 *  all, which is how servers.ts uses it. */
export function pythonPath(env: PathEnv): string {
  return env.packaged
    ? path.join(env.resourcesPath, "python", "bin", "python3")
    : path.join(env.repoRoot, "backend", ".venv", "bin", "python");
}

/** The working directory uvicorn runs in -- it imports `main:app` from there. */
export function backendCwd(env: PathEnv): string {
  return env.packaged
    ? path.join(env.resourcesPath, "backend")
    : path.join(env.repoRoot, "backend");
}
