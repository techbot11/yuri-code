// Coding agents are external, not bundled with Yuri: `claude` and `opencode`
// are the user's own installations, found on PATH. "Not installed" is
// therefore an ordinary, blameless state whose word is OFFLINE rather than an
// error -- and it must stay distinguishable from "installed but not turned
// on", which is a one-setting fix rather than an install.
//
// Pure so `node --test` reaches it (there is no DOM test environment here).

export type Agent = {
  /** The YURI_AGENTS token, e.g. "claude-code". */
  name: string;
  label: string;
  available: boolean;
  detail: string;
  enabled: boolean;
};

/** One line for one agent. Three states, three strings -- collapsing
 *  available-but-disabled into either neighbour hides the fix. */
export function agentLine(a: Agent): string {
  if (!a.available) return `Offline — ${a.detail}`;
  if (!a.enabled) return `Installed, not turned on — ${a.detail}`;
  return `Connected — ${a.detail}`;
}

/** Whether she can run anything at all: installed AND enabled. Used to
 *  explain an agent surface that has nothing to offer, rather than showing an
 *  empty list that looks like a loading failure. */
export function anyAgentAvailable(list: Agent[]): boolean {
  return list.some((a) => a.available && a.enabled);
}
