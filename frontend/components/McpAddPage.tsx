"use client";

// Adding an MCP server, as its own ROUTE.
//
// It used to unfold at the top of the services list. Same problem the agent
// editor had: the form appears somewhere the click was not, and here it is
// worse — this form has a Test step, so it is the longest-lived form in the
// app and the one you least want to lose to a stray click.
//
// The rule this exists for is unchanged: a server cannot be SAVED until it
// has answered. The backend re-tests on save too, because a disabled button
// is a label and the server is the lock.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ApiError, yget, ypost } from "@/lib/api";
import {
  EMPTY_FORM, TIER_CHOICES, canSave, canTest, fingerprint, formProblem,
  requestBody, verdictSummary,
  type ServerForm, type ServerRow, type Tier, type TestResult,
} from "@/lib/mcp";

export function McpAddPage() {
  const router = useRouter();
  const [existing, setExisting] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const data = await yget<{ servers: ServerRow[] }>("mcp");
      setExisting((data.servers || []).map((s) => s.name));
    } catch {
      // A listing we could not fetch only costs the duplicate-name check,
      // which the backend enforces anyway with a 409. Better to let someone
      // add a server than to block the form on a failed GET.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="agents-view">
      <Link href="/agents/services" className="panel-back">← MCP Connector</Link>
      <h2 className="viewtitle">Add a service</h2>
      <AddForm
        existing={existing}
        onCancel={() => router.push("/agents/services")}
        onSaved={async () => router.push("/agents/services")}
      />
    </div>
  );
}

function AddForm({ existing, onCancel, onSaved }: {
  existing: string[]; onCancel: () => void; onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<ServerForm>(EMPTY_FORM);
  const [result, setResult] = useState<TestResult | null>(null);
  // Which form the result belongs to. Editing the command after a green test
  // has to retract it, or the user saves something that was never checked.
  const [tested, setTested] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const set = <K extends keyof ServerForm>(key: K, value: ServerForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setSaveError("");
  };

  const problem = formProblem(form, existing);
  const summary = result ? verdictSummary(result) : null;
  const stale = result !== null && tested !== null && fingerprint(form) !== tested;

  const test = async () => {
    setTesting(true);
    setSaveError("");
    try {
      const r = await ypost<TestResult>("mcp/test", requestBody(form));
      setResult(r);
      setTested(fingerprint(form));
    } catch (e) {
      setResult({ verdict: "failed", error: e instanceof Error ? e.message : String(e) });
      setTested(fingerprint(form));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await ypost("mcp", requestBody(form));
      await onSaved();
    } catch (e) {
      // The backend re-tests on save, so this can carry a server's own stderr.
      setSaveError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mcp-form">
      <label className="mcp-field">
        <span>Name</span>
        <input value={form.name} onChange={(e) => set("name", e.target.value)}
          placeholder="weather" spellCheck={false} />
      </label>

      <label className="mcp-field">
        <span>Command that starts it</span>
        <input value={form.command} onChange={(e) => set("command", e.target.value)}
          placeholder="uvx" spellCheck={false} />
      </label>

      <label className="mcp-field">
        <span>Arguments</span>
        <input value={form.args} onChange={(e) => set("args", e.target.value)}
          placeholder="mcp-server-weather" spellCheck={false} />
      </label>

      <label className="mcp-field">
        <span>Settings it needs (one KEY=value per line)</span>
        <textarea value={form.env} onChange={(e) => set("env", e.target.value)}
          rows={3} placeholder="WEATHER_API_KEY=…" spellCheck={false} />
      </label>

      {/* Required, with no default: this is a choice about what Yuri may do
          without asking, and a default here would be us making it. */}
      <div className="mcp-field">
        <span>How should Yuri use it?</span>
        <div className="mcp-tiers">
          {TIER_CHOICES.map((c) => (
            <button
              key={c.value}
              className={`mcp-tier ${form.tier === c.value ? "on" : ""}`}
              onClick={() => set("tier", c.value as Tier)}
            >
              <strong>{c.label}</strong>
              <em>{c.detail}</em>
            </button>
          ))}
        </div>
      </div>

      {problem && <div className="mcp-note">{problem}</div>}

      {summary && !stale && (
        <div className={`mcp-verdict ${summary.tone}`}>
          <pre>{summary.text}</pre>
          {result?.tools?.length ? (
            <div className="mcp-tools">{result.tools.map((t) => t.name).join(" · ")}</div>
          ) : null}
        </div>
      )}
      {stale && <div className="mcp-note">You changed something — test it again before saving.</div>}
      {saveError && <pre className="mcp-err">{saveError}</pre>}

      <div className="mcp-actions">
        <button className="txtoggle primary" disabled={!canTest(form, existing) || testing}
          onClick={() => void test()}>
          {testing ? "Testing…" : "Test it"}
        </button>
        {/* Absent, not disabled: an untested service cannot be saved at all. */}
        {canSave(form, existing, result, tested) && (
          <button className="txtoggle primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        )}
        <button className="txtoggle" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
