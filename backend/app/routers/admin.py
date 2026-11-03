import csv
import hashlib
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from ..limits import limiter

from ..config import get_settings
from ..database import get_db
from ..models import AuditEvent, DatasetMetadata, ModelEvaluation, ModelVersion, User, VoiceEmotion, VoiceSample, enum_values
from ..schemas import AuditEventRead, DatasetMetadataCreate, DatasetMetadataRead, ModelEvaluationRead, ModelVersionRead, VoiceDatasetSummary, VoiceSampleRead, VoiceSampleUpdate
from ..security import require_admin

router = APIRouter(prefix="/admin", tags=["Administration"])
ALLOWED_TYPES = {"audio/wav", "audio/x-wav", "audio/mpeg", "audio/flac", "audio/ogg", "audio/webm"}
LABEL_VALUES = set(enum_values(VoiceEmotion))


def audit(db: Session, actor_id: str, action: str, entity_type: str, entity_id: str | None, request: Request, details: dict | None = None):
    db.add(AuditEvent(actor_id=actor_id, action=action, entity_type=entity_type, entity_id=entity_id, request_id=request.state.request_id, details=details or {}))


def audio_signature(data: bytes, content_type: str) -> bool:
    if content_type in {"audio/wav", "audio/x-wav"}:
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"
    if content_type == "audio/mpeg":
        return data.startswith(b"ID3") or (len(data) > 1 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0)
    if content_type == "audio/flac":
        return data.startswith(b"fLaC")
    if content_type == "audio/ogg":
        return data.startswith(b"OggS")
    if content_type == "audio/webm":
        return data.startswith(b"\x1a\x45\xdf\xa3")
    return False


def refresh_dataset_counts(db: Session, dataset: DatasetMetadata) -> None:
    rows = db.execute(select(VoiceSample.label, func.count(VoiceSample.id)).where(VoiceSample.dataset_id == dataset.id, VoiceSample.deleted_at.is_(None)).group_by(VoiceSample.label)).all()
    dataset.samples_per_class = {label: 0 for label in LABEL_VALUES}
    dataset.samples_per_class.update({label.value if isinstance(label, VoiceEmotion) else label: count for label, count in rows})
    dataset.sample_count = sum(dataset.samples_per_class.values())


def csv_safe(value):
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def private_audio_path(storage_key: str) -> Path:
    settings = get_settings()
    root = settings.resolve_path(settings.voice_storage_path).resolve()
    path = (root / storage_key).resolve()
    if path.parent != root or not re.fullmatch(r"[0-9a-f-]{36}\.audio", storage_key):
        raise HTTPException(404, {"code": "audio_not_found", "message": "Audio file was not found."})
    return path


@router.get("/voice-samples", response_model=list[VoiceSampleRead])
def list_voice_samples(label: VoiceEmotion | None = None, dataset_id: str | None = None, q: str | None = Query(default=None, max_length=100), offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500), db: Session = Depends(get_db), _: User = Depends(require_admin)):
    query = select(VoiceSample).where(VoiceSample.deleted_at.is_(None))
    if label:
        query = query.where(VoiceSample.label == label)
    if dataset_id:
        query = query.where(VoiceSample.dataset_id == dataset_id)
    if q:
        query = query.where(VoiceSample.description.ilike(f"%{q.strip()}%"))
    return list(db.scalars(query.order_by(VoiceSample.created_at.desc()).offset(offset).limit(limit)))


