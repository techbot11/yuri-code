// The only module that owns a child process.
//
// Two children, mirroring what `bin/yuri up` starts: uvicorn on 8000 and
// `next start` on 3000. Ports are fixed deliberately (spec §4.1) -- random
// free ports would break VC_ALLOWED_ORIGINS and LAN access for no gain.
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import type { BootEvent } from "../lib/boot";
import type { Env } from "../lib/env";
import { defaultPorts, type Ports } from "../lib/ports";

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 250;

/** The repo root. In development this file is desktop/out/main/, so the root
 *  is three levels up. A packaged app relocates this -- sub-project 2b owns
 *  that, and will pass the root in rather than deriving it. */
export function repoRoot(): string {
  return path.resolve(__dirname, "../../..");
}

const children: ChildProcess[] = [];
let lastStderr: Record<string, string> = {};
let died: Record<string, boolean> = {};

/** Wait for a URL to answer with any HTTP status. "Any" is the point: a 401
 *  or a 404 both prove the server is up, and only a connection refusal means
 *  it is not.
 *
 *  `isDead` is what keeps a failed boot fast. The common failures -- a port
 *  already in use, a missing dependency -- kill the child in under a second,
 *  and polling on to the 60s deadline would leave the boot window saying
 *  "starting" for a minute while the stderr that explains it is already
 *  captured. */
async function waitForHttp(url: string, deadline: number,
                           isDead: () => boolean): Promise<boolean> {
  while (Date.now() < deadline) {
    if (isDead()) return false;
    try {
      await fetch(url, { method: "GET" });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
  }
  return false;
}

function track(name: "backend" | "frontend", child: ChildProcess,
               onEvent: (ev: BootEvent) => void): void {
  children.push(child);
  lastStderr[name] = "";
  const keep = (buf: Buffer) => {
    // Keep only the tail: a Python traceback is what the user needs, and an
    // unbounded buffer of a server's whole log is not.
    lastStderr[name] = (lastStderr[name] + buf.toString()).slice(-4000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("exit", (code) => {
    died[name] = true;
    // An exit BEFORE ready is a boot failure; after ready it is a crash the
    // app has to survive, and 2b's supervisor owns restarting it.
    if (code !== 0) {
      onEvent({ type: "failed", child: name,
                detail: lastStderr[name].trim() || `${name} exited with code ${code}` });
    }
  });
}

export async function startServers(env: Env,
                                   onEvent: (ev: BootEvent) => void,
                                   ports: Ports = defaultPorts()): Promise<void> {
  const root = repoRoot();
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  const backend = spawn(
    path.join(root, "backend/.venv/bin/python"),
    ["-m", "uvicorn", "main:app", "--port", String(ports.backend),
     "--log-level", "info", "--timeout-graceful-shutdown", "3"],
    { cwd: path.join(root, "backend"), env, stdio: ["ignore", "pipe", "pipe"] });
  track("backend", backend, onEvent);

  // ELECTRON_RUN_AS_NODE makes this Electron binary behave as plain Node, so
  // Next runs on Electron's own Node 22.16 and no second runtime is bundled
  // (spec §4.2, verified: Ready in 188ms).
  const frontend = spawn(
    process.execPath,
    [path.join(root, "frontend/node_modules/next/dist/bin/next"),
     "start", "-H", "127.0.0.1", "-p", String(ports.frontend)],
    { cwd: path.join(root, "frontend"),
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"] });
  track("frontend", frontend, onEvent);

  // Health-check both in parallel: the frontend does not depend on the
  // backend to LISTEN, only to answer proxied requests, so serialising the
  // two would add the backend's start time to every boot for no reason.
  await Promise.all([
    waitForHttp(`http://127.0.0.1:${ports.backend}/health`, deadline,
                () => died.backend).then((up) =>
      onEvent(up ? { type: "ready", child: "backend" }
                 : { type: "failed", child: "backend",
                     detail: lastStderr.backend.trim() || "the backend never answered" })),
    waitForHttp(`http://127.0.0.1:${ports.frontend}/`, deadline,
                () => died.frontend).then((up) =>
      onEvent(up ? { type: "ready", child: "frontend" }
                 : { type: "failed", child: "frontend",
                     detail: lastStderr.frontend.trim() || "the frontend never answered" })),
  ]);
}

/** Stop both children. tmux panes are deliberately NOT touched:
 *  VC_KILL_SESSIONS_ON_SHUTDOWN already defaults off so a restart can
 *  rehydrate them, and quitting the UI must not kill an agent mid-task. */
export async function stopServers(): Promise<void> {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  // Give uvicorn its 3s graceful shutdown, then stop waiting. A child that
  // ignores SIGTERM must not hold the app open.
  await new Promise((r) => setTimeout(r, 3500));
  for (const child of children) {
    if (!child.killed) child.kill("SIGKILL");
  }
  children.length = 0;
  lastStderr = {};
  died = {};
}
