import test from "node:test";
import assert from "node:assert/strict";
import { agentLine, anyAgentAvailable, type Agent } from "./agents.ts";

function agent(over: Partial<Agent> = {}): Agent {
  return { name: "claude-code", label: "Claude Code", available: true,
           detail: "/opt/bin/claude (2.1.261)", enabled: true, ...over };
}

test("an available, enabled agent reads as connected", () => {
  assert.match(agentLine(agent()), /Connected/);
});

test("a missing agent reads as offline, not as an error", () => {
  // "Offline" is the word: nothing is broken, it is simply not installed.
  const line = agentLine(agent({ available: false, detail: "not installed - no `claude` on PATH" }));
  assert.match(line, /Offline/);
  assert.doesNotMatch(line, /error|failed|broken/i);
});

test("installed but not enabled says so distinctly", () => {
  // Three states, three strings: connected, offline, available-but-off.
  // Collapsing the third into either neighbour hides a one-setting fix.
  const line = agentLine(agent({ enabled: false }));
  assert.doesNotMatch(line, /Connected/);
  assert.doesNotMatch(line, /Offline/);
  assert.match(line, /not turned on/i);
});

test("anyAgentAvailable needs installed AND enabled", () => {
  assert.equal(anyAgentAvailable([agent()]), true);
  assert.equal(anyAgentAvailable([agent({ available: false })]), false);
  assert.equal(anyAgentAvailable([agent({ enabled: false })]), false);
  assert.equal(anyAgentAvailable([]), false);
});

test("one working agent is enough even when another is offline", () => {
  assert.equal(anyAgentAvailable([
    agent({ name: "opencode", available: false }),
    agent(),
  ]), true);
});
