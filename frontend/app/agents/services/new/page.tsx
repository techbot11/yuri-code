"use client";

// `/agents/services/new` — a static segment, so it never collides with a
// server name.
import { McpAddPage } from "@/components/McpAddPage";

export default function Page() {
  return <McpAddPage />;
}
