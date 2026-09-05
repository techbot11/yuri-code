"use client";

// Creating or editing an agent, as its own ROUTE rather than a form that
// unfolds at the top of the list.
//
// It used to be inline: clicking Edit on a row scrolled far down opened the
// form off-screen above, so the click looked like it had done nothing. A
// route makes the change of place obvious, gives the form the whole panel,
// and means Back/refresh/deep-link all work — the same reason the shell uses
// real routes for panels instead of a `currentView` state.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ApiError, yget, ypost, yput } from "@/lib/api";
import {
  EMPTY_SPECIALIST, formFrom, specialistBody,
  type Specialist, type SpecialistForm as Form,
} from "@/lib/roster";
import { SpecialistForm } from "./SpecialistForm";
import { ViewError } from "./ViewError";

export function SpecialistEditor({ id }: { id?: string }) {
  const router = useRouter();
  const editing = Boolean(id);
  const [form, setForm] = useState<Form | null>(editing ? null : EMPTY_SPECIALIST);
  const [subject, setSubject] = useState<Specialist | null>(null);
  const [others, setOthers] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await yget<{ specialists: Specialist[] }>(
        "specialists?include_archived=true");
      const all = data.specialists || [];
      // Every name EXCEPT this one's, or renaming nothing would collide with
      // itself.
      setOthers(all.filter((s) => s.id !== id).map((s) => s.name));
      if (!editing) return;
      const found = all.find((s) => s.id === id);
      if (!found) {
        setLoadError(new ApiError(404, "That agent doesn't exist any more."));
        return;
      }
      setSubject(found);
      setForm(formFrom(found));
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    }
  }, [id, editing]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError("");
    try {
      if (id) await yput(`specialists/${id}`, specialistBody(form));
      else await ypost("specialists", specialistBody(form));
      router.push("/agents");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="agents-view">
      <Link href="/agents" className="panel-back">← Agents</Link>
      <h2 className="viewtitle">
        {editing ? `Edit ${subject?.name || "agent"}` : "New agent"}
      </h2>

      {loadError ? (
        <ViewError error={loadError} onRetry={() => void load()} />
      ) : form === null ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          {/* A builtin is editable, and saying so here stops "Reset to
              default" on the list reading like the only thing you can do. */}
          {subject?.builtin && (
            <p className="mcp-blurb">
              This one ships with Yuri. Change anything you like — the list has a
              &ldquo;Reset to default&rdquo; that puts it back.
            </p>
          )}
          <SpecialistForm
            form={form}
            setForm={setForm}
            existingNames={others}
            editing={editing}
            busy={busy}
            error={error}
            onSave={() => void save()}
            onCancel={() => router.push("/agents")}
          />
        </>
      )}
    </div>
  );
}
