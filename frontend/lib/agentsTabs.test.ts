import test from "node:test";
import assert from "node:assert/strict";
import { FORM_ROUTES, TABS, activeTab, showsTabs } from "./agentsTabs.ts";

test("there are three tabs and each says what it holds", () => {
  assert.equal(TABS.length, 3);
  for (const t of TABS) {
    assert.ok(t.href.startsWith("/agents"), t.href);
    assert.ok(t.label.length > 3, t.label);
    assert.ok(t.blurb.length > 15, `${t.label} does not say what it holds`);
  }
});

test("each tab route resolves to itself", () => {
  for (const t of TABS) assert.equal(activeTab(t.href), t.href, t.href);
});

test("longest match wins, so a nested route is not swallowed by /agents", () => {
  // THE case: every tab href starts with "/agents", so a first-match scan
  // would put the whole panel under the first tab.
  assert.equal(activeTab("/agents/services/new"), "/agents/services");
  assert.equal(activeTab("/agents/engines"), "/agents/engines");
});

test("the agent editor belongs to the Agents tab", () => {
  assert.equal(activeTab("/agents/ab34091e-bab1-417c-a23d-942a4d9619ba"), "/agents");
  assert.equal(activeTab("/agents/new"), "/agents");
});

test("a trailing slash changes nothing", () => {
  assert.equal(activeTab("/agents/"), "/agents");
  assert.equal(activeTab("/agents/services/"), "/agents/services");
});

test("a path outside the panel belongs to no tab", () => {
  for (const p of ["/missions", "/", "/memory", ""]) {
    assert.equal(activeTab(p), "", p);
  }
});

test("a form route hides the tab bar", () => {
  // Tabs above a half-filled form invite a click that silently discards it.
  for (const p of FORM_ROUTES) assert.equal(showsTabs(p), false, p);
  assert.equal(showsTabs("/agents/ab34091e-bab1-417c-a23d-942a4d9619ba"), false);
});

test("a tab route shows the tab bar", () => {
  for (const t of TABS) assert.equal(showsTabs(t.href), true, t.href);
  assert.equal(showsTabs("/agents/"), true);
});
