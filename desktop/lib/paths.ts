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

/** What `servers.ts` should spawn to run the frontend, and where.
 *
 *  `args` are passed after `process.execPath` -- servers.ts runs the
 *  frontend under Electron acting as plain Node (`ELECTRON_RUN_AS_NODE=1`),
 *  in both branches, so no second runtime is bundled.
 *
 *  Dev: `next start`, from the repo, where `frontend/node_modules` exists
 *  and editing frontend code takes effect. The port is a CLI argument, the
 *  same way `frontend/package.json`'s own `start` script passes it.
 *
 *  Packaged: bundling `frontend/node_modules` (388 MB) would roughly triple
 *  the .dmg over a 132 MB build, so the package instead ships
 *  `frontend/.next/standalone` -- `next build`'s `output: "standalone"`
 *  tree, a minimal `server.js` plus only the dependencies it actually
 *  reaches. That server reads `PORT`/`HOSTNAME` from its environment rather
 *  than argv (see `frontend/next.config.mjs` and its build's `server.js`),
 *  so the port travels as `env` here instead of as an argument. Electron
 *  builder's `extraResources` is what places `.next/static` and `public/`
 *  inside this tree at `Resources/frontend/standalone/.next/static` and
 *  `.../public` -- Next's standalone output does NOT copy either itself,
 *  and a tree missing them serves HTML with no CSS or JS, which looks like
 *  a working server and a broken page. */
export type FrontendCommand = {
  /** Argv after `process.execPath`. */
  args: string[];
  /** cwd the frontend process runs in. */
  cwd: string;
  /** Env to merge on top of the caller's own env; empty in dev, where the
   *  port is already an argument instead. */
  env: Record<string, string>;
};

export function frontendCommand(env: PathEnv, port: number): FrontendCommand {
  if (env.packaged) {
    const cwd = path.join(env.resourcesPath, "frontend", "standalone");
    return {
      args: [path.join(cwd, "server.js")],
      cwd,
      env: { PORT: String(port), HOSTNAME: "127.0.0.1" },
    };
  }
  const cwd = path.join(env.repoRoot, "frontend");
  return {
    args: [
      path.join(cwd, "node_modules", "next", "dist", "bin", "next"),
      "start", "-H", "127.0.0.1", "-p", String(port),
    ],
    cwd,
    env: {},
  };
}
