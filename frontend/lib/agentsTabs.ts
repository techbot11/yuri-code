// The Agents panel's tabs, and which one a path belongs to.
//
// Pure so `node --test` reaches it, and separate from the layout because the
// mapping has a subtlety worth testing: a FORM route belongs to a tab even
// though its path is not the tab's path. `/agents/<id>` is the agent editor
// and belongs to Agents; `/agents/services/new` is the MCP form and belongs
// to Connected services.

export type Tab = { href: string; label: string; blurb: string };

/** Order is the order they render. Agents first because it is what the panel
 *  is named for; engines and services are what run and extend them. */
export const TABS: Tab[] = [
  {
    href: "/agents", label: "Your agents",
    blurb: "Specialists Yuri hands work to."
  },
  {
    href: "/agents/engines", label: "Engines",
    blurb: "The runtimes your agents run on."
  },
  {
    href: "/agents/services", label: "MCP Connector",
    blurb: "Tools Yuri can use herself, from MCP servers you add."
  },
];

/** Routes that are FORMS rather than tabs: they render alone, with a back
 *  link, and no tab bar above them. Listed rather than inferred, because
 *  "has more segments" would also match a future `/agents/engines/<id>`. */
export const FORM_ROUTES = ["/agents/new", "/agents/services/new"];

/** Which tab a path belongs to, or "" for a path outside the panel.
 *
 *  Longest match wins, so `/agents/services/new` resolves to the services tab
 *  rather than to `/agents` — every tab href starts with `/agents`, so a
 *  first-match scan would put everything under the first tab.
 */
export function activeTab(pathname: string): string {
  const path = (pathname || "").replace(/\/+$/, "") || "/";
  if (!path.startsWith("/agents")) return "";
  let best = "";
  for (const t of TABS) {
    if ((path === t.href || path.startsWith(t.href + "/")) && t.href.length > best.length) {
      best = t.href;
    }
  }
  // A path under /agents that matched no tab is an agent id — the editor —
  // which belongs to the tab it was opened from.
  return best || "/agents";
}

/** Whether the tab bar should render at all. A form gets the whole panel and
 *  a back link; showing tabs above it would invite a click that silently
 *  discards what you typed. */
export function showsTabs(pathname: string): boolean {
  const path = (pathname || "").replace(/\/+$/, "") || "/";
  if (FORM_ROUTES.includes(path)) return false;
  // The agent editor, /agents/<id>, is also a form.
  return !/^\/agents\/[^/]+$/.test(path) || TABS.some((t) => t.href === path);
}
