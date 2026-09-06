// Whether the backend can be restarted right now, and what it would cost.
//
// Spec 6.4 requires the settings UI to refuse a restart while a mission is
// running, or say what it will interrupt. The distinction this draws:
//
//   a MISSION is unattended work -- she is doing it while nobody watches, so
//   killing it loses progress nobody chose to lose. Refused.
//   a SESSION is attended -- someone is there and can judge -- and it also
//   survives the restart, which is why it is warned about rather than
//   refused, and why the warning says "interrupts" and not "stops". See
//   restartImpact() for where that claim is checked against the code.
//
// Pure so `node --test` reaches it: there is no DOM test environment.

export type RestartImpact = {
  /** Whether the restart may proceed. */
  safe: boolean;
  /** What it would interrupt, or "" when there is nothing to say. */
  warning: string;
};

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** What to say after a restart request that the shell ACCEPTED but declined to
 *  act on.
 *
 *  desktop/main/index.ts's runBootCycle() refuses to overlap two boot cycles,
 *  so a click that lands while one is already in flight returns
 *  `{ok: true, ran: false}`: nothing drained, nothing respawned, no error. That
 *  is not a failure -- the guard is doing its job -- but reporting it as a
 *  restart is a lie, and the panel's own "Restarting…" label was the only tell.
 *  `undefined` covers an older shell that answers without the field: unknown is
 *  not the same as "declined", so it says nothing rather than guessing. */
export function restartRanNote(ran: boolean | undefined): string {
  if (ran !== false) return "";
  return "Nothing was restarted — Yuri was already starting up. Wait for her to "
    + "settle, then try again.";
}

export function restartImpact(runningMissions: number, liveSessions: number): RestartImpact {
  // Clamped, not trusted: a count arriving as -1 from a failed fetch must not
  // disable the button forever with a warning about minus one mission.
  const missions = Number.isFinite(runningMissions) ? Math.max(0, Math.trunc(runningMissions)) : 0;
  const sessions = Number.isFinite(liveSessions) ? Math.max(0, Math.trunc(liveSessions)) : 0;

  // The two halves say different things because the two things ARE different,
  // and this sentence used to claim otherwise ("Restarting stops N sessions").
  //
  // A MISSION really does stop: its driver lives in the backend process, so
  // draining that process ends it, and there is nothing to come back to.
  //
  // A SESSION does not. desktop/main/servers.ts's stopServers() deliberately
  // leaves tmux panes alone; backend/config.py's KILL_SESSIONS_ON_SHUTDOWN
  // defaults to False, so tmux_runner.shutdown() DETACHES rather than kills
  // (tmux_runner.py:468-495) and the `claude` process in the pane keeps
  // running with its control dir intact; and backend/main.py's startup then
  // calls sessions.rehydrate(), which re-adopts every handle that came back
  // (yuri/services/sessions.py:990). What a restart actually costs a session
  // is the gap -- she cannot reach it while the backend is down -- plus the
  // risk that a handle does not come back, which rehydrate marks `lost`
  // rather than silently dropping. Hence "interrupts", and "the ones that
  // come back" rather than a promise about all of them.
  //
  // No per-backend distinction is drawn: this function is given two counts
  // and nothing else, and every provider Yuri has (tmux CLI panes, OpenCode's
  // server-side sessions) survives the restart the same way. Inventing a
  // distinction the arguments cannot support would be the same class of bug
  // as the sentence this replaces.
  const parts: string[] = [];
  if (missions > 0) parts.push(`stops ${plural(missions, "mission")}`);
  if (sessions > 0) {
    parts.push(sessions === 1
      ? "interrupts 1 session for a few seconds — its agent keeps running, and she "
        + "picks it up again if it comes back"
      : `interrupts ${plural(sessions, "session")} for a few seconds — the agents keep `
        + "running, and she picks up again the ones that come back");
  }
  if (parts.length === 0) return { safe: true, warning: "" };

  return {
    safe: missions === 0,
    warning: `Restarting ${parts.join(", and ")}.`,
  };
}
