"use client";

// `/agents/<id>` — editing one agent, on its own page.
import { useParams } from "next/navigation";
import { SpecialistEditor } from "@/components/SpecialistEditor";

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <SpecialistEditor id={id} />;
}
