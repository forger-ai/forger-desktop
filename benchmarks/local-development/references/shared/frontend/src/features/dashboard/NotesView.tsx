import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Note = { id: number; title: string; archived?: boolean };
const api = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

export function NotesView({ showSearch = false, showArchive = false }: { showSearch?: boolean; showArchive?: boolean }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [title, setTitle] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [error, setError] = useState("");
  const reportError = (cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not update notes");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (showSearch) query.set("q", search);
    if (showArchive) query.set("include_archived", String(includeArchived));
    const response = await fetch(`${api}/api/notes?${query}`, { signal });
    if (!response.ok) throw new Error("Could not load notes");
    setNotes(await response.json() as Note[]);
  }, [search, includeArchived, showSearch, showArchive]);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((cause: unknown) => { if (!controller.signal.aborted) reportError(cause); });
    return () => controller.abort();
  }, [refresh]);

  const save = async () => {
    setError("");
    const response = await fetch(`${api}/api/notes${editingId === null ? "" : `/${editingId}`}`, {
      method: editingId === null ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) throw new Error("Could not save note");
    setTitle(""); setEditingId(null);
    await refresh();
  };
  const remove = async (id: number) => {
    const response = await fetch(`${api}/api/notes/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Could not delete note");
    await refresh();
  };
  const archive = async (note: Note) => {
    const response = await fetch(`${api}/api/notes/${note.id}/archive`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived: !note.archived }),
    });
    if (!response.ok) throw new Error("Could not update archive status");
    await refresh();
  };

  return <section className="space-y-4 p-6">
    <h1 className="text-2xl font-semibold">Local notes</h1>
    <form onSubmit={(event) => { event.preventDefault(); void save().catch(reportError); }}>
      <label htmlFor="note-title">Note title</label>
      <Input id="note-title" value={title} onChange={(event) => setTitle(event.target.value)} />
      <Button type="submit">Save</Button>
    </form>
    {showSearch && <div>
      <label htmlFor="note-search">Search</label>
      <Input id="note-search" value={search} onChange={(event) => setSearch(event.target.value)} />
    </div>}
    {showArchive && <label>
      <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />
      Show archived
    </label>}
    {error && <p role="alert">{error}</p>}
    <ul>{notes.map((note) => <li key={note.id} className="flex items-center gap-3">
      <span>{note.title}</span>
      <Button type="button" onClick={() => { setEditingId(note.id); setTitle(note.title); }}>Edit</Button>
      <Button type="button" onClick={() => { void remove(note.id).catch(reportError); }}>Delete</Button>
      {showArchive && <Button type="button" onClick={() => { void archive(note).catch(reportError); }}>{note.archived ? "Restore" : "Archive"}</Button>}
    </li>)}</ul>
  </section>;
}
