"use client";

// The Missions panel's tab bar, and the routes under it.
//
// Was one scrolling page: the missions list with the template editor
// collapsed underneath it. Plan shapes are not a footnote to the list —
// they are what every mission in it was built from — and a collapsed
// section at the bottom of a long list is one nobody opens.
//
// Tabs are ROUTES rather than state, matching the Agents panel: deep links,
// Back and refresh work for free, and there is no `currentTab` to fall out of
// step with what is on screen.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MISSIONS, activeTab, showsTabs } from "@/lib/panelTabs";

export default function MissionsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // A mission's own page and the template editor each bring their own title
  // and back link; tabs above them would be a second, competing way out.
  if (!showsTabs(MISSIONS, pathname)) return <>{children}</>;

  const active = activeTab(MISSIONS, pathname);
  return (
    <div className="miss-view">
      <h2 className="viewtitle">Missions</h2>
      <nav className="tabs" aria-label="Missions sections">
        {MISSIONS.tabs.map((t) => (
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
