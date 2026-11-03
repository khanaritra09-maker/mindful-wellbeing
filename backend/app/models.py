from datetime import datetime, timezone
from enum import Enum
from uuid import uuid4

from sqlalchemy import Boolean, CheckConstraint, DateTime, Enum as SqlEnum, Float, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def new_id() -> str:
    return str(uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UserRole(str, Enum):
    USER = "user"
    ADMIN = "admin"


class Mood(str, Enum):
    CALM = "Calm"
    OKAY = "Okay"
    LOW = "Low"
    ANXIOUS = "Anxious"
    OVERWHELMED = "Overwhelmed"
    NOT_SURE = "Not sure"


class VoiceEmotion(str, Enum):
    CALM = "calm"
    HAPPY = "happy"
    SAD = "sad"
    ANGRY = "angry"
    ANXIOUS = "anxious"
    NEUTRAL = "neutral"


def enum_values(enum_class):
    return [item.value for item in enum_class]


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role in ('user', 'admin')", name="ck_users_role"),
        UniqueConstraint("email", name="uq_users_email"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(16), default=UserRole.USER.value, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    token_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    profile: Mapped["UserProfile"] = relationship(back_populates="user", cascade="all, delete-orphan", uselist=False)
    mood_checkins: Mapped[list["MoodCheckin"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    journal_entries: Mapped[list["JournalEntry"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    activity_records: Mapped[list["WellnessActivityRecord"]] = relationship(back_populates="user", cascade="all, delete-orphan")

    @property
    def display_name(self) -> str:
        return self.profile.display_name if self.profile else ""


class UserProfile(Base):
    __tablename__ = "user_profiles"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(80), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    user: Mapped[User] = relationship(back_populates="profile")


class MoodCheckin(Base):
    __tablename__ = "mood_checkins"
    __table_args__ = (
        CheckConstraint("intensity >= 1 and intensity <= 10", name="ck_checkin_intensity_range"),
        Index("ix_checkins_user_created", "user_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    mood: Mapped[Mood] = mapped_column(SqlEnum(Mood, name="mood_value", values_callable=enum_values), nullable=False)
    intensity: Mapped[int] = mapped_column(Integer, nullable=False)
    reflection: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    user: Mapped[User] = relationship(back_populates="mood_checkins")
    journal_entries: Mapped[list["JournalEntry"]] = relationship(back_populates="checkin")


class JournalEntry(Base):
    __tablename__ = "journal_entries"
    __table_args__ = (Index("ix_journal_user_date", "user_id", "entry_date"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    checkin_id: Mapped[str | None] = mapped_column(ForeignKey("mood_checkins.id", ondelete="SET NULL"), nullable=True)
    title: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    entry_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    user: Mapped[User] = relationship(back_populates="journal_entries")
    checkin: Mapped[MoodCheckin | None] = relationship(back_populates="journal_entries")


class WellnessActivityRecord(Base):
    __tablename__ = "wellness_activity_records"
    __table_args__ = (Index("ix_activity_user_completed", "user_id", "completed_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    activity_key: Mapped[str] = mapped_column(String(40), nullable=False)
    title: Mapped[str] = mapped_column(String(100), nullable=False)
    completed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    user: Mapped[User] = relationship(back_populates="activity_records")


class DatasetMetadata(Base):
    __tablename__ = "dataset_metadata"
    __table_args__ = (UniqueConstraint("name", "revision", name="uq_dataset_name_revision"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    revision: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    sample_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    samples_per_class: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    consent_policy_version: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    voice_samples: Mapped[list["VoiceSample"]] = relationship(back_populates="dataset")


class VoiceSample(Base):
    __tablename__ = "voice_samples"
    __table_args__ = (
        UniqueConstraint("sha256", name="uq_voice_samples_sha256"),
        UniqueConstraint("storage_key", name="uq_voice_samples_storage_key"),
        Index("ix_voice_samples_label_created", "label", "created_at"),
        CheckConstraint("size_bytes > 0", name="ck_voice_samples_size_positive"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    dataset_id: Mapped[str | None] = mapped_column(ForeignKey("dataset_metadata.id", ondelete="SET NULL"), nullable=True, index=True)
    dataset: Mapped[DatasetMetadata | None] = relationship(back_populates="voice_samples")
    label: Mapped[VoiceEmotion] = mapped_column(SqlEnum(VoiceEmotion, name="voice_emotion", values_callable=enum_values), nullable=False)
    description: Mapped[str] = mapped_column(String(240), default="", nullable=False)
    storage_key: Mapped[str] = mapped_column(String(80), nullable=False)
    content_type: Mapped[str] = mapped_column(String(80), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    consent_given: Mapped[bool] = mapped_column(Boolean, nullable=False)
    recording_consent_given: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    speaker_consent_confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    consent_text_version: Mapped[str] = mapped_column(String(40), nullable=False)
    consented_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    consented_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    deleted_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ModelVersion(Base):
    __tablename__ = "model_versions"
    __table_args__ = (UniqueConstraint("name", "version", name="uq_model_name_version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    version: Mapped[str] = mapped_column(String(40), nullable=False)
    training_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dataset_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    samples_per_class: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    validation_accuracy: Mapped[float | None] = mapped_column(Float, nullable=True)
    precision: Mapped[float | None] = mapped_column(Float, nullable=True)
    recall: Mapped[float | None] = mapped_column(Float, nullable=True)
    f1_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    confusion_matrix: Mapped[dict | list | None] = mapped_column(JSON, nullable=True)
    validation_status: Mapped[str] = mapped_column(String(24), default="missing", nullable=False)
    artifact_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class ModelEvaluation(Base):
    __tablename__ = "model_evaluations"
    __table_args__ = (Index("ix_model_evaluations_model_time", "model_version_id", "evaluated_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    model_version_id: Mapped[str] = mapped_column(ForeignKey("model_versions.id", ondelete="CASCADE"), nullable=False)
    evaluated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    dataset_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    dataset_revision: Mapped[str | None] = mapped_column(String(80), nullable=True)
    sample_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    metrics: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    confusion_matrix: Mapped[dict | list | None] = mapped_column(JSON, nullable=True)
    evaluator_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (Index("ix_audit_entity_time", "entity_type", "entity_id", "created_at"), Index("ix_audit_events_created_at", "created_at"))

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    actor_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(60), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(40), nullable=False)
    entity_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    request_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    details: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
