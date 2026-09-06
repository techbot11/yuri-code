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
import { agentLine, agentVisual, anyAgentAvailable, type Agent } from "@/lib/agents";
import {
  blocking, canSave, effectsSentence, fieldPlaceholder, fieldValue, fixAction,
  pendingChanges, shellShadowWarning,
  type DoctorCheck, type Effect, type ManagedKey,
} from "@/lib/setup";
import { ViewError } from "./ViewError";

// The desktop shell's credential bridge (desktop/preload/index.ts). Absent in
// a plain browser tab -- there is no safeStorage there -- so every call site
// below guards it and falls back to the existing PUT /yuri/config path. This
// is a SECOND transport for secret values, not a replacement: spec §6.3 asks
// that a secret never transit HTTP, not even on loopback, when the bridge is
// available to carry it instead.
type YuriCredentialsBridge = {
  write: (updates: Record<string, string>) =>
    Promise<{ ok: true; written: string[] } | { ok: false; error: string }>;
  names: () => Promise<{ names: string[]; unreadable: boolean }>;
};

/** Same pattern as SetupGate's yuriBoot() / VoiceProvider's yuriTray read: a
 *  plain cast, guarded, so a browser tab with no bridge is a no-op rather
 *  than a crash. */
function yuriCredentials(): YuriCredentialsBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { yuriCredentials?: YuriCredentialsBridge }).yuriCredentials;
}

/** `keys`, with `.set` corrected for a secret the Keychain holds but the
 *  running backend does not know about yet (see `pendingRestart` below).
 *
 *  Feeds pendingChanges()/canSave() ONLY -- never the rendered field itself,
 *  which still needs the backend's real `.set` to decide whether to show a
 *  masked hint. Without this correction, clearing such a key would silently
 *  do nothing: pendingChanges() treats an emptied field as a real change
 *  only `if (k.set)` ("clearing matters only if it was set"), and the
 *  backend's own `.set` says false until Yuri restarts, even though the
 *  Keychain plainly has a value to clear. */
