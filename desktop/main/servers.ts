// The only module that owns a child process.
//
// Two children, mirroring what `bin/yuri up` starts: uvicorn on 8000 and
// `next start` on 3000. Ports are fixed deliberately (spec §4.1) -- random
// free ports would break VC_ALLOWED_ORIGINS and LAN access for no gain.
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import type { BootEvent } from "../lib/boot";
import type { Env } from "../lib/env";
import { defaultPorts, portBusyDetail, type Ports } from "../lib/ports";

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 250;
// Per-fetch ceiling for a single health-check request. Without this, a
// listener that accepts the TCP connection but never answers HTTP leaves the
// fetch itself hanging forever -- and since `isDead()` is only rechecked
// BETWEEN fetch attempts, never while one is in flight, a hung fetch defeats
// the whole fast-fail mechanism below. 2s is comfortably above a local round
// trip and well under HEALTH_POLL_MS's cadence times a few retries.
const HEALTH_FETCH_MS = 2_000;

/** The repo root. In development this file is desktop/out/main/, so the root
 *  is three levels up. A packaged app relocates this -- sub-project 2b owns
 *  that, and will pass the root in rather than deriving it. */
export function repoRoot(): string {
  return path.resolve(__dirname, "../../..");
}

const children: ChildProcess[] = [];
let lastStderr: Record<string, string> = {};
let died: Record<string, boolean> = {};

/** Is something already listening on `port`? A successful CONNECT means yes.
 *  Bounded, because a port that neither accepts nor refuses would otherwise
 *  hang the very check meant to avoid a hang (mirrors HEALTH_FETCH_MS's
 *  reasoning, at socket level instead of HTTP level). */
function portInUse(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (busy: boolean) => { sock.destroy(); resolve(busy); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.connect(port, "127.0.0.1");
  });
}

/** Does the backend's own health check say so? Checking the JSON body
 *  (`{"status":"ok"}`, per backend/main.py's `/health`) rather than merely
 *  the HTTP status is the point: an unrelated process already listening on
 *  the port can answer HTTP too, and a bare status-code check cannot tell
 *  the two apart. That mistake previously reported "ready" off a stranger's
 *  404 while the real backend was still dying -- portInUse now refuses to
 *  even start in that situation (see startServers), but this is a second,
 *  independent line of defence, since some other network game answers
 *  the port. */
async function backendAnswers(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(HEALTH_FETCH_MS) });
    if (!r.ok) return false;
    const body = (await r.json()) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

/** Does anything answer HTTP at all? The frontend has no JSON health
 *  endpoint to check the way backendAnswers does, so "any" status is the
 *  best available signal here -- a 401 or a 404 both prove *a* server is up.
 *  portInUse's pre-flight check is what actually rules out a stranger
 *  answering in this one's place. */
async function anyAnswers(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(HEALTH_FETCH_MS) });
    return true;
  } catch {
    return false;
  }
}

/** Poll `check` until it succeeds, the child dies, or the deadline passes.
 *
 *  `isDead` is what keeps a failed boot fast for a child that crashes on its
 *  own (a missing dependency, an import error) -- it returns as soon as the
 *  child is known dead rather than polling on. It does NOT make a port
 *  conflict fast: this backend's own cold start (loading config, connecting
 *  an MCP server, rehydrating a tmux session) runs for several seconds
 *  BEFORE it ever attempts to bind, so a conflicting process on the port
 *  does not make it die any sooner -- it just makes the eventual bind fail.
 *  portInUse's pre-flight check is what actually keeps a busy-port boot
 *  fast, by never spawning into that situation at all. HEALTH_TIMEOUT_MS
 *  stays generous (60s) because it is the ceiling for a start that is
 *  merely slow, not dead -- this backend's own measured cold start. */
async function pollUntil(deadline: number, isDead: () => boolean,
                        check: () => Promise<boolean>): Promise<boolean> {
  while (Date.now() < deadline) {
    if (isDead()) return false;
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
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

  // Refuse to start into a port someone else owns, rather than health-check
  // our way into a false "ready": we cannot tell our own child apart from a
  // stranger already listening there, and a boot that "succeeds" against the
  // wrong process is worse than one that refuses with a clear reason. Nothing
  // is spawned if EITHER port is busy -- a half-started app (one real child,
  // one refused) is worse than a clean, whole refusal.
  const [backendBusy, frontendBusy] = await Promise.all([
    portInUse(ports.backend),
    portInUse(ports.frontend),
  ]);
  if (backendBusy) {
    onEvent({ type: "failed", child: "backend", detail: portBusyDetail(ports.backend, "backend") });
  }
  if (frontendBusy) {
    onEvent({ type: "failed", child: "frontend", detail: portBusyDetail(ports.frontend, "frontend") });
  }
  if (backendBusy || frontendBusy) return;

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
    pollUntil(deadline, () => died.backend,
              () => backendAnswers(`http://127.0.0.1:${ports.backend}/health`)).then((up) =>
      onEvent(up ? { type: "ready", child: "backend" }
                 : { type: "failed", child: "backend",
                     detail: lastStderr.backend.trim() || "the backend never answered" })),
    pollUntil(deadline, () => died.frontend,
              () => anyAnswers(`http://127.0.0.1:${ports.frontend}/`)).then((up) =>
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
