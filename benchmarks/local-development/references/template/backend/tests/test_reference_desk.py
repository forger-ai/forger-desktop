import importlib
import sys

from fastapi.testclient import TestClient
from sqlmodel import SQLModel


def test_desk_contract_and_existing_health(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path}/desk.sqlite")
    SQLModel.metadata.clear()
    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]
    app = importlib.import_module("app.main").app
    with TestClient(app) as client:
        assert client.get("/api/desk").json() == {"name": "My local desk", "storage": "local"}
        assert client.get("/api/health").status_code == 200
