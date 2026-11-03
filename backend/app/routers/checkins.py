from datetime import datetime, timezone
from io import BytesIO

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import MoodCheckin, User
from ..schemas import MoodCheckinCreate, MoodCheckinRead, MoodCheckinUpdate
from ..security import get_current_user

router = APIRouter(tags=["Mood check-ins"])


def owned_checkin(db: Session, user_id: str, checkin_id: str) -> MoodCheckin:
    item = db.scalar(select(MoodCheckin).where(MoodCheckin.id == checkin_id, MoodCheckin.user_id == user_id))
    if item is None:
        raise HTTPException(404, {"code": "checkin_not_found", "message": "Mood check-in was not found."})
    return item


@router.post("/check-ins", response_model=MoodCheckinRead, status_code=201)
def create_checkin(payload: MoodCheckinCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    created_at = payload.created_at or datetime.now(timezone.utc)
    item = MoodCheckin(user_id=user.id, mood=payload.mood, intensity=payload.intensity, reflection=payload.reflection.strip(), created_at=created_at)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.get("/check-ins", response_model=list[MoodCheckinRead])
@router.get("/mood-history", response_model=list[MoodCheckinRead])
def list_checkins(start: datetime | None = None, end: datetime | None = None, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    query = select(MoodCheckin).where(MoodCheckin.user_id == user.id)
    if start:
        query = query.where(MoodCheckin.created_at >= start)
    if end:
        query = query.where(MoodCheckin.created_at <= end)
    return list(db.scalars(query.order_by(MoodCheckin.created_at.desc()).offset(offset).limit(limit)))


@router.get("/check-ins/{checkin_id}", response_model=MoodCheckinRead)
def get_checkin(checkin_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return owned_checkin(db, user.id, checkin_id)


@router.patch("/check-ins/{checkin_id}", response_model=MoodCheckinRead)
def update_checkin(checkin_id: str, payload: MoodCheckinUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = owned_checkin(db, user.id, checkin_id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(item, key, value.strip() if key == "reflection" and value else value)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/check-ins/{checkin_id}", status_code=204)
def delete_checkin(checkin_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = owned_checkin(db, user.id, checkin_id)
    db.delete(item)
    db.commit()


@router.get("/check-ins/{checkin_id}/report.pdf")
def export_checkin_pdf(checkin_id: str, include_reflection: bool = False, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = owned_checkin(db, user.id, checkin_id)
    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=letter, rightMargin=0.8 * inch, leftMargin=0.8 * inch)
    styles = getSampleStyleSheet()
    story = [Paragraph("Mindful mood check-in", styles["Title"]), Spacer(1, 16), Paragraph(f"Date: {item.created_at.isoformat()}", styles["BodyText"]), Paragraph(f"Mood: {item.mood.value}", styles["BodyText"]), Paragraph(f"Intensity: {item.intensity} / 10", styles["BodyText"])]
    if include_reflection and item.reflection:
        from xml.sax.saxutils import escape
        story.extend([Spacer(1, 14), Paragraph("Reflection", styles["Heading2"]), Paragraph(escape(item.reflection).replace("\n", "<br/>"), styles["BodyText"])])
    doc.build(story)
    buffer.seek(0)
    return StreamingResponse(buffer, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="mindful-checkin-{item.id}.pdf"'})
