// Which ports the backend and frontend children listen on.
//
// Fixed by default (spec §4.1): VC_ALLOWED_ORIGINS and the LAN-access feature
// both assume 8000 and 3000. The override below exists so a verification run
// can point the shell at other ports without fighting a `bin/yuri up` the
// developer already has running -- it is not a knob meant for shipping
// configuration.
//
// Pure so `node --test` reaches it, matching lib/env.ts's split from the
// impure probe in main/shellEnv.ts.

export const DEFAULT_BACKEND_PORT = 8000;
export const DEFAULT_FRONTEND_PORT = 3000;

export type Ports = { backend: number; frontend: number };

export function defaultPorts(): Ports {
  return { backend: DEFAULT_BACKEND_PORT, frontend: DEFAULT_FRONTEND_PORT };
}

/** A port from the environment, or `fallback` if the value is missing, not an
 *  integer, or outside the valid TCP port range. A silent fallback on a
 *  typo'd port would waste far more time than a clear rejection, so this
 *  validates rather than trusting `Number()` to fail closed on its own. */
function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

/** Ports from YURI_DESKTOP_BACKEND_PORT / YURI_DESKTOP_FRONTEND_PORT, falling
 *  back to the shipping defaults. `env` is a parameter, rather than a read of
 *  `process.env` inside this function, so `node --test` can reach it. */
export function portsFromEnv(env: Record<string, string | undefined>): Ports {
  return {
    backend: parsePort(env.YURI_DESKTOP_BACKEND_PORT, DEFAULT_BACKEND_PORT),
    frontend: parsePort(env.YURI_DESKTOP_FRONTEND_PORT, DEFAULT_FRONTEND_PORT),
  };
}

/** The message for an occupied port. Names the port and what to do, because
 *  the overwhelmingly likely cause is the developer's own `bin/yuri up`. */
export function portBusyDetail(port: number, which: "backend" | "frontend"): string {
  return `port ${port} is already in use, so the ${which} cannot start — ` +
         `stop whatever is listening on it (\`bin/yuri up\` uses this port) and try again`;
}
