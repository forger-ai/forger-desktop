import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Note = { id: number; title: string };
const api = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

export function DashboardView() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [title, setTitle] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const refresh = async () => {
    const response = await fetch(`${api}/api/notes`);
    if (!response.ok) throw new Error("Could not load notes");
    setNotes(await response.json() as Note[]);
  };
  useEffect(() => { void refresh().catch((cause: Error) => setError(cause.message)); }, []);

  const save = async () => {
    setError("");
    const response = await fetch(`${api}/api/notes${editingId === null ? "" : `/${editingId}`}`, {
      method: editingId === null ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) { setError("Could not save note"); return; }
    setTitle(""); setEditingId(null);
    await refresh();
  };
  const remove = async (id: number) => {
    const response = await fetch(`${api}/api/notes/${id}`, { method: "DELETE" });
    if (!response.ok) { setError("Could not delete note"); return; }
    await refresh();
  };

  return <section className="space-y-4 p-6">
    <h1 className="text-2xl font-semibold">Local notes</h1>
    <form onSubmit={(event) => { event.preventDefault(); void save().catch((cause: Error) => setError(cause.message)); }}>
      <label htmlFor="note-title">Note title</label>
      <Input id="note-title" value={title} onChange={(event) => setTitle(event.target.value)} />
      <Button type="submit">Save</Button>
    </form>
    {error && <p role="alert">{error}</p>}
    <ul>{notes.map((note) => <li key={note.id} className="flex items-center gap-3">
      <span>{note.title}</span>
      <Button type="button" onClick={() => { setEditingId(note.id); setTitle(note.title); }}>Edit</Button>
      <Button type="button" onClick={() => { void remove(note.id).catch((cause: Error) => setError(cause.message)); }}>Delete</Button>
    </li>)}</ul>
  </section>;
}
