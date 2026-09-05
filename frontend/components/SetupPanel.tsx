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
  blocking, canSave, effectsSentence, fieldPlaceholder, fieldValue, fixAction,
  pendingChanges, shellShadowWarning,
  type DoctorCheck, type Effect, type ManagedKey,
} from "@/lib/setup";
import { ViewError } from "./ViewError";

// The copy control for a `command` fix. Local because it owns one piece of
// throwaway state (the "Copied" confirmation) and nothing else needs it; the
// DECISION of whether to render it at all is fixAction()'s, in lib/setup.ts,
// where a test can reach it.
function CopyCommand({ command, label }: { command: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="setup-fix">
      <code className="setup-fix-cmd">{command}</code>
      <button
        type="button"
        className="txtoggle"
        aria-label={`${label}: ${command}`}
        onClick={() => {
          // clipboard is unavailable over plain http on a LAN address, and
          // the user can still select the command text — so a failure must
          // not throw, it just doesn't say "Copied".
          void navigator.clipboard?.writeText(command)
            .then(() => setDone(true))
            .catch(() => setDone(false));
        }}
      >
        {done ? "Copied" : label}
      </button>
    </span>
  );
}

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
        {checks.map((c) => {
          // Spec §6.2: a failing check carries the action that fixes it.
          const fix = fixAction(c);
          return (
            <div key={c.name} className={`setup-check ${c.ok ? "ok" : c.required ? "bad" : "warn"}`}>
              <span className="setup-check-name">{c.name}</span>
              <span className="setup-check-detail">{c.detail}</span>
              {fix?.kind === "url" && (
                <a className="setup-fix" href={fix.href} target="_blank" rel="noreferrer noopener">
                  {fix.label} →
                </a>
              )}
              {fix?.kind === "command" && (
                <CopyCommand command={fix.command} label={fix.label} />
              )}
              {!c.ok && !c.required && (
                <span className="tf-hint">Optional — she works without it.</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="mcp-head" style={{ marginTop: 22 }}>
        <h3 className="sectitle">Keys and models</h3>
      </div>
      <p className="mcp-blurb">
        Saved to <code>{where}</code>, readable only by you — the same file{" "}
        <code>yapcode config</code> edits. What you saved is shown here, except for
        secrets: a key never comes back to this screen, so its field starts empty and
        leaving it that way keeps the current one.
      </p>

      <div className="setup-keys">
        {keys.map((k) => {
          // A value exported in the user's shell beats every file Setup can
          // write, so a save here works now and reverts at the next start.
          // Said BEFORE the save, on the field.
          const shadow = shellShadowWarning(k);
          return (
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
              placeholder={fieldPlaceholder(k)}
              value={fieldValue(k, draft)}
              onChange={(e) => {
                setDraft({ ...draft, [k.name]: e.target.value });
                setSaved("");
              }}
            />
            <span className="tf-hint">{k.blurb}</span>
            {shadow && <span className="setup-shadow">{shadow}</span>}
          </label>
          );
        })}
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
