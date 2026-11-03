import json
import re
import tempfile
import zipfile
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from ..database import get_db
from ..config import get_settings
from ..models import AuditEvent, DatasetMetadata, JournalEntry, ModelEvaluation, ModelVersion, MoodCheckin, User, UserProfile, UserRole, VoiceEmotion, VoiceSample, WellnessActivityRecord, utcnow
from ..schemas import AccountDeletionRequest, ChangePasswordRequest, LoginRequest, SessionResponse, UserCreate, UserProfileUpdate, UserRead
from ..security import CSRF_COOKIE, SESSION_COOKIE, create_session_token, get_current_user, hash_password, unauthorized, verify_password
from ..limits import limiter

router = APIRouter(tags=["Authentication and profile"])


def verify_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") not in get_settings().cors_origins:
        raise HTTPException(403, {"code": "origin_not_allowed", "message": "This request origin is not allowed."})


def set_session_cookies(response: Response, token: str, csrf_token: str, expires_in: int) -> None:
    settings = get_settings()
    common = {"max_age": expires_in, "secure": settings.secure_cookies, "samesite": settings.session_cookie_samesite}
    response.set_cookie(SESSION_COOKIE, token, httponly=True, path="/api/v1", **common)
    response.set_cookie(CSRF_COOKIE, csrf_token, httponly=False, path="/", **common)


@router.post("/auth/register", response_model=UserRead, status_code=status.HTTP_201_CREATED)
@limiter.limit("3/hour")
def register(payload: UserCreate, request: Request, db: Session = Depends(get_db)):
    verify_origin(request)
    user = User(email=str(payload.email).lower(), password_hash=hash_password(payload.password), role=UserRole.USER.value, profile=UserProfile(display_name=payload.display_name))
    db.add(user)
    try:
        db.commit()
        db.refresh(user)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, {"code": "registration_conflict", "message": "Unable to create an account with those details."}) from exc
    return user


