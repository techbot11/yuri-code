// The only module that owns a child process.
//
// Two children, mirroring what `bin/yuri up` starts: uvicorn on 8000 and
// `next start` on 3000. Ports are fixed deliberately (spec §4.1) -- random
// free ports would break VC_ALLOWED_ORIGINS and LAN access for no gain.
import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import type { BootEvent } from "../lib/boot";
import type { Env } from "../lib/env";
import { backendCwd, frontendCommand, pythonPath, type PathEnv } from "../lib/paths";
import { defaultPorts, portBusyDetail, type Ports } from "../lib/ports";
import { readCredentials } from "./credentials";

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

/** The real Electron values, gathered in one place so lib/paths.ts stays
 *  pure and testable. */
function pathEnv(): PathEnv {
  return {
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: repoRoot(),
  };
}

// How long SIGTERM gets before SIGKILL, and how long SIGKILL gets before a
// child is declared un-killable. The first covers uvicorn's own 3s graceful
// shutdown; the second exists only so `stopServers()` can tell "gone" from
// "still holding the port" before it returns.
const DRAIN_MS = 3_500;
const SIGKILL_GRACE_MS = 1_500;

type ChildName = "backend" | "frontend";

/** One child of one boot cycle. Every piece of per-child state here used to
 *  be a module-level `Record<string, …>` keyed by name, reset wholesale by
 *  stopServers() -- which meant a child whose `exit` arrived after that reset
 *  read `undefined.trim()` and threw an UNCAUGHT exception in the main
 *  process, killing the window and orphaning the new boot's children. State
 *  that belongs to one child now lives with that child and cannot be reset
 *  out from under a handler that is still holding a reference to it. */
type ChildRec = {
  name: ChildName;
  proc: ChildProcess;
  /** Tail of this child's own output, for a failure detail. */
  stderr: string;
  /** Known dead, or deliberately killed. Read by this cycle's health poll --
   *  per-child, so draining cycle A cannot un-kill what cycle B is watching
   *  (the old shared map's reset made an orphaned poll forget its child had
   *  been killed and run to its original 60s deadline against a port the NEW
   *  backend by then owned). */
  dead: boolean;
  /** Drop the stdout/stderr subscriptions. */
  detach: () => void;
};

/** One call to startServers() and the children it spawned. `drained` is the
 *  cycle's own kill switch: once stopServers() has disowned it, nothing from
 *  it -- a late `exit`, an orphaned health poll -- may report into the boot
 *  that comes next. */
type Cycle = { children: ChildRec[]; drained: boolean };

// Every cycle whose children are not confirmed gone. Normally one; briefly
// two if a retry overlaps, and it keeps a cycle whose child survived SIGKILL
// so a later stopServers() still has a handle to try again with.
let cycles: Cycle[] = [];

/** Is this child still running?
 *
 *  NOT `!child.killed`: Node sets `killed` when the signal is SENT, not when
 *  the process dies, so a `!killed` guard is true exactly never after a
 *  SIGTERM and any escalation behind it is dead code. `exitCode`/`signalCode`
 *  are both null until the process is actually reaped, which is the fact
 *  wanted here. */
