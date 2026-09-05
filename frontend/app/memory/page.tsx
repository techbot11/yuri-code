"use client";

// Memory: what Yuri remembers about you, and which of it reaches her.
//
// A ninth rail item. The rail held at eight on the rule that it stays in
// plain words rather than jargon — "Memory" is a plain word and a genuinely
// distinct thing, and the Dashboard route renders nothing (it is the closed
// state of the panel), so there was no existing home.
//
// The view's job is the thing the old store could not do: show which memories
// are in her prompt and which are not, and let you change that by pinning.
// Every rule is in lib/memory.ts so `node --test` can reach it.
import { useCallback, useEffect, useState } from "react";
import { ApiError, ydelete, yget, ypost, yput } from "@/lib/api";
import {
  EMPTY_MEMORY, KINDS, SOURCES, budgetSummary, canSaveMemory, groupByKind,
  kindLabel, memoryBody, needsSlug, promptState, rowActions, sourceLabel,
  validateMemory, type Budget, type Kind, type Memory, type MemoryForm, type Source,
} from "@/lib/memory";
import { ViewError } from "@/components/ViewError";

type Payload = { memories: Memory[]; budget: Budget };

export default function Page() {
  const [rows, setRows] = useState<Memory[] | null>(null);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<MemoryForm>(EMPTY_MEMORY);
  const [replacing, setReplacing] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showRetired, setShowRetired] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await yget<Payload>(
        `memories${showRetired ? "?include_superseded=true" : ""}`);
      setRows(data.memories || []);
      setBudget(data.budget || null);
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    }
  }, [showRetired]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const add = async () => {
    setBusy("new");
    setError("");
    try {
      await ypost("memories", memoryBody(form));
      setForm(EMPTY_MEMORY);
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const supersede = async (id: string) => {
    await act(id, () => ypost(`memories/${id}/supersede`, { body: replacement }));
    setReplacing("");
    setReplacement("");
  };

  const summary = budgetSummary(budget);
  const errors = validateMemory(form);

  return (
    <div className="mem-view">
      <h2 className="viewtitle">Memory</h2>

      <div className="mcp-head">
        <p className="mcp-blurb">
          What Yuri remembers about you. Everything here is yours to change or delete — and the
          line under each one says whether it reaches her.
        </p>
        <div className="mcp-actions">
          {/* Retired memories are hidden by default — they are history, not
              what she knows. But they must be REACHABLE, because bringing one
              back is the only way out of a wrong replacement. */}
          <button className="txtoggle" onClick={() => setShowRetired((v) => !v)}>
            {showRetired ? "Hide retired" : "Show retired"}
          </button>
          {!adding && rows && (
            <button className="txtoggle" onClick={() => setAdding(true)}>Add a memory</button>
          )}
        </div>
      </div>

      {/* The budget report: the "nothing is dropped silently" rule made into
          something you can see and fix. */}
      {summary.text && <div className={`mem-budget ${summary.tone}`}>{summary.text}</div>}

      {error && <pre className="mcp-err">{error}</pre>}

      {adding && (
        <div className="sp-form">
          <label className="mcp-field">
            <span>What should she remember?</span>
            <textarea rows={2} value={form.body} spellCheck={false}
                      placeholder="Always ask before cancelling a mission."
                      onChange={(e) => setForm({ ...form, body: e.target.value })} />
            {errors.body && <em className="sp-err">{errors.body}</em>}
          </label>

          <div className="mcp-field">
            <span>What kind?</span>
            <div className="sp-capgrid">
              {KINDS.map((k) => (
                <button key={k} className={`sp-captoggle ${form.kind === k ? "on" : ""}`}
                        onClick={() => setForm({ ...form, kind: k as Kind })}>
                  {kindLabel(k)}
                </button>
              ))}
            </div>
          </div>

          {/* Only for the kinds that take one — a slug on a preference is
              meaningless and would make it unselectable. */}
          {needsSlug(form.kind) && (
            <label className="mcp-field">
              <span>Which project?</span>
              <input value={form.subject} spellCheck={false} placeholder="yuri-code"
                     onChange={(e) => setForm({ ...form, subject: e.target.value })} />
              {errors.subject && <em className="sp-err">{errors.subject}</em>}
            </label>
          )}

          <div className="mcp-field">
            <span>Where did it come from?</span>
            <div className="sp-capgrid">
              {SOURCES.map((s) => (
                <button key={s} className={`sp-captoggle ${form.source === s ? "on" : ""}`}
                        onClick={() => setForm({ ...form, source: s as Source })}>
                  {sourceLabel(s)}
                </button>
              ))}
            </div>
          </div>

          <div className="mcp-actions">
            {canSaveMemory(form) && (
              <button className="txtoggle primary" disabled={busy === "new"}
                      onClick={() => void add()}>
                {busy === "new" ? "Saving…" : "Remember it"}
              </button>
            )}
            <button className="txtoggle" onClick={() => { setAdding(false); setError(""); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loadError ? (
        <ViewError error={loadError} onRetry={() => void load()} />
      ) : rows === null ? (
        <div className="empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          She doesn&rsquo;t remember anything yet. Tell her something, or add one here.
        </div>
      ) : (
        groupByKind(rows).map(([kind, group]) => (
          <section className="mem-group" key={kind}>
            <h3 className="sectitle">{kindLabel(kind)}</h3>
            <div className="mem-list">
              {group.map((m) => {
                const state = promptState(m);
                const actions = rowActions(m);
                return (
                  <div className={`mem-row ${state.in ? "in" : "out"}`} key={m.id}>
                    <p className="mem-body">{m.body}</p>
                    <div className="mem-meta">
                      {sourceLabel(m.source)} · {(m.created_at || "").slice(0, 10)}
                      {m.subject !== "user" ? ` · ${m.subject}` : ""}
                      {m.embedded === false ? " · not searchable by meaning yet" : ""}
                    </div>
                    {/* Never just "no". */}
                    <div className={`mem-state ${state.in ? "in" : "out"}`}>
                      {state.in ? "In her prompt" : "Not in her prompt"} — {state.why}
                    </div>

                    {replacing === m.id ? (
                      <div className="mcp-field">
                        <span>Replace it with</span>
                        <textarea rows={2} value={replacement} spellCheck={false}
                                  onChange={(e) => setReplacement(e.target.value)} />
                        <div className="mcp-actions">
                          <button className="txtoggle primary"
                                  disabled={busy === m.id || !replacement.trim()}
                                  onClick={() => void supersede(m.id)}>Replace</button>
                          <button className="txtoggle"
                                  onClick={() => { setReplacing(""); setReplacement(""); }}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mcp-actions">
                        {actions.pin && (
                          <button className="txtoggle" disabled={busy === m.id}
                                  onClick={() => void act(m.id, () =>
                                    yput(`memories/${m.id}`, { pinned: true }))}>
                            Always include
                          </button>
                        )}
                        {actions.unpin && (
                          <button className="txtoggle" disabled={busy === m.id}
                                  onClick={() => void act(m.id, () =>
                                    yput(`memories/${m.id}`, { pinned: false }))}>
                            Stop always including
                          </button>
                        )}
                        {actions.restore && (
                          <button className="txtoggle" disabled={busy === m.id}
                                  onClick={() => void act(m.id, () =>
                                    ypost(`memories/${m.id}/restore`))}>
                            Bring it back
                          </button>
                        )}
                        {actions.supersede && (
                          <button className="txtoggle" disabled={busy === m.id}
                                  onClick={() => { setReplacing(m.id); setReplacement(""); }}>
                            Replace
                          </button>
                        )}
                        <button className="txtoggle danger" disabled={busy === m.id}
                                onClick={() => void act(m.id, () =>
                                  ydelete(`memories/${m.id}`))}>
                          Forget
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
