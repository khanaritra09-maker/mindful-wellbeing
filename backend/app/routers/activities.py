from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User, WellnessActivityRecord
from ..schemas import ACTIVITY_TITLES, ActivityRecordCreate, ActivityRecordRead
from ..security import get_current_user

router = APIRouter(tags=["Wellness activities"])


@router.post("/wellness-activities", response_model=ActivityRecordRead, status_code=201)
def save_activity(payload: ActivityRecordCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = WellnessActivityRecord(user_id=user.id, activity_key=payload.activity_key, title=ACTIVITY_TITLES[payload.activity_key], completed_at=payload.completed_at or datetime.now(timezone.utc))
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.get("/wellness-activities", response_model=list[ActivityRecordRead])
def list_activities(start: datetime | None = None, end: datetime | None = None, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    query = select(WellnessActivityRecord).where(WellnessActivityRecord.user_id == user.id)
    if start:
        query = query.where(WellnessActivityRecord.completed_at >= start)
    if end:
        query = query.where(WellnessActivityRecord.completed_at <= end)
    return list(db.scalars(query.order_by(WellnessActivityRecord.completed_at.desc()).offset(offset).limit(limit)))
