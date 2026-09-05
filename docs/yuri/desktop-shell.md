# The desktop shell — what a future change needs to know

Sub-project 2a is complete: Yuri runs as a macOS app. This is not a description
of the code (read `desktop/` for that) but the short list of things that are
easy to break because nothing in the code will stop you, plus what was
deliberately left for later.

## Traps

**`BACKEND_URL` is baked in at build time, not read at start time.**
`frontend/next.config.js` puts it in Next's `env:` block, which INLINES it
during `next build`. `next start` never reads it. So a build carries a fixed
backend port, and pointing the shell at a different one without rebuilding
gives you a frontend talking to whatever is on the old port.

This is not theoretical. During this sub-project's own verification it meant
runs on scratch ports were silently proxying to the developer's live backend on
8000, which invalidated several end-to-end claims that had to be re-established
later. `bin/yuri app` now handles it: it stamps the build with the URL it was
built for and rebuilds on mismatch. **Any verification that bypasses `bin/yuri
app` must set `BACKEND_URL` itself and confirm it landed in the built chunks.**

The stamp lives inside `.next` on purpose, because `next build` clears that
directory — so a build made any other way takes the stamp with it rather than
leaving it to lie. That was measured, not assumed. If Next ever gains an
incremental mode that stops clearing `.next`, the stamp must be deleted
explicitly before each build instead.

**The tray's priority rule lives in exactly one place: `frontend/lib/trayState.ts`.**
The renderer decides the state and sends the string; `desktop/main/tray.ts`
validates it against `TRAY_STATES` and renders it. `desktop/lib/tray.ts` once
held a second copy of the rule with tests claiming the two were cross-checked —
they were not, and the copy had no caller, so it was deleted. Adding a state
means editing the frontend rule AND `TRAY_STATES`; the desktop side's
`Record<TrayState, true>` catches a missing entry at compile time, and
`setTrayState` logs anything it rejects at runtime. Neither can see a change
made only on the frontend side.

**`child.killed` does not mean the child died.** Node sets it when the signal
is *sent*. A `!child.killed` guard behind a SIGTERM is true exactly never, which
is how this shell's SIGKILL escalation came to be dead code. Use
`exitCode === null && signalCode === null`.

**Per-cycle child state must not be shared across cycles.** A retry drains the
old children and starts new ones; anything keyed only by child name (`stderr`
buffers, dead flags) will have a late exit event from the old cycle write into
the new one's state, or be read after a reset. Both produced real failures here
— an uncaught exception in the main process, and a fresh boot instantly
reporting a backend that had never been asked.

## Timings, measured

- `next start` answers in ~200ms.
- The backend's cold start is **6–16s against a populated `~/Yuri`** (config,
  MCP connect, tmux rehydration) but **under a second against an empty one**.
  Verification using a scratch `YURI_HOME` must sample fast — 500ms polling
  misses the boot entirely.
- macOS `.app` bundles inherit launchd's environment, not your shell's, which
  is why the shell resolves a login-shell environment itself.

## Left for later

Sub-project 2b: a bundled Python runtime and the ~355MB trim, `electron-builder`
and a `.dmg`, the microphone permission check, `safeStorage` for API keys, and
the offer-to-restart-a-dead-server UI. Until then the app runs from this clone
and needs `claude` and `tmux` installed as usual.

Sub-project 3: the `yapcode` → Yuri OS rename. Two known debts waiting on it —
the README documents the launcher as `yapcode up` throughout while the new
desktop section says `yuri app`, with nothing explaining that `bin/yuri`
delegates the other subcommands straight through; and the environment variable
names (`YAPCODE_ROOT`, `YAPCODE_CONFIG_DIR`) are still the old ones.

A child that crashes *after* boot is reported but not restarted. That is
deliberate: a restart policy needs the offer-to-restart UI, and a silent
auto-restart loop is worse than a visibly dead server.
