"use client";

// The Plan shapes tab. The list lives in a component because the editor route
// beside it needs the same template helpers, and a page that is one component
// is easier to leave alone than one that grows a second job.
import { Templates } from "@/components/Templates";

export default function Page() {
  return <Templates />;
}
