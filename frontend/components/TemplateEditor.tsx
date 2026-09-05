"use client";

// The plan-shape editor, on its own route.
//
// JSON checked by the SAME validator the loader runs at startup (see
// lib/templates.ts for why there is only one), so a template that saves is
// one that will still load. Save stays enabled for a semantically bad body
// and the server's reason is shown — a disabled button is a label, the server
// is the lock.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ApiError, yget, yput } from "@/lib/api";
import { canSave, editableBody, parseBody, type TemplateSummary } from "@/lib/templates";
import { ViewError } from "./ViewError";

export function TemplateEditor({ name }: { name: string }) {
  const [text, setText] = useState("");
  const [original, setOriginal] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  // There is no GET /templates/<name>; the list carries every body, so the
  // editor reads the list and picks its one out. Cheap enough (six templates)
  // and it keeps a single shape of template data in the frontend.
  const load = useCallback(async () => {
    try {
      const data = await yget<{ templates: TemplateSummary[] }>("templates");
      const row = (data.templates || []).find((t) => t.name === name);
      if (!row) {
        setMissing(true);
        return;
      }
      const body = editableBody(row);
      setText(body);
      setOriginal(body);
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
    const parsed = parseBody(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await yput(`templates/${name}`, parsed.body);
      router.push("/missions/templates");
    } catch (e) {
      // The backend's own message: it names the cycle's members, the unknown
      // role, or the check that does not exist.
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const parsed = parseBody(text);

  return (
    <section className="tpl-edit">
      <Link href="/missions/templates" className="panel-back">← Plan shapes</Link>
      <h2 className="viewtitle">{missing ? "Plan shape" : `Edit ${name}`}</h2>

      {loadError ? (
        <ViewError error={loadError} onRetry={() => void load()} />
      ) : missing ? (
        <div className="empty">
          There is no plan shape called <code>{name}</code> — it may have been deleted.
        </div>
      ) : original === null ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          <p className="mcp-blurb">
            Missions started from this shape afterwards will follow it. The ones already
            running keep the plan they began with.
          </p>
          <textarea
            className="tpl-editor"
            value={text}
            spellCheck={false}
            rows={Math.min(34, text.split("\n").length + 2)}
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
            <button className="txtoggle" disabled={busy}
                    onClick={() => router.push("/missions/templates")}>
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}
