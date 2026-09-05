"use client";

// Plan shapes: the workflow templates a mission can be built from, and an
// editor for them.
//
// Lives in the Missions panel rather than the rail: a template IS a mission's
// plan, and the rail has held at eight items on the rule that it stays in
// plain words. Collapsed by default, because the missions list above it is
// what someone opens this panel for.
//
// The editor is JSON checked by the SAME validator the loader runs at startup
// (see lib/templates.ts for why there is only one), so a template that saves
// is one that will still load. Save stays enabled for a semantically bad body
// and the server's reason is shown — a disabled button is a label, the server
// is the lock.
import { useCallback, useEffect, useState } from "react";
import { ApiError, ydelete, yget, yput } from "@/lib/api";
import {
  canSave, editableBody, parseBody, templateActions, templateSubtitle,
  type TemplateSummary,
} from "@/lib/templates";
import { ViewError } from "./ViewError";

export function Templates() {
  const [rows, setRows] = useState<TemplateSummary[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string>("");
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
    if (open && rows === null) void load();
  }, [open, rows, load]);

  const edit = (t: TemplateSummary) => {
    const body = editableBody(t);
    setEditing(t.name);
    setText(body);
    setOriginal(body);
    setError("");
  };

  const save = async () => {
    const parsed = parseBody(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await yput(`templates/${editing}`, parsed.body);
      setEditing("");
      setRows(null);
      await load();
    } catch (e) {
      // The backend's own message: it names the cycle's members, the unknown
      // role, or the check that does not exist.
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revert = async (t: TemplateSummary) => {
    setBusy(true);
    setError("");
    try {
      await ydelete(`templates/${t.name}`);
      setEditing("");
      setRows(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const parsed = parseBody(text);

  return (
    <section className="tpl">
      <div className="mcp-head">
        <h3 className="sectitle">
          <button className="tpl-toggle" onClick={() => setOpen((v) => !v)}>
            {open ? "▾" : "▸"} Plan shapes
          </button>
        </h3>
      </div>

      {open && (
        <>
          <p className="mcp-blurb">
            The shapes a mission&rsquo;s plan can take. Editing one changes every mission
            started from it afterwards; the ones that ship with Yuri can always be reset.
          </p>

          {loadError ? (
            <ViewError error={loadError} onRetry={() => void load()} />
          ) : rows === null ? (
            <div className="empty">Loading…</div>
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

                    {editing === t.name ? (
                      <>
                        <textarea
                          className="tpl-editor"
                          value={text}
                          spellCheck={false}
                          rows={Math.min(30, text.split("\n").length + 2)}
                          onChange={(e) => { setText(e.target.value); setError(""); }}
                        />
                        {/* The parser's own message, which names the position. */}
                        {!parsed.ok && <em className="sp-err">{parsed.error}</em>}
                        {error && <pre className="mcp-err">{error}</pre>}
                        <div className="mcp-actions">
                          <button className="txtoggle primary" disabled={busy || !canSave(text, original)}
                                  onClick={() => void save()}>
                            {busy ? "Saving…" : "Save"}
                          </button>
                          <button className="txtoggle" onClick={() => { setEditing(""); setError(""); }}>
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="mcp-actions">
                        <button className="txtoggle" onClick={() => edit(t)}>Edit</button>
                        {/* Absent unless there is a default to go back to. */}
                        {actions.reset && (
                          <button className="txtoggle" disabled={busy}
                                  onClick={() => void revert(t)}>Reset to default</button>
                        )}
                        {actions.remove && (
                          <button className="txtoggle danger" disabled={busy}
                                  onClick={() => void revert(t)}>Delete</button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
