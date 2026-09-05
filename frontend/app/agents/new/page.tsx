"use client";

// `/agents/new`. A static segment, so Next resolves it before `[id]`.
import { SpecialistEditor } from "@/components/SpecialistEditor";

export default function Page() {
  return <SpecialistEditor />;
}
