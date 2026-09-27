import { useState } from "react";
import { Button } from "@/components/ui/button";

export function DashboardView() {
  const [count, setCount] = useState(0);
  return <section className="space-y-4 p-6">
    <h1 className="text-2xl font-semibold">My local desk</h1>
    <output aria-live="polite">{count}</output>
    <Button type="button" onClick={() => setCount((value) => value + 1)}>Add</Button>
  </section>;
}
