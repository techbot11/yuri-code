"use client";

// Connected services: the MCP servers that give Yuri tools beyond her own.
//
// Lives in the Agents panel (the panel is already "what she can do with
// what"), as its SECOND section -- not a new rail item, which would put
// jargon in a list otherwise written in plain words.
//
// Two rules from docs/yuri/design/GUIDE.md do most of the work here:
//
//   * A control that would fail is not rendered. Reconnect appears only on a
//     service that is actually down; Save appears only when the form can be
//     saved -- which means only after a test has answered for THIS form.
//   * Empty, failed and loading never look the same.
//
// Every decision about validity lives in lib/mcp.ts so `node --test` can
// reach it; this file keeps the state and the fetches.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ydelete, yget, ypost, yput } from "@/lib/api";
import { rowActions, type ServerRow } from "@/lib/mcp";
import { ViewError } from "./ViewError";

type Listing = { servers: ServerRow[]; config_error?: string };

export function McpServers() {
  const [rows, setRows] = useState<ServerRow[] | null>(null);
  const [configError, setConfigError] = useState("");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState("");
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const data = await yget<Listing>("mcp");
      setRows(data.servers || []);
      setConfigError(data.config_error || "");
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await fn();
      await load();
    } catch (e) {
      setLoadError(e);
    } finally {
      setBusy("");
    }
  };

  return (
    <section>
      <div className="mcp-head">
        <h3 className="sectitle">MCP Connector</h3>
        {rows && (
          <button className="txtoggle" onClick={() => router.push("/agents/services/new")}>
            Add a service
          </button>
        )}
      </div>
      <p className="mcp-blurb">
        Each service gives Yuri tools of its own. She says where an answer came from, and
        will ask first if you tell her to.
      </p>

      {configError && (
        <div className="mcp-configerr">
          Your <code>mcp.json</code> can&rsquo;t be read, so no services are connected: {configError}
        </div>
      )}


      {loadError ? (
        <ViewError error={loadError} onRetry={() => void load()} />
      ) : rows === null ? (
        <div className="empty">Checking…</div>
      ) : rows.length === 0 ? (
        <div className="empty">No services connected. Yuri uses her own tools only.</div>
      ) : (
        <div className="mcp-list">
          {rows.map((r) => (
            <ServerCard
              key={r.name}
              row={r}
              busy={busy === r.name}
              onReconnect={() => void act(r.name, () => ypost(`mcp/${r.name}/reconnect`))}
              onToggle={(enabled) =>
                void act(r.name, () => yput(`mcp/${r.name}/enabled`, { enabled }))
              }
              onRemove={() => void act(r.name, () => ydelete(`mcp/${r.name}`))}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ServerCard({ row, busy, onReconnect, onToggle, onRemove }: {
  row: ServerRow; busy: boolean;
  onReconnect: () => void; onToggle: (enabled: boolean) => void; onRemove: () => void;
}) {
  // Arm-then-fire, in the row, like the mission Delete flow. No confirm().
  const [armed, setArmed] = useState(false);
  const actions = rowActions(row);
  const label = row.status === "connected" ? "Connected"
    : row.status === "disabled" ? "Off" : "Not working";

  return (
    <div className="mcp-card">
      <div className="mcp-cardhead">
        <span className="mcp-name">{row.name}</span>
        <span className={`agentchip ${row.status === "connected" ? "online" : row.status === "disabled" ? "off" : "offline"}`}>
          {label}
        </span>
        {row.server_name && row.server_name !== row.name && (
          <span className="agent-version">
            {row.server_name}
            {row.server_version ? ` ${row.server_version}` : ""}
          </span>
        )}
      </div>

      {/* In full, not in a tooltip: this is the only thing the user can act on. */}
      {row.status === "failed" && row.error && <pre className="mcp-err">{row.error}</pre>}

      <div className="mcp-meta">
        {row.status === "connected"
          ? `${row.tool_count ?? 0} tool${row.tool_count === 1 ? "" : "s"}`
          : "No tools while it isn’t running"}
        {row.env_keys?.length ? ` · keys: ${row.env_keys.join(", ")}` : ""}
      </div>

      {row.tools?.length ? <div className="mcp-tools">{row.tools.join(" · ")}</div> : null}

      {/* Never silent: a dropped or shadowed tool the list doesn't mention is
          the capability map lying by omission. */}
      {row.dropped_tools ? (
        <div className="mcp-note">
          It offers {row.dropped_tools} more tool{row.dropped_tools === 1 ? "" : "s"} than Yuri
          will take on.
        </div>
      ) : null}
      {row.colliding_tools?.length ? (
        <div className="mcp-note">
          Two of its tools have names Yuri can&rsquo;t tell apart, so these are left out:{" "}
          {row.colliding_tools.join(", ")}
        </div>
      ) : null}

      <div className="mcp-actions">
        {actions.reconnect && (
          <button className="txtoggle" disabled={busy} onClick={onReconnect}>
            Try again
          </button>
        )}
        <button
          className="txtoggle"
          disabled={busy}
          onClick={() => onToggle(actions.toggle === "enable")}
        >
          {actions.toggle === "enable" ? "Turn on" : "Turn off"}
        </button>
        {armed ? (
          <>
            <button className="txtoggle danger" disabled={busy} onClick={onRemove}>
              Remove for good
            </button>
            <button className="txtoggle" disabled={busy} onClick={() => setArmed(false)}>
              Keep
            </button>
          </>
        ) : (
          <button className="txtoggle" disabled={busy} onClick={() => setArmed(true)}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

