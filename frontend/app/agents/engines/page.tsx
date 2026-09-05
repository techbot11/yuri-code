"use client";

// Engines: the runtimes an agent runs on, and their health.
//
// Relabelled from "Agents" when the roster arrived — this table is the
// PROVIDER list, and calling both things agents is what made the panel
// ambiguous in the first place.
//
// Probes once on mount rather than subscribing: agent health has no driving
// event (there is no `agent.*` beyond agent.error), so there is nothing to
// subscribe to.
import { useCallback, useEffect, useState } from "react";
import { useYuri, type Agent } from "@/components/VoiceProvider";
import { ViewError } from "@/components/ViewError";

const CAP_LABEL: Record<string, string> = {
  interactive_terminal: "Interactive terminal",
  slash_commands: "Slash commands",
  send_keys: "Send keys",
  permission_modes: "Permission modes",
  supports_interrupt: "Interrupt",
  supports_rehydrate: "Rehydrate",
  supports_resume: "Resume",
  supports_events: "Events",
  cost_tracking: "Cost tracking",
};

function capLabel(key: string): string {
  return CAP_LABEL[key] ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function capDisplay(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (value === null || value === undefined) return "—";
  return String(value);
}

export default function Page() {
  const { agents, refresh } = useYuri();
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      await refresh("agents");
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    }
  }, [refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="engines-view">
      <p className="mcp-blurb">The runtimes your agents run on.</p>
      {loadError ? (
        <ViewError error={loadError} onRetry={() => void load()} />
      ) : agents.length === 0 ? (
        <div className="empty">No engines registered.</div>
      ) : (
        <div className="agents-list">
          {agents.map((a) => <AgentCard key={a.id} a={a} />)}
        </div>
      )}
    </section>
  );
}

function AgentCard({ a }: { a: Agent }) {
  const caps = a.capabilities && typeof a.capabilities === "object" ? a.capabilities : {};
  const entries = Object.entries(caps);
  const sessions = a.active_sessions ?? 0;

  return (
    <div className="agent-card">
      <div className="agent-head">
        <span className="agent-name">{a.name}</span>
        <span className={`agentchip ${a.online ? "online" : "offline"}`}>
          {a.online ? "Online" : "Offline"}
        </span>
        {a.version && <span className="agent-version">{a.version}</span>}
      </div>
      {/* `detail` is the field that EXPLAINS a state — the reason Phase 5 had
          to teach health() that a spawnable-but-not-running OpenCode is
          online at all. */}
      {a.detail && <p className="agent-detail">{a.detail}</p>}
      <div className="agent-meta">
        {sessions} active session{sessions === 1 ? "" : "s"}
      </div>
      {entries.length > 0 && (
        <div className="agent-caps">
          {entries.map(([key, value]) => (
            <div className="agent-cap" key={key}>
              <span className="agent-cap-label">{capLabel(key)}</span>
              {typeof value === "boolean" ? (
                <span className={`agent-cap-mark ${value ? "yes" : "no"}`}>
                  {value ? "✓" : "✗"}
                </span>
              ) : (
                <span className="agent-cap-value">{capDisplay(value)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
