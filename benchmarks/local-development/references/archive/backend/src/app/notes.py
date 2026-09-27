"""Synthetic benchmark notes; all data belongs to the disposable fixture."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field as InputField, field_validator
from sqlmodel import Field, Session, SQLModel, select

from app.database import get_session

router = APIRouter(prefix="/api/notes", tags=["notes"])


class Note(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    title: str
    archived: bool = Field(default=False)


class NoteInput(BaseModel):
    title: str = InputField(min_length=1, max_length=120)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A title is required")
        return value.strip()


class ArchiveInput(BaseModel):
    archived: bool


@router.get("")
def list_notes(include_archived: bool = False, session: Session = Depends(get_session)) -> list[Note]:
    statement = select(Note).order_by(Note.id)
    if not include_archived:
        statement = statement.where(Note.archived.is_(False))
    return list(session.exec(statement).all())


@router.post("", status_code=201)
def create_note(body: NoteInput, session: Session = Depends(get_session)) -> Note:
    note = Note(title=body.title)
    session.add(note)
    session.commit()
    session.refresh(note)
    return note


@router.put("/{note_id}")
def update_note(note_id: int, body: NoteInput, session: Session = Depends(get_session)) -> Note:
    note = session.get(Note, note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")
    note.title = body.title
    session.add(note)
    session.commit()
    session.refresh(note)
    return note


@router.delete("/{note_id}", status_code=204)
def delete_note(note_id: int, session: Session = Depends(get_session)) -> None:
    note = session.get(Note, note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")
    session.delete(note)
    session.commit()


@router.patch("/{note_id}/archive")
def archive_note(note_id: int, body: ArchiveInput, session: Session = Depends(get_session)) -> Note:
    note = session.get(Note, note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")
    note.archived = body.archived
    session.add(note)
    session.commit()
    session.refresh(note)
    return note
