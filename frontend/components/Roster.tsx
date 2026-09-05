"use client";

// Your agents: the roster. The Agents panel's first section — the coding
// engines move below it, relabelled as what they are.
//
// One panel, two sections, and no ninth rail icon: the user's word for a
// specialist is "agent", so shipping "Agents" beside "Specialists" would put
// two rail items with the same name on different things.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, ydelete, yget, ypost } from "@/lib/api";
import { type Specialist } from "@/lib/roster";
import { SpecialistCard } from "./SpecialistCard";
import { ViewError } from "./ViewError";

export function Roster() {
  const [rows, setRows] = useState<Specialist[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState("");
  const [saveError, setSaveError] = useState("");
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      // include_archived, or a retired builtin would vanish from the panel
      // and its "Bring back" button would be unreachable.
      const data = await yget<{ specialists: Specialist[] }>(
        "specialists?include_archived=true");
      setRows(data.specialists || []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const archive = async (s: Specialist) => {
    setBusy(s.id);
    try {
      await ydelete(`specialists/${s.id}`);
      await load();
    } catch (e) {
      // A 409 here is meaningful — a live step is holding it — so it goes
      // where the user is looking rather than into the console.
      setSaveError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const reset = async (s: Specialist) => {
    setBusy(s.id);
    setSaveError("");
    try {
      await ypost(`specialists/${s.id}/reset`);
      await load();
    } catch (e) {
      // A 409 here is meaningful (the default name is taken), so it goes
      // where the user is looking.
      setSaveError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="roster">
      <div className="mcp-head">
        <h3 className="sectitle">Your agents</h3>
        {rows && (
          <button className="txtoggle" onClick={() => router.push("/agents/new")}>
            Add an agent
          </button>
        )}
      </div>
      <p className="mcp-blurb">
        Specialists Yuri hands work to. Each one has a job, an engine that runs it, and its own
        instructions. Yuri can&rsquo;t create or change these by voice — a set of instructions
        nobody read is not something to hand tools to.
      </p>


      {saveError && <pre className="mcp-err">{saveError}</pre>}

      {loadError ? (
        <ViewError error={loadError} onRetry={() => void load()} />
      ) : rows === null ? (
        <div className="empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">No agents yet.</div>
      ) : (
        <div className="sp-list">
          {rows.map((s) => (
            <SpecialistCard
              key={s.id}
              s={s}
              busy={busy === s.id}
              // A ROUTE, not a form that unfolds at the top: clicking Edit
              // on a row scrolled far down used to open the form off-screen
              // above, so the click looked like it had done nothing.
              onEdit={() => router.push(`/agents/${s.id}`)}
              onArchive={() => void archive(s)}
              onReset={() => void reset(s)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
