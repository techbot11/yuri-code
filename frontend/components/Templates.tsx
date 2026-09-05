"use client";

// Plan shapes: the workflow templates a mission can be built from.
//
// Lives in the Missions panel rather than the rail: a template IS a mission's
// plan, and the rail has held at eight items on the rule that it stays in
// plain words. Its own tab rather than a collapsed section under the missions
// list, because a section folded away at the bottom of a long list is one
// nobody opens.
//
// The editor is a ROUTE (/missions/templates/<name>), not an expanding box in
// this list — the same fix the agent form got, and for the same reason: a
// form that unfolds in place looks like a click that did nothing.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, ydelete, yget } from "@/lib/api";
import { templateActions, templateSubtitle, type TemplateSummary } from "@/lib/templates";
import { ViewError } from "./ViewError";

export function Templates() {
  const [rows, setRows] = useState<TemplateSummary[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const data = await yget<{ templates: TemplateSummary[] }>("templates");
      setRows(data.templates || []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Reset and Delete are the same call — DELETE drops the override in
  // ~/Yuri/templates, which either reveals the shipped default again or
  // removes the template entirely. Which of the two it is depends on whether
  // a default exists, which is what templateActions() decides.
  const revert = async (t: TemplateSummary) => {
    setBusy(t.name);
    setError("");
    try {
      await ydelete(`templates/${t.name}`);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="tpl">
      <div className="mcp-head">
        <h3 className="sectitle">Plan shapes</h3>
      </div>
      <p className="mcp-blurb">
        The shapes a mission&rsquo;s plan can take. Editing one changes every mission
        started from it afterwards, not the ones already running; the ones that ship
        with Yuri can always be reset.
      </p>

      {error && <pre className="mcp-err">{error}</pre>}

      {loadError ? (
        <ViewError error={loadError} onRetry={() => void load()} />
      ) : rows === null ? (
        <div className="empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">No plan shapes. Missions have nothing to be built from.</div>
      ) : (
        <div className="tpl-list">
          {rows.map((t) => {
            const actions = templateActions(t);
            return (
              <div className="tpl-row" key={t.name}>
                <div className="tpl-head">
                  <span className="tpl-name">{t.name}</span>
                  {t.custom && <span className="agentchip off">Edited</span>}
                  <span className="tpl-meta">{templateSubtitle(t)}</span>
                </div>
                <p className="tpl-desc">{t.description}</p>
                <div className="mcp-actions">
                  <button className="txtoggle"
                          onClick={() => router.push(`/missions/templates/${t.name}`)}>
                    Edit
                  </button>
                  {/* Absent unless there is a default to go back to. */}
                  {actions.reset && (
                    <button className="txtoggle" disabled={busy === t.name}
                            onClick={() => void revert(t)}>Reset to default</button>
                  )}
                  {actions.remove && (
                    <button className="txtoggle danger" disabled={busy === t.name}
                            onClick={() => void revert(t)}>Delete</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
