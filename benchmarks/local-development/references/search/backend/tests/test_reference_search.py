import importlib
import sys

from fastapi.testclient import TestClient
from sqlmodel import SQLModel


def test_case_insensitive_literal_substring_search(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path}/search.sqlite")
    SQLModel.metadata.clear()
    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]
    app = importlib.import_module("app.main").app
    with TestClient(app) as client:
        for title in ["Alpha", "Beta", "100% literal", "with_underscore"]:
            assert client.post("/api/notes", json={"title": title}).status_code == 201
        assert [note["title"] for note in client.get("/api/notes?q=aLpHa").json()] == ["Alpha"]
        assert len(client.get("/api/notes?q=").json()) == 4
        assert client.get("/api/notes?q=absent").json() == []
        assert [note["title"] for note in client.get("/api/notes", params={"q": "%"}).json()] == ["100% literal"]
        assert [note["title"] for note in client.get("/api/notes", params={"q": "_"}).json()] == ["with_underscore"]
