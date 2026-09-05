"use client";

// The plan-shape editor: a form, on its own route.
//
// Was a JSON textarea. Every field in a template except id/title/instruction
// draws from a closed vocabulary the server sends with the template, so the
// form turns each into a set of choices and whole classes of error stop being
// possible: an unknown role, a check that does not exist, a dependency on a
// step that isn't there.
//
// What the form does NOT check is unchanged and deliberate — cycles above
// all. Mirroring cycle detection here would mean two implementations of "what
// is a cycle", and the one that drifts is the one that lets a bad template
// through. So Save stays enabled for anything only the server can know, and
// the server's own reason is shown when it refuses.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ApiError, yget, yput } from "@/lib/api";
import {
  blankTask, canSaveForm, formError, moveTask, removeTask, renameTask, toBody, toForm,
  type FormTask, type TemplateForm, type TemplateSummary,
} from "@/lib/templates";
import { ViewError } from "./ViewError";

export function TemplateEditor({ name }: { name: string }) {
  const [tpl, setTpl] = useState<TemplateSummary | null>(null);
  const [form, setForm] = useState<TemplateForm | null>(null);
  const [original, setOriginal] = useState<TemplateForm | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  // There is no GET /templates/<name>; the list carries every body and the
  // vocabularies, so the editor reads the list and picks its one out.
  const load = useCallback(async () => {
    try {
      const data = await yget<{ templates: TemplateSummary[] }>("templates");
      const row = (data.templates || []).find((t) => t.name === name);
      if (!row) {
        setMissing(true);
        return;
      }
      setTpl(row);
      setForm(toForm(row));
      setOriginal(toForm(row));
      setMissing(false);
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    }
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError("");
    try {
      await yput(`templates/${name}`, toBody(form));
      router.push("/missions/templates");
    } catch (e) {
      // The backend's own message: it names the cycle's members, the unknown
      // role, or the check that does not exist.
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const back = <Link href="/missions/templates" className="panel-back">← Plan shapes</Link>;

  if (loadError) {
    return (
      <section className="tpl-edit">
        {back}
        <h2 className="viewtitle">Plan shape</h2>
        <ViewError error={loadError} onRetry={() => void load()} />
      </section>
    );
  }
  if (missing) {
    return (
      <section className="tpl-edit">
        {back}
        <h2 className="viewtitle">Plan shape</h2>
        <div className="empty">
          There is no plan shape called <code>{name}</code> — it may have been deleted.
        </div>
      </section>
    );
  }
  if (!tpl || !form || !original) {
    return (
      <section className="tpl-edit">
        {back}
        <h2 className="viewtitle">Plan shape</h2>
        <div className="empty">Loading…</div>
      </section>
    );
  }

  const problem = formError(form);
  const full = form.tasks.length >= tpl.max_tasks;
  const patch = (i: number, over: Partial<FormTask>) =>
    setForm({ ...form, tasks: form.tasks.map((t, n) => (n === i ? { ...t, ...over } : t)) });

  return (
    <section className="tpl-edit">
      {back}
      <h2 className="viewtitle">Edit {name}</h2>
      <p className="mcp-blurb">
        Missions started from this shape afterwards will follow it. The ones already
        running keep the plan they began with.
      </p>

      <label className="tf-field">
        <span className="tf-label">What this plan is for</span>
        <textarea
          className="tf-input" rows={2} value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </label>

      <div className="tf-steps">
        {form.tasks.map((t, i) => (
          <StepCard
            key={i}
            step={t}
            index={i}
            count={form.tasks.length}
            others={form.tasks.filter((_, n) => n !== i)}
            tpl={tpl}
            onPatch={(over) => patch(i, over)}
            onRename={(id) => setForm(renameTask(form, i, id))}
            onMove={(to) => setForm(moveTask(form, i, to))}
            onRemove={() => setForm(removeTask(form, i))}
          />
        ))}
      </div>

      <div className="mcp-actions">
        {/* A control that cannot work is not rendered (GUIDE.md §6), so the
            Add button goes away at the cap rather than failing on click. */}
        {full ? (
          <span className="tf-hint">
            This plan is at the limit of {tpl.max_tasks} steps.
          </span>
        ) : (
          <button className="txtoggle"
                  onClick={() => setForm({ ...form, tasks: [...form.tasks, blankTask(form)] })}>
            Add a step
          </button>
        )}
      </div>

      {problem && <em className="sp-err">{problem}</em>}
      {error && <pre className="mcp-err">{error}</pre>}

      <div className="mcp-actions tf-save">
        <button className="txtoggle primary" disabled={busy || !canSaveForm(form, original)}
                onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="txtoggle" disabled={busy}
                onClick={() => router.push("/missions/templates")}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function StepCard({
  step, index, count, others, tpl, onPatch, onRename, onMove, onRemove,
}: {
  step: FormTask;
  index: number;
  count: number;
  others: FormTask[];
  tpl: TemplateSummary;
  onPatch: (over: Partial<FormTask>) => void;
  onRename: (id: string) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  // An agent step is handed to a specialist, so it must name a role; the
  // other kinds are the workflow doing something itself.
  const needsRole = step.kind === "agent_task";

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

  return (
    <div className="tf-step">
      <div className="tf-step-top">
        <span className="tf-num">Step {index + 1}</span>
        <div className="tf-step-actions">
          {/* Order is how the plan READS; what runs when is decided below, by
              Runs after. So these are only offered where they can move. */}
          {index > 0 && (
            <button className="dash-btn" title="Move up" onClick={() => onMove(index - 1)}>↑</button>
          )}
          {index < count - 1 && (
            <button className="dash-btn" title="Move down" onClick={() => onMove(index + 1)}>↓</button>
          )}
          {count > 1 && (
            <button className="dash-btn danger" onClick={onRemove}>Remove</button>
          )}
        </div>
      </div>

      <div className="tf-row">
        <label className="tf-field tf-grow">
          <span className="tf-label">Title</span>
          <input className="tf-input" value={step.title}
                 onChange={(e) => onPatch({ title: e.target.value })} />
        </label>
        <label className="tf-field tf-narrow">
          <span className="tf-label">id</span>
          <input className="tf-input mono" value={step.id}
                 onChange={(e) => onRename(e.target.value)} />
        </label>
      </div>

      <label className="tf-field">
        <span className="tf-label">Instruction</span>
        <textarea className="tf-input" rows={3} value={step.instruction}
                  onChange={(e) => onPatch({ instruction: e.target.value })} />
      </label>

      <div className="tf-row">
        <label className="tf-field tf-narrow">
          <span className="tf-label">Kind of step</span>
          <select className="tf-input" value={step.kind}
                  onChange={(e) => onPatch({ kind: e.target.value })}>
            {tpl.kinds.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}
          </select>
        </label>
        {needsRole && (
          <label className="tf-field tf-narrow">
            <span className="tf-label">Handled by</span>
            <select className="tf-input" value={step.role}
                    onChange={(e) => onPatch({ role: e.target.value })}>
              <option value="">choose a role…</option>
              {tpl.roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        )}
        <label className="tf-check tf-selfend">
          <input type="checkbox" checked={step.read_only}
                 onChange={(e) => onPatch({ read_only: e.target.checked })} />
          <span>Changes nothing</span>
        </label>
      </div>

      {/* Only the steps that exist can be depended on, so a dangling
          dependency is not something you can express here. */}
      {others.length > 0 && (
        <Chooser label="Runs after" options={others.map((o) => ({ value: o.id, label: o.id }))}
                 chosen={step.depends_on}
                 onToggle={(v) => onPatch({ depends_on: toggle(step.depends_on, v) })}
                 empty="Starts as soon as the mission does." />
      )}

      <Chooser label="Must pass before it counts as done"
               options={tpl.verify_names.map((v) => ({ value: v, label: v.replace(/_/g, " ") }))}
               chosen={step.verification}
               onToggle={(v) => onPatch({ verification: toggle(step.verification, v) })}
               empty="Done when the agent says it is." />

      <Chooser label="Needs an agent that can"
               options={tpl.capabilities.map((c) => ({ value: c, label: c.replace(/_/g, " ") }))}
               chosen={step.requires}
               onToggle={(v) => onPatch({ requires: toggle(step.requires, v) })}
               empty="Any agent in the role will do." />
    </div>
  );
}

/** A row of toggles over a closed vocabulary, with a line saying what NOTHING
 *  chosen means — an empty row otherwise reads as a control that failed to
 *  load rather than a deliberate "no checks". */
function Chooser({
  label, options, chosen, onToggle, empty,
}: {
  label: string;
  options: { value: string; label: string }[];
  chosen: string[];
  onToggle: (value: string) => void;
  empty: string;
}) {
  return (
    <div className="tf-field">
      <span className="tf-label">{label}</span>
      <div className="tf-chips">
        {options.map((o) => (
          <button key={o.value} type="button"
                  className={`tf-chip ${chosen.includes(o.value) ? "on" : ""}`}
                  aria-pressed={chosen.includes(o.value)}
                  onClick={() => onToggle(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
      {chosen.length === 0 && <span className="tf-hint">{empty}</span>}
    </div>
  );
}
