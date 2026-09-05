"use client";

// The plan-shape editor, addressed by template name. A route rather than a
// box that unfolds inside the list: clicking Edit should visibly go
// somewhere.
import { use } from "react";
import { TemplateEditor } from "@/components/TemplateEditor";

export default function Page({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  return <TemplateEditor name={decodeURIComponent(name)} />;
}
