import test from "node:test";
import assert from "node:assert/strict";
import { AGENTS, MISSIONS, activeTab, showsTabs, type Panel } from "./panelTabs.ts";

const PANELS: [string, Panel][] = [["agents", AGENTS], ["missions", MISSIONS]];

// --- rules that must hold for EVERY panel, so a third one inherits them ----

for (const [name, panel] of PANELS) {
  test(`${name}: every tab is labelled and rooted under the panel`, () => {
    assert.ok(panel.tabs.length >= 2, "a one-tab panel does not need tabs");
    assert.equal(panel.tabs[0].href, panel.root, "the first tab is the panel itself");
    for (const t of panel.tabs) {
      assert.ok(t.href === panel.root || t.href.startsWith(panel.root + "/"), t.href);
      assert.ok(t.label.length > 3, t.label);
    }
  });

  test(`${name}: each tab route resolves to itself and shows the bar`, () => {
    for (const t of panel.tabs) {
      assert.equal(activeTab(panel, t.href), t.href, t.href);
      assert.equal(showsTabs(panel, t.href), true, t.href);
    }
  });

  test(`${name}: a trailing slash changes nothing`, () => {
    assert.equal(activeTab(panel, panel.root + "/"), panel.root);
    assert.equal(showsTabs(panel, panel.root + "/"), true);
  });

  test(`${name}: a path outside the panel belongs to no tab`, () => {
    for (const p of ["/", "/memory", "", "/somewhere"]) {
      assert.equal(activeTab(panel, p), "", p);
    }
  });

  test(`${name}: the root is never treated as a form`, () => {
    // A panel whose own landing page hid its tabs would have no way back.
    assert.equal(showsTabs(panel, panel.root), true);
  });
}

// --- the specific mappings, which are what actually go wrong --------------

test("agents: longest match wins, so a nested route is not swallowed", () => {
  // THE case: every tab href starts with "/agents", so a first-match scan
  // would put the whole panel under the first tab.
  assert.equal(activeTab(AGENTS, "/agents/services/new"), "/agents/services");
  assert.equal(activeTab(AGENTS, "/agents/engines"), "/agents/engines");
});

test("agents: the editor belongs to the Agents tab and hides the bar", () => {
  const id = "/agents/ab34091e-bab1-417c-a23d-942a4d9619ba";
  assert.equal(activeTab(AGENTS, id), "/agents");
  assert.equal(showsTabs(AGENTS, id), false);
  assert.equal(showsTabs(AGENTS, "/agents/new"), false);
  assert.equal(showsTabs(AGENTS, "/agents/services/new"), false);
});

test("missions: a mission's own page belongs to Missions and hides the bar", () => {
  const id = "/missions/7f2c1d40-0c2a-4c1e-9b77-2b6a0d5e4411";
  assert.equal(activeTab(MISSIONS, id), "/missions");
  // It brings its own back link and title, so tabs above it would be a
  // second, competing way out of the same page.
  assert.equal(showsTabs(MISSIONS, id), false);
});

test("missions: the template editor belongs to Plan shapes and hides the bar", () => {
  assert.equal(activeTab(MISSIONS, "/missions/templates/bug-fix"), "/missions/templates");
  assert.equal(showsTabs(MISSIONS, "/missions/templates/bug-fix"), false);
});

test("missions: the templates list itself keeps its tabs", () => {
  // It is a tab, and it matches /^\/missions\/[^/]+$/ — the tab check has to
  // win, or the Plan shapes tab would hide the bar the moment you opened it.
  assert.equal(showsTabs(MISSIONS, "/missions/templates"), true);
  assert.equal(activeTab(MISSIONS, "/missions/templates"), "/missions/templates");
});

test("the two panels do not claim each other's paths", () => {
  assert.equal(activeTab(AGENTS, "/missions"), "");
  assert.equal(activeTab(MISSIONS, "/agents"), "");
});