@router.post("/auth/login", response_model=SessionResponse)
@limiter.limit("8/minute")
def login(payload: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)):
    verify_origin(request)
    user = db.scalar(select(User).options(joinedload(User.profile)).where(User.email == str(payload.email).lower()))
    if user is None or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise unauthorized()
    token, csrf_token, expires_in = create_session_token(user)
    set_session_cookies(response, token, csrf_token, expires_in)
    return SessionResponse(expires_in=expires_in, user=user)


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(response: Response, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    user.token_version += 1
    db.commit()
    settings = get_settings()
    response.delete_cookie(SESSION_COOKIE, path="/api/v1", secure=settings.secure_cookies, httponly=True, samesite=settings.session_cookie_samesite)
    response.delete_cookie(CSRF_COOKIE, path="/", secure=settings.secure_cookies, httponly=False, samesite=settings.session_cookie_samesite)


@router.post("/auth/change-password", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("5/hour")
def change_password(payload: ChangePasswordRequest, request: Request, response: Response, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    verify_origin(request)
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(403, {"code": "reauthentication_required", "message": "The current password could not be verified."})
    if verify_password(payload.new_password, user.password_hash):
        raise HTTPException(400, {"code": "password_unchanged", "message": "Choose a new password that differs from your current password."})
    user.password_hash = hash_password(payload.new_password)
    user.token_version += 1
    db.add(AuditEvent(actor_id=user.id, action="user.password_changed", entity_type="user", entity_id=user.id, request_id=request.state.request_id, details={}))
    db.commit()
    db.refresh(user)
    token, csrf_token, expires_in = create_session_token(user)
    set_session_cookies(response, token, csrf_token, expires_in)


@router.get("/users/me", response_model=UserRead)
def read_profile(user: User = Depends(get_current_user)):
    return user


@router.patch("/users/me", response_model=UserRead)
def update_profile(payload: UserProfileUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if user.profile is None:
        user.profile = UserProfile(display_name=payload.display_name)
    else:
        user.profile.display_name = payload.display_name
    user.updated_at = utcnow()
    db.commit()
    db.refresh(user)
    return user


def _record_dict(row, exclude=()):
    return {column.name: getattr(row, column.name).isoformat() if isinstance(getattr(row, column.name), datetime) else getattr(row, column.name).value if hasattr(getattr(row, column.name), "value") else getattr(row, column.name) for column in row.__table__.columns if column.name not in exclude}


def _owned_audio_path(storage_key: str):
    root = get_settings().resolve_path(get_settings().voice_storage_path).resolve()
    path = (root / storage_key).resolve()
    if path.parent != root or not re.fullmatch(r"[0-9a-f-]{36}\.audio", storage_key):
        return None
    return path


@router.get("/users/me/export")
@limiter.limit("5/hour")
def export_account_data(request: Request, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    settings = get_settings()
    checkins = list(db.scalars(select(MoodCheckin).where(MoodCheckin.user_id == user.id)))
    journals = list(db.scalars(select(JournalEntry).where(JournalEntry.user_id == user.id)))
    activities = list(db.scalars(select(WellnessActivityRecord).where(WellnessActivityRecord.user_id == user.id)))
    samples = list(db.scalars(select(VoiceSample).where((VoiceSample.created_by == user.id) | (VoiceSample.consented_by == user.id))))
    audio_sizes = sum(sample.size_bytes for sample in samples if sample.deleted_at is None)
    total_size = audio_sizes + sum(len((row.body or "").encode()) for row in journals) + sum(len((row.reflection or "").encode()) for row in checkins)
    if total_size > settings.max_export_bytes:
        raise HTTPException(413, {"code": "export_size_limit", "message": "Your export is larger than the configured limit. Contact support for an assisted export."})
    profile = {"email": user.email, "display_name": user.display_name, "created_at": user.created_at.isoformat(), "exported_at": datetime.now(timezone.utc).isoformat()}
    payload = {"account": profile, "mood_checkins": [_record_dict(row) for row in checkins], "journal_entries": [_record_dict(row) for row in journals], "wellness_activities": [_record_dict(row) for row in activities], "voice_sample_metadata": [_record_dict(row, exclude=("storage_key",)) for row in samples]}
    # Keep small exports in memory, then spill larger archives to a temporary file.
    buffer = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024, mode="w+b")
    try:
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            with archive.open("mindful-account-data.json", "w") as json_file:
                encoder = json.JSONEncoder(ensure_ascii=False, indent=2)
                pending = []
                pending_size = 0
                for chunk in encoder.iterencode(payload):
                    pending.append(chunk)
                    pending_size += len(chunk)
                    if pending_size >= 64 * 1024:
                        json_file.write("".join(pending).encode("utf-8"))
                        pending.clear()
                        pending_size = 0
                if pending:
                    json_file.write("".join(pending).encode("utf-8"))
            for sample in samples:
                if sample.deleted_at is None:
                    audio_path = _owned_audio_path(sample.storage_key)
                    if audio_path and audio_path.is_file():
                        extension = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3", "audio/flac": ".flac"}.get(sample.content_type, ".audio")
                        archive.write(audio_path, f"voice-recordings/{sample.id}{extension}")
        buffer.seek(0)
    except Exception:
        buffer.close()
        raise
    db.add(AuditEvent(actor_id=user.id, action="user.data_exported", entity_type="user", entity_id=user.id, request_id=request.state.request_id, details={"records": len(checkins) + len(journals) + len(activities) + len(samples)}))
    db.commit()
    def stream_export():
        try:
            while chunk := buffer.read(64 * 1024):
                yield chunk
        finally:
            buffer.close()

    return StreamingResponse(stream_export(), media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="mindful-account-export.zip"', "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})


@router.delete("/users/me", status_code=204)
@limiter.limit("3/hour")
def delete_account(payload: AccountDeletionRequest, request: Request, response: Response, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if not verify_password(payload.password, user.password_hash):
        raise HTTPException(403, {"code": "reauthentication_required", "message": "The password could not be verified."})
    sample_rows = list(db.scalars(select(VoiceSample).where((VoiceSample.created_by == user.id) | (VoiceSample.consented_by == user.id))))
    audio_paths = [path for row in sample_rows if (path := _owned_audio_path(row.storage_key)) is not None]
    dataset_ids = {row.dataset_id for row in sample_rows if row.dataset_id}
    db.add(AuditEvent(actor_id=user.id, action="user.account_deleted", entity_type="user", entity_id=None, request_id=request.state.request_id, details={"voice_samples_removed": len(sample_rows)}))
    for row in sample_rows:
        db.delete(row)
    for dataset_id in dataset_ids:
        dataset = db.get(DatasetMetadata, dataset_id)
        if dataset:
            grouped = db.execute(select(VoiceSample.label, func.count(VoiceSample.id)).where(VoiceSample.dataset_id == dataset_id, VoiceSample.deleted_at.is_(None)).group_by(VoiceSample.label)).all()
            counts = {label: 0 for label in (emotion.value for emotion in VoiceEmotion)}
            counts.update({label.value if hasattr(label, "value") else label: count for label, count in grouped})
            dataset.samples_per_class = counts
            dataset.sample_count = sum(counts.values())
    # Preserve audit history while severing account identifiers before the account is removed.
    db.execute(update(AuditEvent).where(AuditEvent.actor_id == user.id).values(actor_id=None))
    db.execute(update(DatasetMetadata).where(DatasetMetadata.created_by == user.id).values(created_by=None))
    db.execute(update(ModelVersion).where(ModelVersion.created_by == user.id).values(created_by=None))
    db.execute(update(ModelEvaluation).where(ModelEvaluation.evaluator_id == user.id).values(evaluator_id=None))
    db.execute(update(VoiceSample).where(VoiceSample.deleted_by == user.id).values(deleted_by=None))
    db.delete(user)
    db.commit()
    for path in audio_paths:
        path.unlink(missing_ok=True)
    settings = get_settings()
    response.delete_cookie(SESSION_COOKIE, path="/api/v1", secure=settings.secure_cookies, httponly=True, samesite=settings.session_cookie_samesite)
    response.delete_cookie(CSRF_COOKIE, path="/", secure=settings.secure_cookies, httponly=False, samesite=settings.session_cookie_samesite)