function forSaveDecisions(keys: ManagedKey[], credentialNames: string[]): ManagedKey[] {
  return keys.map((k) =>
    k.secret && !k.set && credentialNames.includes(k.name) ? { ...k, set: true } : k);
}

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
  const [agents, setAgents] = useState<Agent[]>([]);
  const [keys, setKeys] = useState<ManagedKey[] | null>(null);
  const [where, setWhere] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  // The Keychain's own view of what is stored, independent of whether the
  // running backend has picked it up yet. A secret saved this session sits
  // in credentials.enc but does not reach the ALREADY-SPAWNED backend child
  // until Yuri restarts (a child's environment is fixed at spawn time), so
  // `keys` (from GET /yuri/config, which reads the backend's own os.environ)
  // can lag this by a full session -- this is what lets the field say so
  // instead of looking like the save silently failed.
  const [credentialNames, setCredentialNames] = useState<string[]>([]);
  // True when credentials.enc exists but could not be decrypted on this
  // machine right now -- distinct from "nothing was ever saved". Spike R1:
  // an unsigned app's Keychain access is gated on its own code identity, so
  // a rebuilt bundle can lose the ability to read a store an earlier build
  // wrote. Rendered as a standalone banner rather than folded into "not
  // set", because those are different facts and only one of them means
  // "your keys are gone, re-enter them".
  const [credentialsUnreadable, setCredentialsUnreadable] = useState(false);

  const load = useCallback(async (): Promise<DoctorCheck[] | null> => {
    try {
      const [d, c, cred] = await Promise.all([
        yget<{ checks: DoctorCheck[]; ok: boolean; agents?: Agent[] }>("doctor"),
        yget<{ keys: ManagedKey[]; path: string }>("config"),
        // undefined in a plain browser tab (no bridge) -- treated the same
        // as "nothing stored there", which is correct: there is nowhere else
        // for a browser tab's secrets to live.
        yuriCredentials()?.names() ?? Promise.resolve(undefined),
      ]);
      const fresh = d.checks || [];
      setChecks(fresh);
      setAgents(d.agents || []);
      setKeys(c.keys || []);
      setWhere(c.path || "");
      setCredentialNames(cred?.names || []);
      setCredentialsUnreadable(cred?.unreadable || false);
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
    const names = pendingChanges(forSaveDecisions(keys, credentialNames), draft);
    // Secrets go renderer -> IPC -> main -> safeStorage when the bridge
    // exists, and never over HTTP -- not even on loopback (spec §6.3). A
    // browser tab has no bridge, so every secret there still has to go
    // through PUT /yuri/config exactly as it always has -- this is a second
    // transport, not a replacement for the first.
    const bridge = yuriCredentials();
    const bySecret = new Map(keys.map((k) => [k.name, k.secret]));
    const secretNames = bridge ? names.filter((n) => bySecret.get(n)) : [];
    const httpNames = names.filter((n) => !secretNames.includes(n));

    setBusy(true);
    setSaveError("");
    setSaved("");
    try {
      const effects: Effect[] = [];
      const written: string[] = [];

      if (secretNames.length > 0 && bridge) {
        const secretValues: Record<string, string> = {};
        for (const n of secretNames) secretValues[n] = draft[n] ?? "";
        const res = await bridge.write(secretValues);
        if (!res.ok) throw new Error(res.error);
        written.push(...res.written);
        // Always "restart", regardless of what config.py's MANAGED_KEYS
        // declares for that key's effect: the already-spawned backend
        // child's environment is fixed at spawn time (desktop/main/
        // servers.ts), so a value written to the Keychain just now cannot
        // reach it until Yuri restarts, no matter how quickly os.getenv
        // would otherwise have picked up a file-based change.
        if (res.written.length > 0) effects.push("restart");
      }

      if (httpNames.length > 0) {
        const values: Record<string, string> = {};
        for (const n of httpNames) values[n] = draft[n] ?? "";
        const res = await yput<{ effects: Effect[] }>("config", { values });
        written.push(...httpNames);
        effects.push(...(res.effects || []));
      }

      setSaved(effectsSentence(effects));
      // Clear only the keys that were saved. Clearing the whole draft would
      // discard anything typed while the request was in flight -- the inputs
      // stay editable on purpose, so that window is real.
      setDraft((d) => {
        const rest = { ...d };
        for (const n of written) delete rest[n];
        return rest;
      });
      // Re-read rather than trusting the save: a key can be written and still
      // leave something else blocking. load() IS that re-read, and load()
      // itself now fires onPass when nothing is left blocking.
      await load();
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
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

      {agents.length > 0 ? (
        <div className="setup-agents">
          <h3 className="viewtitle">Coding agents</h3>
          {!anyAgentAvailable(agents) ? (
            <div className="mcp-blurb">
              None available. Yuri still works — voice, memory and settings are hers —
              but she cannot start a coding session until one is installed.
            </div>
          ) : null}
          <ul>
            {agents.map((a) => (
              <li key={a.name} data-state={agentVisual(a)}>
                <span className="agent-label">{a.label}</span>
                <span className="agent-detail">{agentLine(a)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mcp-head" style={{ marginTop: 22 }}>
        <h3 className="sectitle">Keys and models</h3>
      </div>
      <p className="mcp-blurb">
        Saved to <code>{where}</code>, readable only by you — the same file{" "}
        <code>yapcode config</code> edits. What you saved is shown here, except for
        secrets: a key never comes back to this screen, so its field starts empty and
        leaving it that way keeps the current one. In the desktop app, secrets are
        encrypted into the macOS Keychain instead of this file, and never leave your
        machine over the network to get there.
      </p>

      {credentialsUnreadable && (
        // Not "no keys set" -- a very different claim. Spike R1: an unsigned
        // app's Keychain access is gated on its own code identity, so a
        // rebuilt bundle can lose the ability to read a store an earlier
        // build wrote. Silence here would look exactly like a clean first
        // run, and the user would find out only when a voice call failed
        // for a reason this screen could have named.
        <div className="mcp-configerr">
          Your saved API keys could not be read from the Keychain on this machine
          (this can happen after the app is rebuilt). Re-enter them below.
        </div>
      )}

      <div className="setup-keys">
        {keys.map((k) => {
          // A value exported in the user's shell beats every file Setup can
          // write, so a save here works now and reverts at the next start.
          // Said BEFORE the save, on the field.
          const shadow = shellShadowWarning(k);
          // Stored in the Keychain this session, but the running backend
          // child was spawned before that write happened -- its environment
          // is fixed at spawn time (desktop/main/servers.ts), so `k.set`
          // (read from THAT process's os.environ) still says "not set" until
          // Yuri restarts. Without this, a save that plainly worked would
          // look, on this exact screen, like it silently failed.
          const pendingRestart = k.secret && !k.set && credentialNames.includes(k.name);
          return (
          <label className="tf-field" key={k.name}>
            <span className="tf-label">
              {k.label}
              {k.set && <span className="setup-hint"> · {k.hint} · from {k.source}</span>}
              {pendingRestart && <span className="setup-hint"> · saved · applies after restart</span>}
            </span>
            <input
              className="tf-input"
              type={k.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              placeholder={pendingRestart ? "saved — leave blank to keep it" : fieldPlaceholder(k)}
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
        <button className="txtoggle primary"
                disabled={busy || !canSave(forSaveDecisions(keys, credentialNames), draft)}
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
