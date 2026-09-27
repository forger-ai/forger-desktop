import importlib
import sqlite3
import sys

from fastapi.testclient import TestClient
from sqlmodel import SQLModel


def test_existing_note_migrates_and_archive_restore_preserve_content(tmp_path, monkeypatch):
    db_path = tmp_path / "archive.sqlite"
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE note (id INTEGER PRIMARY KEY, title VARCHAR NOT NULL)")
        connection.execute("INSERT INTO note VALUES (1001, 'Existing note')")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_path}")
    SQLModel.metadata.clear()
    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]
    app = importlib.import_module("app.main").app
    with TestClient(app) as client:
        existing = client.get("/api/notes").json()[0]
        assert existing == {"id": 1001, "title": "Existing note", "archived": False}
        archived = client.patch("/api/notes/1001/archive", json={"archived": True})
        assert archived.status_code == 200
        assert archived.json()["archived"] is True
        assert client.get("/api/notes").json() == []
        assert client.get("/api/notes?include_archived=true").json()[0]["title"] == "Existing note"
        assert client.patch("/api/notes/99999/archive", json={"archived": True}).status_code == 404
    with TestClient(app) as client:
        assert client.get("/api/notes?include_archived=true").json()[0]["archived"] is True
        restored = client.patch("/api/notes/1001/archive", json={"archived": False})
        assert restored.status_code == 200
        assert restored.json()["archived"] is False
        assert client.get("/api/notes").json()[0]["id"] == 1001
