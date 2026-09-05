"use client";

// Setup: what must be true for Yuri to work, and the settings you can change
// from here instead of editing a file.
//
// The checks come from the same `yuri doctor` implementation the CLI prints,
// so the two cannot disagree. Secret values are never sent to the browser —
// a secret field therefore starts EMPTY with its hint beside the label, and
// leaving it empty changes nothing.
import { useCallback, useEffect, useState } from "react";
import { ApiError, yget, yput } from "@/lib/api";
import {
  blocking, canSave, effectsSentence, pendingChanges,
  type DoctorCheck, type Effect, type ManagedKey,
} from "@/lib/setup";
import { ViewError } from "./ViewError";

export function SetupPanel({ onPass }: { onPass?: () => void }) {
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [keys, setKeys] = useState<ManagedKey[] | null>(null);
  const [where, setWhere] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<DoctorCheck[] | null> => {
    try {
      const [d, c] = await Promise.all([
        yget<{ checks: DoctorCheck[]; ok: boolean }>("doctor"),
        yget<{ keys: ManagedKey[]; path: string }>("config"),
      ]);
      const fresh = d.checks || [];
      setChecks(fresh);
      setKeys(c.keys || []);
      setWhere(c.path || "");
      setLoadError(null);
      // Whoever is showing this panel may be gating the app on it. Nothing
      // blocking means there is nothing left to gate on -- and the fix may
      // have happened elsewhere (the Rail's own Setup link mounts a second
      // panel), so waiting for a save here would strand the user on a screen
      // showing an all-green checklist.
      if (blocking(fresh).length === 0) onPass?.();
      return fresh;
    } catch (e) {
      setLoadError(e);
      return null;
    }
  }, [onPass]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!keys) return;
    const names = pendingChanges(keys, draft);
    setBusy(true);
    setSaveError("");
    setSaved("");
    try {
      const values: Record<string, string> = {};
      for (const n of names) values[n] = draft[n] ?? "";
      const res = await yput<{ effects: Effect[] }>("config", { values });
      setSaved(effectsSentence(res.effects || []));
      // Clear only the keys that were saved. Clearing the whole draft would
      // discard anything typed while the request was in flight -- the inputs
      // stay editable on purpose, so that window is real.
      setDraft((d) => {
        const rest = { ...d };
        for (const n of names) delete rest[n];
        return rest;
      });
      // Re-read rather than trusting the save: a key can be written and still
      // leave something else blocking. load() IS that re-read, and load()
      // itself now fires onPass when nothing is left blocking.
      await load();
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <section className="setup">
        <div className="mcp-head"><h3 className="sectitle">Setup</h3></div>
        <ViewError error={loadError} onRetry={() => void load()} />
      </section>
    );
  }
  if (!checks || !keys) {
    return (
      <section className="setup">
        <div className="mcp-head"><h3 className="sectitle">Setup</h3></div>
        <div className="empty">Checking your machine…</div>
      </section>
    );
  }

  const stops = blocking(checks);

  return (
    <section className="setup">
      <div className="mcp-head"><h3 className="sectitle">Setup</h3></div>
      <p className="mcp-blurb">
        What Yuri needs from this machine, and the keys she uses. These are the same
        checks <code>yuri doctor</code> runs.
      </p>

      {stops.length > 0 && (
        <div className="mcp-configerr">
          {stops.length === 1
            ? `One thing is stopping her: ${stops[0].name}.`
            : `${stops.length} things are stopping her: ${stops.map((s) => s.name).join(", ")}.`}
        </div>
      )}

      <div className="setup-checks">
        {checks.map((c) => (
          <div key={c.name} className={`setup-check ${c.ok ? "ok" : c.required ? "bad" : "warn"}`}>
            <span className="setup-check-name">{c.name}</span>
            <span className="setup-check-detail">{c.detail}</span>
            {!c.ok && !c.required && (
              <span className="tf-hint">Optional — she works without it.</span>
            )}
          </div>
        ))}
      </div>

      <div className="mcp-head" style={{ marginTop: 22 }}>
        <h3 className="sectitle">Keys and models</h3>
      </div>
      <p className="mcp-blurb">
        Saved to <code>{where}</code>, readable only by you. Yuri never sends a saved
        value back to this screen, so a key field starts empty — leave it that way to
        keep the current one.
      </p>

      <div className="setup-keys">
        {keys.map((k) => (
          <label className="tf-field" key={k.name}>
            <span className="tf-label">
              {k.label}
              {k.set && <span className="setup-hint"> · {k.hint} · from {k.source}</span>}
            </span>
            <input
              className="tf-input"
              type={k.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              placeholder={k.set ? (k.secret ? "unchanged" : k.hint) : "not set"}
              value={draft[k.name] ?? ""}
              onChange={(e) => {
                setDraft({ ...draft, [k.name]: e.target.value });
                setSaved("");
              }}
            />
            <span className="tf-hint">{k.blurb}</span>
          </label>
        ))}
      </div>

      {saveError && <pre className="mcp-err">{saveError}</pre>}
      {saved && <em className="setup-saved">{saved}</em>}

      <div className="mcp-actions tf-save">
        <button className="txtoggle primary" disabled={busy || !canSave(keys, draft)}
                onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="txtoggle" disabled={busy} onClick={() => void load()}>
          Check again
        </button>
      </div>
    </section>
  );
}
