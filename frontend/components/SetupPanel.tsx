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
import { useYuri } from "@/components/VoiceProvider";
import { restartImpact, restartRanNote } from "@/lib/restart";
import {
  blocking, canSave, DISCARD_UNREADABLE_CONFIRM, DISCARD_UNREADABLE_LABEL,
  effectsSentence, fieldPlaceholder, fieldValue, fixAction,
  pendingChanges, secretSaveBlockedReason, shellShadowWarning,
  UNREADABLE_STORE_BANNER,
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
  /** Delete a store this build cannot decrypt, so a save can proceed. The one
   *  way past desktop/main/credentials.ts's refusal to write over an
   *  unreadable store -- see the banner below. Optional: an older shell
   *  exposes no such channel, and the UI must not offer a button that would
   *  reject. */
  discardUnreadable?: () =>
    Promise<{ ok: true; discarded: boolean } | { ok: false; error: string }>;
};

/** Same pattern as SetupGate's yuriBoot() / VoiceProvider's yuriTray read: a
 *  plain cast, guarded, so a browser tab with no bridge is a no-op rather
 *  than a crash. */
function yuriCredentials(): YuriCredentialsBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { yuriCredentials?: YuriCredentialsBridge }).yuriCredentials;
}

// The restart the browser version could never offer (desktop/main/index.ts's
// backend:restart, desktop/preload/index.ts's yuriBoot.restartBackend): the
// desktop app owns both children, so it can drain and respawn them cleanly.
// Absent in a plain browser tab -- there is nothing there to drain -- so
// every call site guards it exactly like yuriCredentials() above, and
// GUIDE.md's "a control that cannot work is not rendered" is why the button
// itself is gated on this rather than merely disabled.
type YuriBootBridge = {
  /** `ran` says whether a cycle actually happened: runBootCycle() declines to
   *  overlap two of them, and a declined request is neither an error nor a
   *  restart. Optional so an older shell that answers `{ok: true}` alone reads
   *  as "unknown" rather than as "declined" (lib/restart.ts's
   *  restartRanNote). */
  restartBackend: () =>
    Promise<{ ok: true; ran?: boolean } | { ok: false; error: string }>;
};

