from __future__ import annotations

from app import background_jobs as _background_jobs  # noqa: F401 - register SQLModel metadata
from app import models as _models  # noqa: F401 - register SQLModel metadata
from app.database import init_db
from app.note_archive import ensure_note_archive_column


def init_app_db() -> None:
    init_db()
    ensure_note_archive_column()
