// Tabbed panels, and which tab a path belongs to.
//
// Two panels now use tabs — Agents and Missions — and the mapping has
// subtleties worth having in ONE tested place rather than two: longest match
// wins, and a form route belongs to a tab even though its path is not the
// tab's path.
//
// Pure, so `node --test` reaches it, and separate from the layouts because
// the rules are the part that can be wrong in a way nobody notices: a tab
// that quietly stays lit on the wrong route still renders fine.

export type Tab = { href: string; label: string };

export type Panel = {
  /** Every path in this panel starts here. */
  root: string;
  /** Order is the order they render. */
  tabs: Tab[];
  /** Paths that are a FORM or a DETAIL view rather than a tab: they render
   *  alone, with a back link, and no tab bar above them. A tab's own href is
   *  never a form, so these may overlap one without harm. Listed rather than
   *  inferred from segment count, because a future nested LISTING under a tab
   *  should keep its tabs. */
  forms: (string | RegExp)[];
};

const norm = (pathname: string) => (pathname || "").replace(/\/+$/, "") || "/";

export const AGENTS: Panel = {
  root: "/agents",
  // Agents first because it is what the panel is named for; engines and
  // connectors are what run and extend them.
  tabs: [
    { href: "/agents", label: "Your agents" },
    { href: "/agents/engines", label: "Engines" },
    { href: "/agents/services", label: "MCP Connector" },
  ],
  forms: [
    /^\/agents\/[^/]+$/, // the agent editor, /agents/<id>, and /agents/new
    "/agents/services/new",
  ],
};

export const MISSIONS: Panel = {
  root: "/missions",
  // Missions first: the list is what someone opens the panel for. Plan shapes
  // are what missions are built FROM, so they sit behind it rather than
  // stacked underneath it.
  tabs: [
    { href: "/missions", label: "Your missions" },
    { href: "/missions/templates", label: "Plan shapes" },
  ],
  forms: [
    /^\/missions\/[^/]+$/, // a mission's own page, which brings its own back link
    /^\/missions\/templates\/[^/]+$/, // the template editor
  ],
};

/** Which tab a path belongs to, or "" for a path outside the panel.
 *
 *  Longest match wins, so `/agents/services/new` resolves to the connector
 *  tab rather than to `/agents` — every tab href starts with the panel root,
 *  so a first-match scan would put everything under the first tab.
 */
export function activeTab(panel: Panel, pathname: string): string {
  const path = norm(pathname);
  if (path !== panel.root && !path.startsWith(panel.root + "/")) return "";
  let best = "";
  for (const t of panel.tabs) {
    if ((path === t.href || path.startsWith(t.href + "/")) && t.href.length > best.length) {
      best = t.href;
    }
  }
  // A path under the root that matched no tab is an id — an editor or a
  // detail view — which belongs to the tab it was opened from.
  return best || panel.root;
}

/** Whether the tab bar should render at all. A form gets the whole panel and
 *  a back link; showing tabs above it would invite a click that silently
 *  discards what you typed. */
export function showsTabs(panel: Panel, pathname: string): boolean {
  const path = norm(pathname);
  // A tab's own href is never a form, whatever the patterns say.
  if (panel.tabs.some((t) => t.href === path)) return true;
  return !panel.forms.some((f) => (typeof f === "string" ? f === path : f.test(path)));
}