function yuriBoot(): YuriBootBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { yuriBoot?: YuriBootBridge }).yuriBoot;
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
  // Whether the desktop credential bridge is there, which decides which
  // TRANSPORT a secret's save takes -- and so whether the shell-shadow
  // warning below is true (lib/setup.ts's saveTransport). Read after mount,
  // not during render: window.yuriCredentials does not exist on the server,
  // and a field whose warning differed between the two would
  // hydration-mismatch.
  const [hasCredentialBridge, setHasCredentialBridge] = useState(false);
  // The two-step discard of a store this build cannot decrypt. Armed by the
  // first click, performed by the second: it deletes keys for good, and a
  // single click on a button sitting inside a red banner is too easy to make
  // by accident.
  const [discardArmed, setDiscardArmed] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState("");
  // In flight while runBootCycle(true) drains and respawns both children --
  // several seconds during which the backend is unreachable. Disabling the
  // button on this (rather than trusting one click to be the only one) is
  // what stops a second click starting a second cycle that runBootCycle's
  // own `booting` guard would otherwise just silently swallow.
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState("");
  // What to say when the shell ACCEPTED the request and then declined to act
  // on it -- runBootCycle()'s `booting` guard swallowing an overlapping cycle.
  // Not an error (nothing broke) and not a success (nothing restarted), and
  // it used to be reported as the latter.
  const [restartNote, setRestartNote] = useState("");

  // Same source the tray uses (VoiceProvider -> lib/trayState.ts), so this
  // screen and the tray can never disagree about what "running" means.
  const { missions, sessions } = useYuri();

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

  useEffect(() => { setHasCredentialBridge(yuriCredentials() !== undefined); }, []);

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

    // Said BEFORE the write, and it names the control that unblocks it.
    // writeCredentials() refuses to merge into a store it cannot decrypt --
    // rightly, since that would silently discard whatever the store held --
    // and this screen used to walk the user straight into that refusal and
    // then show its raw message, whose real remedy (delete credentials.enc
    // from Application Support) was named nowhere in the UI. Now the remedy
    // is the button on the banner above, and this sentence points at it. The
    // main process's refusal stays exactly as it was: this is the earlier,
    // kinder guard, not a replacement for it.
    const blockedReason = secretSaveBlockedReason(credentialsUnreadable, secretNames);
    if (blockedReason) {
      setSaveError(blockedReason);
      setSaved("");
      return;
    }

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

  /** Throw away a Keychain store this build cannot decrypt.
   *
   *  The way out of the dead end: the main process refuses to write over an
   *  unreadable store, so without this the user's only remedy was to find
   *  credentials.enc in Application Support and delete it by hand -- named
   *  nowhere on this screen. Deliberately its own action rather than a flag on
   *  the save, and armed by a first click before a second one performs it, so
   *  discarding keys can never be a side effect of saving one.
   *
   *  The main process decides WHETHER: it refuses a readable store, and
   *  refuses one that is merely unreadable-this-run because the Keychain is
   *  unavailable (a locked login keychain comes back; deleting then would lose
   *  recoverable keys). Both refusals arrive here as `error` and are shown. */
  const doDiscardUnreadable = async () => {
    const discard = yuriCredentials()?.discardUnreadable;
    if (!discard || !credentialsUnreadable) return;
    setDiscarding(true);
    setDiscardError("");
    try {
      const res = await discard();
      if (!res.ok) throw new Error(res.error);
      setDiscardArmed(false);
      // Clear the save error too: if it was the blocked-secret sentence, the
      // thing it complained about no longer exists, and leaving it up would
      // send the user looking for a button that is gone.
      setSaveError("");
      // Re-read rather than assuming: load() asks the bridge again, which is
      // what turns the banner off -- and it is the same re-read save() does,
      // for the same reason.
      await load();
    } catch (e) {
      setDiscardError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscarding(false);
    }
  };

  // The offer restartImpact()'s refusal protects: only reachable at all when
  // the bridge exists (the button below is not rendered otherwise), and
  // restartImpact.safe is re-checked here too, not just in the disabled
  // attribute -- a stale click queued just as a mission started must not
  // slip through.
  const doRestart = async () => {
    const bridge = yuriBoot();
    const impact = restartImpact(
      missions.filter((m) => m.status === "running").length, sessions.length);
    if (!bridge || !impact.safe) return;
    setRestarting(true);
    setRestartError("");
    setRestartNote("");
    try {
      const res = await bridge.restartBackend();
      if (!res.ok) throw new Error(res.error);
      // `ok` alone does not mean a restart happened: runBootCycle() returns
      // ran:false when its `booting` guard declined an overlapping cycle,
      // which drains nothing and respawns nothing. Reported as its own fact,
      // because the alternative (what this used to do) is a screen that says
      // a restart succeeded when the shell never started one -- and since
      // nothing navigated, the user is still sitting here reading it.
      setRestartNote(restartRanNote(res.ran));
      // A successful restart navigates this very window to the fresh
      // frontend it just spawned (desktop/main/index.ts's boot()), which
      // tears down this whole page -- so nothing below normally runs. It
      // still matters for the one path where the promise resolves without
      // that happening: the drain-and-respawn threw before ever reaching
      // loadURL, in which case this same page is still showing and re-reading
      // its own state (rather than leaving it stale) is the honest move,
      // exactly as save() does after writing a key.
      await load();
    } catch (e) {
      setRestartError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestarting(false);
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

  // Desktop-only, and only when there is something a restart would actually
  // fix: a key whose declared effect (config.py's MANAGED_KEYS) IS "restart",
  // or a secret saved to the Keychain this session that the running backend
  // has not picked up yet (the same `pendingRestart` fact each field already
  // shows below). Neither on its own would be enough forever -- MANAGED_KEYS
  // has no "restart" key today, but a secret saved through the bridge always
  // needs one (see save() above), so this is the real, live trigger.
  const needsRestart = keys.some((k) =>
    (k.set && k.effect === "restart")
    || (k.secret && !k.set && credentialNames.includes(k.name)));
  // Live sessions: `sessions` (useYuri(), from list_sessions) already holds
  // only agent processes that are actually up -- unlike missions, which stay
  // in the list long after they finish, so there is no status to filter on
  // here the way missionsRunning filters on "running".
  const runningMissions = missions.filter((m) => m.status === "running").length;
  const liveSessions = sessions.length;
  const impact = restartImpact(runningMissions, liveSessions);
  const bootBridge = yuriBoot();
  // The discard control is rendered only where it can actually run. Read
  // during render like bootBridge above (and gated on credentialsUnreadable,
  // which is false until the bridge has answered, so this can never render on
  // the server).
  const discardBridge = yuriCredentials()?.discardUnreadable;

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
        //
        // The text used to end "Re-enter them below" -- the one thing
        // main/credentials.ts refuses, since a merge from an unreadable store
        // would silently discard whatever it held. It now says what will
        // actually happen (lib/setup.ts's UNREADABLE_STORE_BANNER, where a
        // test can read it) and carries the action that makes the save
        // possible.
        <div className="mcp-configerr">
          {UNREADABLE_STORE_BANNER}
          {discardBridge ? (
            <div className="mcp-actions" style={{ marginTop: 10 }}>
              <button className="txtoggle"
                      disabled={discarding}
                      onClick={() => {
                        if (!discardArmed) { setDiscardArmed(true); return; }
                        void doDiscardUnreadable();
                      }}>
                {discarding ? "Discarding…"
                  : discardArmed ? DISCARD_UNREADABLE_CONFIRM : DISCARD_UNREADABLE_LABEL}
              </button>
              {discardArmed && !discarding && (
                <button className="txtoggle" onClick={() => setDiscardArmed(false)}>
                  Keep them
                </button>
              )}
            </div>
          ) : (
            // No bridge for it (an older shell, or a plain browser tab that
            // could not have an unreadable store in the first place): say
            // where the file is rather than offering a button that cannot
            // work. This is the remedy that used to be nowhere.
            <div style={{ marginTop: 8 }}>
              Delete <code>credentials.enc</code> from Yuri OS&rsquo;s Application Support
              folder, then start her again.
            </div>
          )}
          {discardError && <pre className="mcp-err">{discardError}</pre>}
        </div>
      )}

      <div className="setup-keys">
        {keys.map((k) => {
          // A value exported in the user's shell beats every file Setup can
          // write, so a save here works now and reverts at the next start.
          // Said BEFORE the save, on the field.
          // Passed the transport, because the warning is only true for one of
          // them: a secret the Keychain will carry neither takes effect
          // straight away nor loses to the shell export at the next start
          // (servers.ts merges credentialsEnv() last, deliberately), so
          // saying so would send the user to unset a variable their other
          // tools may need for a problem that does not exist. See
          // lib/setup.ts's shellShadowWarning.
          const shadow = shellShadowWarning(k, hasCredentialBridge);
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

      {needsRestart && bootBridge ? (
        // Rendered only in Electron (bootBridge is undefined in a plain
        // browser tab, which can never drain and respawn a child it doesn't
        // own -- GUIDE.md's "a control that cannot work is not rendered").
        // Spec §6.4: refuse while a mission is running, or say what it will
        // interrupt -- the disabled attribute plus the warning right beside
        // it IS that refusal, not merely a dead button with no reason given.
        <div className="setup-restart">
          <div className="mcp-blurb">{impact.warning || "Nothing is running."}</div>
          {restartError && <pre className="mcp-err">{restartError}</pre>}
          {/* A request the shell declined to act on: not an error, and not a
              restart either. Said out loud, because nothing navigated and
              this page is still the one the user is looking at. */}
          {restartNote && <em className="setup-saved">{restartNote}</em>}
          <button className="txtoggle primary"
                  disabled={restarting || !impact.safe}
                  onClick={() => void doRestart()}>
            {restarting ? "Restarting…" : "Restart Yuri's backend"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