@router.get("/datasets", response_model=list[DatasetMetadataRead])
def list_datasets(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    return list(db.scalars(select(DatasetMetadata).order_by(DatasetMetadata.created_at.desc())))


@router.post("/datasets", response_model=DatasetMetadataRead, status_code=201)
def create_dataset(payload: DatasetMetadataCreate, request: Request, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    item = DatasetMetadata(**payload.model_dump(), created_by=admin.id, sample_count=0, samples_per_class={label: 0 for label in LABEL_VALUES})
    db.add(item)
    try:
        db.flush()
        audit(db, admin.id, "dataset.created", "dataset_metadata", item.id, request, {"name": item.name, "revision": item.revision})
        db.commit()
        db.refresh(item)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, {"code": "dataset_revision_exists", "message": "That dataset name and revision already exist."}) from exc
    return item


@router.get("/voice-samples/summary", response_model=VoiceDatasetSummary)
def voice_summary(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    rows = db.execute(select(VoiceSample.label, func.count(VoiceSample.id)).where(VoiceSample.deleted_at.is_(None)).group_by(VoiceSample.label)).all()
    counts = {label: 0 for label in LABEL_VALUES}
    counts.update({label.value if isinstance(label, VoiceEmotion) else label: count for label, count in rows})
    return VoiceDatasetSummary(total_samples=sum(counts.values()), samples_per_class=counts)


@router.post("/voice-samples", response_model=VoiceSampleRead, status_code=201)
@limiter.limit("10/hour")
async def add_voice_sample(request: Request, label: VoiceEmotion = Form(...), description: str = Form(default="", max_length=240), dataset_id: str | None = Form(default=None), recording_consent_given: bool = Form(...), consent_given: bool = Form(...), speaker_consent_confirmed: bool = Form(...), confirm_save: bool = Form(...), duration_ms: int | None = Form(default=None, ge=1, le=300000), file: UploadFile = File(...), db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    if not recording_consent_given or not consent_given or not speaker_consent_confirmed:
        raise HTTPException(400, {"code": "consent_required", "message": "Permission to record, upload, and the speaker's authorization are each required."})
    if not confirm_save:
        raise HTTPException(400, {"code": "save_confirmation_required", "message": "Confirm the sample should be saved to the private dataset."})
    dataset = db.get(DatasetMetadata, dataset_id) if dataset_id else None
    if dataset_id and dataset is None:
        raise HTTPException(404, {"code": "dataset_not_found", "message": "Dataset revision was not found."})
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(415, {"code": "unsupported_audio_type", "message": "Use WAV, MP3, FLAC, OGG, or WebM audio."})
    settings = get_settings()
    data = await file.read(settings.max_voice_sample_bytes + 1)
    if not data or len(data) > settings.max_voice_sample_bytes:
        raise HTTPException(413, {"code": "audio_size_limit", "message": "The audio file is empty or exceeds the configured size limit."})
    if not audio_signature(data, file.content_type):
        raise HTTPException(415, {"code": "invalid_audio_file", "message": "The file content does not match its declared audio format."})
    digest = hashlib.sha256(data).hexdigest()
    if db.scalar(select(VoiceSample.id).where(VoiceSample.sha256 == digest)):
        raise HTTPException(409, {"code": "duplicate_audio_sample", "message": "This audio sample has already been submitted."})
    storage_key = f"{uuid4()}.audio"
    path = private_audio_path(storage_key)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name == "posix":
        os.chmod(path.parent, 0o700)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as private_file:
            private_file.write(data)
    except FileExistsError as exc:
        raise HTTPException(409, {"code": "storage_collision", "message": "Could not safely store this audio sample. Please retry."}) from exc
    item = VoiceSample(dataset_id=dataset_id, label=label, description=description.strip(), storage_key=storage_key, content_type=file.content_type, size_bytes=len(data), duration_ms=duration_ms, sha256=digest, consent_given=True, recording_consent_given=True, speaker_consent_confirmed=True, consent_text_version=settings.consent_text_version, consented_by=admin.id, consented_at=datetime.now(timezone.utc), created_by=admin.id)
    db.add(item)
    try:
        db.flush()
        if dataset:
            refresh_dataset_counts(db, dataset)
        audit(db, admin.id, "voice_sample.created", "voice_sample", item.id, request, {"label": label.value, "size_bytes": len(data), "sha256": digest, "recording_consent_given": True, "upload_consent_given": True, "speaker_consent_confirmed": True, "consent_text_version": settings.consent_text_version})
        db.commit()
        db.refresh(item)
    except IntegrityError as exc:
        db.rollback()
        path.unlink(missing_ok=True)
        raise HTTPException(409, {"code": "duplicate_audio_sample", "message": "This audio sample has already been submitted."}) from exc
    except Exception:
        db.rollback()
        path.unlink(missing_ok=True)
        raise
    return item


@router.get("/voice-samples/{sample_id}/audio")
def preview_voice_sample(sample_id: str, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    item = db.scalar(select(VoiceSample).where(VoiceSample.id == sample_id, VoiceSample.deleted_at.is_(None)))
    if item is None:
        raise HTTPException(404, {"code": "voice_sample_not_found", "message": "Voice sample was not found."})
    path = private_audio_path(item.storage_key)
    if not path.is_file():
        raise HTTPException(404, {"code": "audio_not_found", "message": "Audio file was not found."})
    return StreamingResponse(path.open("rb"), media_type=item.content_type, headers={"Cache-Control": "private, no-store", "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff"})


@router.patch("/voice-samples/{sample_id}", response_model=VoiceSampleRead)
def update_voice_sample(sample_id: str, payload: VoiceSampleUpdate, request: Request, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    item = db.scalar(select(VoiceSample).where(VoiceSample.id == sample_id, VoiceSample.deleted_at.is_(None)))
    if item is None:
        raise HTTPException(404, {"code": "voice_sample_not_found", "message": "Voice sample was not found."})
    changes = payload.model_dump(exclude_unset=True)
    previous_label = item.label
    for key, value in changes.items():
        setattr(item, key, value.strip() if key == "description" and value else value)
    if item.dataset_id and item.label != previous_label:
        dataset = db.get(DatasetMetadata, item.dataset_id)
        if dataset:
            refresh_dataset_counts(db, dataset)
    audit(db, admin.id, "voice_sample.updated", "voice_sample", item.id, request, {"fields": sorted(changes)})
    db.commit()
    db.refresh(item)
    return item


@router.delete("/voice-samples/{sample_id}", status_code=204)
def delete_voice_sample(sample_id: str, request: Request, confirm: bool = Query(default=False), db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    if not confirm:
        raise HTTPException(400, {"code": "confirmation_required", "message": "Pass confirm=true after confirming deletion."})
    item = db.scalar(select(VoiceSample).where(VoiceSample.id == sample_id, VoiceSample.deleted_at.is_(None)))
    if item is None:
        raise HTTPException(404, {"code": "voice_sample_not_found", "message": "Voice sample was not found."})
    item.deleted_at = datetime.now(timezone.utc)
    item.deleted_by = admin.id
    audit(db, admin.id, "voice_sample.deleted", "voice_sample", item.id, request, {"label": item.label.value})
    db.flush()
    if item.dataset_id:
        dataset = db.get(DatasetMetadata, item.dataset_id)
        if dataset:
            refresh_dataset_counts(db, dataset)
    db.commit()
    private_audio_path(item.storage_key).unlink(missing_ok=True)


@router.get("/voice-samples/export.csv")
def export_voice_metadata(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    output = tempfile.SpooledTemporaryFile(max_size=1024 * 1024, mode="w+t", encoding="utf-8", newline="")
    fields = ["id", "label", "description", "content_type", "size_bytes", "duration_ms", "sha256", "recording_consent_given", "consent_given", "speaker_consent_confirmed", "consent_text_version", "consented_by", "consented_at", "created_by", "created_at"]
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    query = select(VoiceSample).where(VoiceSample.deleted_at.is_(None)).order_by(VoiceSample.created_at).execution_options(yield_per=500)
    try:
        for item in db.scalars(query):
            writer.writerow({key: csv_safe(getattr(item, key).value if isinstance(getattr(item, key), VoiceEmotion) else getattr(item, key)) for key in fields})
        output.seek(0)
    except Exception:
        output.close()
        raise

    def stream_csv():
        try:
            while chunk := output.read(64 * 1024):
                yield chunk
        finally:
            output.close()

    return StreamingResponse(stream_csv(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=voice-sample-metadata.csv", "Cache-Control": "private, no-store"})


@router.get("/models", response_model=list[ModelVersionRead])
def list_models(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    return list(db.scalars(select(ModelVersion).order_by(ModelVersion.created_at.desc())))


@router.get("/models/{model_id}/evaluations", response_model=list[ModelEvaluationRead])
def model_evaluations(model_id: str, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    if db.get(ModelVersion, model_id) is None:
        raise HTTPException(404, {"code": "model_not_found", "message": "Model version was not found."})
    return list(db.scalars(select(ModelEvaluation).where(ModelEvaluation.model_version_id == model_id).order_by(ModelEvaluation.evaluated_at.desc())))


@router.get("/audit-events", response_model=list[AuditEventRead])
def list_audit_events(offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500), db: Session = Depends(get_db), _: User = Depends(require_admin)):
    return list(db.scalars(select(AuditEvent).order_by(AuditEvent.created_at.desc()).offset(offset).limit(limit)))
