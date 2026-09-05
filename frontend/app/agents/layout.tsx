"use client";

// The Agents panel's tab bar, and the three routes under it.
//
// Was one scrolling page with three stacked sections: the roster, the engine
// table and the MCP servers. That put unrelated things in one column and made
// the roster's own controls easy to lose — which is the same complaint that
// moved the agent form onto its own route.
//
// Tabs are ROUTES rather than state, for the reason the shell already uses
// routes for panels: deep links, Back and refresh all work for free, and
// there is no `currentTab` to fall out of step with what is on screen.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AGENTS, activeTab, showsTabs } from "@/lib/panelTabs";

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // A form gets the whole panel and a back link. Tabs above a half-filled
  // form invite a click that silently discards what you typed.
  if (!showsTabs(AGENTS, pathname)) return <>{children}</>;

  const active = activeTab(AGENTS, pathname);
  return (
    <div className="agents-view">
      <h2 className="viewtitle">Agents</h2>
      <nav className="tabs" aria-label="Agents sections">
        {AGENTS.tabs.map((t) => (
          <Link key={t.href} href={t.href}
                className={`tab ${t.href === active ? "on" : ""}`}
                aria-current={t.href === active ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
