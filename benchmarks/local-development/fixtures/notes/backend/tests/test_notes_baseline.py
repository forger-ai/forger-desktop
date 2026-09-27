"""Immutable regression tests for the synthetic existing-app fixture."""
import importlib
import sys

from fastapi.testclient import TestClient
from sqlmodel import SQLModel


def test_notes_existing_read_and_health_contract(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path}/notes.sqlite")
    SQLModel.metadata.clear()
    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]
    module = importlib.import_module("app.main")
    with TestClient(module.app) as client:
        assert client.get("/api/health").json() == {"status": "ok", "database": "sqlite"}
        assert client.get("/api/notes").json() == []
        created = client.post("/api/notes", json={"title": "Alpha"})
        assert created.status_code == 201
        note_id = created.json()["id"]
        assert client.get("/api/notes").json()[0]["title"] == "Alpha"
        updated = client.put(f"/api/notes/{note_id}", json={"title": "Beta"})
        assert updated.status_code == 200
        assert updated.json()["id"] == note_id
        assert updated.json()["title"] == "Beta"
        assert client.put("/api/notes/99999", json={"title": "missing"}).status_code == 404
        assert client.delete("/api/notes/99999").status_code == 404
        assert client.post("/api/notes", json={"title": "   "}).status_code == 422
        assert client.post("/api/notes", json={"title": ""}).status_code == 422
        assert client.post("/api/notes", json={"title": "x" * 121}).status_code == 422
        assert client.delete(f"/api/notes/{note_id}").status_code == 204
        assert client.get("/api/notes").json() == []
