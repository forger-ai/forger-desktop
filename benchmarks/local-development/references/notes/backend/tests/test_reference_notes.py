import importlib
import sys

from fastapi.testclient import TestClient
from sqlmodel import SQLModel


def test_note_titles_are_normalized_and_invalid_writes_preserve_data(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path}/notes.sqlite")
    SQLModel.metadata.clear()
    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]
    app = importlib.import_module("app.main").app
    with TestClient(app) as client:
        created = client.post("/api/notes", json={"title": "  Alpha  "})
        assert created.status_code == 201
        assert created.json()["title"] == "Alpha"
        note_id = created.json()["id"]
        updated = client.put(f"/api/notes/{note_id}", json={"title": "  Beta  "})
        assert updated.status_code == 200
        assert updated.json()["title"] == "Beta"
        assert updated.json()["id"] == note_id
        assert client.put(f"/api/notes/{note_id}", json={"title": "   "}).status_code == 422
        assert client.post("/api/notes", json={"title": "x" * 121}).status_code == 422
        assert client.get("/api/notes").json()[0]["title"] == "Beta"
