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

/** A port from the environment, or `fallback` if the value is not a plain
 *  decimal integer in the valid TCP port range.
 *
 *  Digits only, deliberately -- NOT `Number()`. `Number()` accepts forms
 *  bash's `case "$value" in *[!0-9]*)` does not: `"+8198"` -> 8198,
 *  `"8198.0"` -> 8198, `"0x2016"` -> 8214. bin/yuri's port_from_env() falls
 *  back to the default on all three, and that disagreement is not cosmetic.
 *  port_from_env() decides which BACKEND_URL the frontend build is STAMPED
 *  for, while this decides which port the shell actually binds -- so with
 *  YURI_DESKTOP_BACKEND_PORT=+8198, bash stamps the build for
 *  http://localhost:8000 while the shell binds 8198, and the frontend then
 *  proxies every request to port 8000, which may well be someone's own live
 *  backend. The two must agree by CONSTRUCTION, which means the stricter
 *  rule on both sides rather than teaching bash `Number()`'s coercions.
 *
 *  Whitespace is trimmed first, matching port_from_env()'s own strip: a
 *  guard that fell back on `" 3199 "` while the shell bound 3199 would be
 *  exactly the divergence this exists to prevent. */
function parsePort(value: string | undefined, fallback: number): number {
  const digits = (value ?? "").trim();
  if (!/^\d+$/.test(digits)) return fallback;
  const parsed = Number(digits);
  return parsed > 0 && parsed < 65536 ? parsed : fallback;
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