function alive(rec: ChildRec): boolean {
  return rec.proc.exitCode === null && rec.proc.signalCode === null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

function track(cycle: Cycle, name: ChildName, child: ChildProcess,
               emit: (ev: BootEvent) => void): ChildRec {
  const keep = (buf: Buffer) => {
    // Keep only the tail: a Python traceback is what the user needs, and an
    // unbounded buffer of a server's whole log is not.
    rec.stderr = (rec.stderr + buf.toString()).slice(-4000);
  };
  const rec: ChildRec = {
    name, proc: child, stderr: "", dead: false,
    detach: () => {
      child.stdout?.off("data", keep);
      child.stderr?.off("data", keep);
    },
  };
  // Pushed immediately, before anything can go wrong below: a spawned child
  // that is not tracked is a child nothing can ever kill.
  cycle.children.push(rec);
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("exit", (code) => {
    rec.dead = true;
    rec.detach();
    // An exit BEFORE ready is a boot failure; after ready it is a crash the
    // app has to survive, and 2b's supervisor owns restarting it. `emit` is
    // the cycle-scoped reporter: an exit that arrives after this cycle was
    // drained (a backend exiting non-zero at t~4s during its own SIGTERM
    // shutdown, while the retry that killed it has already booted afresh)
    // reports to nobody rather than into the new boot's state.
    if (code !== 0) {
      emit({ type: "failed", child: name,
             detail: rec.stderr.trim() || `${name} exited with code ${code}` });
    }
  });
  // A spawn whose executable does not exist (or cannot be launched at all --
  // a bad interpreter, a permissions error) emits 'error', NOT 'exit': Node
  // never got far enough to have a process to exit. Measured directly (see
  // task-3 fixes report): for an ENOENT target, 'exit' never fires at all, so
  // without this handler that failure produced no log, no boot failure, and
  // no message anywhere -- the window just sat waiting for a port that would
  // never open. Routed into the same `emit` path 'exit' uses so the boot
  // state machine and the frontend's splash, which already know how to
  // display a failed child, learn about this one too instead of a new
  // surface being invented for it. `err.message` is exactly the diagnosis
  // needed (e.g. "spawn .../next ENOENT") -- never the child's env, which is
  // never touched here.
  child.on("error", (err) => {
    rec.dead = true;
    rec.detach();
    emit({ type: "failed", child: name,
           detail: rec.stderr.trim() || `${name} failed to start: ${err.message}` });
  });
  return rec;
}

export async function startServers(env: Env,
                                   onEvent: (ev: BootEvent) => void,
                                   ports: Ports = defaultPorts()): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  // This call's own cycle. Everything below reports through `emit` rather
  // than through `onEvent` directly, so that stopServers() disowning this
  // cycle silences ALL of it at once -- the children's exit handlers and the
  // two health polls alike. The polls in particular are deliberately
  // orphanable: index.ts fire-and-forgets startServers() so a merely slow
  // backend cannot hold a retry hostage, which means a poll from the
  // previous cycle is routinely still running when the next one starts.
  const cycle: Cycle = { children: [], drained: false };
  const emit = (ev: BootEvent) => { if (!cycle.drained) onEvent(ev); };

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
    emit({ type: "failed", child: "backend", detail: portBusyDetail(ports.backend, "backend") });
  }
  if (frontendBusy) {
    emit({ type: "failed", child: "frontend", detail: portBusyDetail(ports.frontend, "frontend") });
  }
  if (backendBusy || frontendBusy) return;

  // Registered before the first spawn: from here on, anything this function
  // starts is something stopServers() can find and kill.
  cycles.push(cycle);

  const penv = pathEnv();
  // Credentials merged LAST -- they must win over everything else in `env`,
  // including a real shell export, because that is the whole point of the
  // Keychain being consulted at all (spec 6.3): a value the user just saved
  // in Setup has to take effect on the very next boot rather than losing to
  // whatever their shell happened to export. Both children get it: the
  // backend needs it directly, and the coding agents (spawned by the
  // backend, not here) inherit through it; the frontend gets it too because
  // it is cheaper to hand it uniformly than to reason about which of the
  // two might one day need a given key.
  const withCredentials: Env = { ...env, ...readCredentials() };
  const backend = spawn(
    pythonPath(penv),
    ["-m", "uvicorn", "main:app", "--port", String(ports.backend),
     "--log-level", "info", "--timeout-graceful-shutdown", "3"],
    { cwd: backendCwd(penv), env: withCredentials, stdio: ["ignore", "pipe", "pipe"] });
  const backendRec = track(cycle, "backend", backend, emit);

  // ELECTRON_RUN_AS_NODE makes this Electron binary behave as plain Node, so
  // Next runs on Electron's own Node 22.16 and no second runtime is bundled
  // (spec §4.2, verified: Ready in 188ms). frontendCommand() picks `next
  // start` (dev, where frontend/node_modules exists) or the standalone
  // server.js (packaged, where it does not) -- see lib/paths.ts.
  const frontendCmd = frontendCommand(penv, ports.frontend);
  const frontend = spawn(
    process.execPath,
    frontendCmd.args,
    { cwd: frontendCmd.cwd,
      // Credentials still last: frontendCmd.env sets Next's own runtime
      // knobs (the port, standalone-mode paths), none of which name a
      // secret key, so there is nothing here for it to lose to except by
      // coincidence -- and if a future key ever collided, winning is still
      // the right behavior for a Keychain value the user just saved.
      env: { ...env, ...frontendCmd.env, ...readCredentials(), ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"] });
  const frontendRec = track(cycle, "frontend", frontend, emit);

  // Health-check both in parallel: the frontend does not depend on the
  // backend to LISTEN, only to answer proxied requests, so serialising the
  // two would add the backend's start time to every boot for no reason.
  await Promise.all([
    pollUntil(deadline, () => backendRec.dead,
              () => backendAnswers(`http://127.0.0.1:${ports.backend}/health`)).then((up) =>
      emit(up ? { type: "ready", child: "backend" }
              : { type: "failed", child: "backend",
                  detail: backendRec.stderr.trim() || "the backend never answered" })),
    pollUntil(deadline, () => frontendRec.dead,
              () => anyAnswers(`http://127.0.0.1:${ports.frontend}/`)).then((up) =>
      emit(up ? { type: "ready", child: "frontend" }
              : { type: "failed", child: "frontend",
                  detail: frontendRec.stderr.trim() || "the frontend never answered" })),
  ]);
}

/** Stop every child this module has started. tmux panes are deliberately NOT
 *  touched: VC_KILL_SESSIONS_ON_SHUTDOWN already defaults off so a restart
 *  can rehydrate them, and quitting the UI must not kill an agent mid-task.
 *
 *  Three properties this has to hold, each of them a bug that was measured:
 *
 *  1. Nothing from a drained cycle may report into the boot that follows it
 *     -- neither a late `exit` nor an orphaned health poll. `drained` plus
 *     the per-child `detach()` is what makes that so.
 *  2. A killed child must LOOK killed to its own cycle's poll (`dead`),
 *     which is why that flag is per-child rather than a shared map this
 *     function used to clear.
 *  3. A child that is still running when this returns must still be
 *     reachable. Emptying the handle list unconditionally is what turned a
 *     `next start` that took longer than DRAIN_MS to close into an
 *     unrecoverable loop: the port stayed held, startServers() refused to
 *     spawn into it and blamed `bin/yuri up`, and every later retry drained
 *     an empty list and killed nothing. Survivors stay tracked. */
export async function stopServers(): Promise<void> {
  const draining = cycles;
  cycles = [];
  for (const cycle of draining) {
    cycle.drained = true;
    for (const rec of cycle.children) {
      rec.detach();
      rec.dead = true;
      if (alive(rec)) rec.proc.kill("SIGTERM");
    }
  }
  const recs = draining.flatMap((c) => c.children);
  if (recs.length === 0) return;

  // Give uvicorn its 3s graceful shutdown, then escalate. A child that
  // ignores SIGTERM must not hold the app open -- but it must not be
  // forgotten about either.
  await sleep(DRAIN_MS);
  const stubborn = recs.filter(alive);
  for (const rec of stubborn) rec.proc.kill("SIGKILL");
  if (stubborn.length > 0) await sleep(SIGKILL_GRACE_MS);

  const survivors = recs.filter(alive);
  if (survivors.length > 0) {
    // Uninterruptible-sleep territory, or a signal we are not permitted to
    // send. Keep the handles: this is exactly the state in which a later
    // retry must be able to try again instead of draining nothing. Names and
    // pids only -- never a child's output or its environment.
    console.error("[yuri] still running after SIGKILL, and still holding its port: " +
      survivors.map((r) => `${r.name} (pid ${r.proc.pid})`).join(", "));
    cycles.push({ children: survivors, drained: true });
  }
}
