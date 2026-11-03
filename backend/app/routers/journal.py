from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import JournalEntry, MoodCheckin, User
from ..schemas import JournalEntryCreate, JournalEntryRead, JournalEntryUpdate
from ..security import get_current_user

router = APIRouter(tags=["Journal"])


def checkin_owned(db: Session, user_id: str, checkin_id: str | None) -> None:
    if checkin_id and db.scalar(select(MoodCheckin.id).where(MoodCheckin.id == checkin_id, MoodCheckin.user_id == user_id)) is None:
        raise HTTPException(404, {"code": "checkin_not_found", "message": "Linked mood check-in was not found."})


def own_entry(db: Session, user_id: str, entry_id: str) -> JournalEntry:
    entry = db.scalar(select(JournalEntry).where(JournalEntry.id == entry_id, JournalEntry.user_id == user_id))
    if entry is None:
        raise HTTPException(404, {"code": "journal_entry_not_found", "message": "Journal entry was not found."})
    return entry


@router.post("/journal-entries", response_model=JournalEntryRead, status_code=201)
def create_entry(payload: JournalEntryCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    checkin_owned(db, user.id, payload.checkin_id)
    entry = JournalEntry(user_id=user.id, **payload.model_dump())
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@router.get("/journal-entries", response_model=list[JournalEntryRead])
def list_entries(q: str | None = Query(default=None, max_length=100), start: datetime | None = None, end: datetime | None = None, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    query = select(JournalEntry).where(JournalEntry.user_id == user.id)
    if q:
        # Search remains scoped to the authenticated owner's rows.
        pattern = f"%{q.strip()}%"
        query = query.where(JournalEntry.title.ilike(pattern) | JournalEntry.body.ilike(pattern))
    if start:
        query = query.where(JournalEntry.entry_date >= start)
    if end:
        query = query.where(JournalEntry.entry_date <= end)
    return list(db.scalars(query.order_by(JournalEntry.entry_date.desc()).offset(offset).limit(limit)))


@router.get("/journal-entries/{entry_id}", response_model=JournalEntryRead)
def get_entry(entry_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return own_entry(db, user.id, entry_id)


@router.patch("/journal-entries/{entry_id}", response_model=JournalEntryRead)
def update_entry(entry_id: str, payload: JournalEntryUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    entry = own_entry(db, user.id, entry_id)
    changes = payload.model_dump(exclude_unset=True)
    if "checkin_id" in changes:
        checkin_owned(db, user.id, changes["checkin_id"])
    for key, value in changes.items():
        setattr(entry, key, value)
    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/journal-entries/{entry_id}", status_code=204)
def delete_entry(entry_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    entry = own_entry(db, user.id, entry_id)
    db.delete(entry)
    db.commit()
