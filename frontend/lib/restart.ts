// Whether the backend can be restarted right now, and what it would cost.
//
// Spec 6.4 requires the settings UI to refuse a restart while a mission is
// running, or say what it will interrupt. The distinction this draws:
//
//   a MISSION is unattended work -- she is doing it while nobody watches, so
//   killing it loses progress nobody chose to lose. Refused.
//   a SESSION is attended -- someone is there and can judge. Warned, allowed.
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

export function restartImpact(runningMissions: number, liveSessions: number): RestartImpact {
  // Clamped, not trusted: a count arriving as -1 from a failed fetch must not
  // disable the button forever with a warning about minus one mission.
  const missions = Number.isFinite(runningMissions) ? Math.max(0, Math.trunc(runningMissions)) : 0;
  const sessions = Number.isFinite(liveSessions) ? Math.max(0, Math.trunc(liveSessions)) : 0;

  const parts: string[] = [];
  if (missions > 0) parts.push(plural(missions, "mission"));
  if (sessions > 0) parts.push(plural(sessions, "session"));
  if (parts.length === 0) return { safe: true, warning: "" };

  return {
    safe: missions === 0,
    warning: `Restarting stops ${parts.join(" and ")}.`,
  };
}
