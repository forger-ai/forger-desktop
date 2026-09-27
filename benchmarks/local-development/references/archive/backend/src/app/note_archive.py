from sqlalchemy import inspect

from app.database import engine


def ensure_note_archive_column() -> None:
    """Extend existing SQLite notes without replacing or clearing the table."""
    if not any(column["name"] == "archived" for column in inspect(engine).get_columns("note")):
        with engine.begin() as connection:
            connection.exec_driver_sql("ALTER TABLE note ADD COLUMN archived BOOLEAN NOT NULL DEFAULT 0")
