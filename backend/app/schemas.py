from datetime import datetime, timezone
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from .models import Mood, UserRole, VoiceEmotion


def as_utc(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


class APIModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, use_enum_values=True)

    @field_validator("created_at", "updated_at", "completed_at", "entry_date", "training_date", "evaluated_at", "consented_at", "deleted_at", mode="before", check_fields=False)
    @classmethod
    def normalize_datetime(cls, value: Any) -> Any:
        if isinstance(value, datetime):
            return as_utc(value)
        return value


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12, max_length=128)
    display_name: str = Field(min_length=1, max_length=80)

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: Any) -> Any:
        return value.strip().lower() if isinstance(value, str) else value

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("Display name is required")
        return value


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: Any) -> Any:
        return value.strip().lower() if isinstance(value, str) else value


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=12, max_length=128)


class AccountDeletionRequest(BaseModel):
    password: str = Field(min_length=1, max_length=128)
    confirm: bool

    @field_validator("confirm")
    @classmethod
    def must_confirm(cls, value: bool) -> bool:
        if value is not True:
            raise ValueError("Explicit account deletion confirmation is required")
        return value


class UserRead(APIModel):
    id: str
    email: EmailStr
    display_name: str
    role: UserRole
    created_at: datetime


class UserProfileUpdate(BaseModel):
    display_name: str = Field(min_length=1, max_length=80)

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("Display name is required")
        return value


class SessionResponse(BaseModel):
    expires_in: int
    user: UserRead


class MoodCheckinCreate(BaseModel):
    mood: Mood
    intensity: int = Field(ge=1, le=10)
    reflection: str = Field(default="", max_length=500)
    created_at: datetime | None = None


class MoodCheckinUpdate(BaseModel):
    mood: Mood | None = None
    intensity: int | None = Field(default=None, ge=1, le=10)
    reflection: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def require_change(self):
        if not self.model_fields_set or not any(getattr(self, field) is not None for field in self.model_fields_set):
            raise ValueError("At least one field must be provided")
        return self


class MoodCheckinRead(APIModel):
    id: str
    mood: Mood
    intensity: int
    reflection: str
    created_at: datetime
    updated_at: datetime


class JournalEntryCreate(BaseModel):
    title: str = Field(default="", max_length=100)
    body: str = Field(min_length=1, max_length=5000)
    entry_date: datetime
    tags: list[str] = Field(default_factory=list, max_length=12)
    checkin_id: str | None = None

    @field_validator("body")
    @classmethod
    def body_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Journal body cannot be blank")
        return value

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str) -> str:
        return value.strip()

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, tags: list[str]) -> list[str]:
        cleaned = list(dict.fromkeys(" ".join(tag.strip().lstrip("#").split())[:32] for tag in tags if tag.strip()))
        if len(cleaned) > 12:
            raise ValueError("At most 12 tags are allowed")
        return cleaned


class JournalEntryUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=100)
    body: str | None = Field(default=None, min_length=1, max_length=5000)
    entry_date: datetime | None = None
    tags: list[str] | None = Field(default=None, max_length=12)
    checkin_id: str | None = None

    @model_validator(mode="after")
    def require_change(self):
        if not self.model_fields_set or not any(getattr(self, field) is not None for field in self.model_fields_set):
            raise ValueError("At least one field must be provided")
        return self


class JournalEntryRead(APIModel):
    id: str
    checkin_id: str | None
    title: str
    body: str
    entry_date: datetime
    tags: list[str]
    created_at: datetime
    updated_at: datetime


ActivityKey = Literal[
    "guided-breathing", "box-breathing", "meditation", "gratitude",
    "daily-reflection", "relaxation", "self-reflection", "mindful-break",
]

ACTIVITY_TITLES = {
    "guided-breathing": "Guided breathing",
    "box-breathing": "Box breathing",
    "meditation": "Short meditation",
    "gratitude": "Gratitude practice",
    "daily-reflection": "Daily reflection",
    "relaxation": "Relaxation exercise",
    "self-reflection": "Positive self-reflection",
    "mindful-break": "Short mindful break",
}


class ActivityRecordCreate(BaseModel):
    activity_key: ActivityKey
    completed_at: datetime | None = None


class ActivityRecordRead(APIModel):
    id: str
    activity_key: str
    title: str
    completed_at: datetime
    created_at: datetime


class VoiceSampleRead(APIModel):
    id: str
    dataset_id: str | None
    label: VoiceEmotion
    description: str
    content_type: str
    size_bytes: int
    duration_ms: int | None
    sha256: str
    consent_given: bool
    recording_consent_given: bool
    speaker_consent_confirmed: bool
    consent_text_version: str
    consented_by: str | None
    consented_at: datetime
    created_by: str | None
    created_at: datetime
    deleted_by: str | None
    deleted_at: datetime | None


class VoiceSampleUpdate(BaseModel):
    label: VoiceEmotion | None = None
    description: str | None = Field(default=None, max_length=240)

    @model_validator(mode="after")
    def require_change(self):
        if not self.model_fields_set or not any(getattr(self, field) is not None for field in self.model_fields_set):
            raise ValueError("At least one field must be provided")
        return self


class VoiceDatasetSummary(BaseModel):
    total_samples: int
    samples_per_class: dict[str, int]


class DatasetMetadataCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    revision: str = Field(min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    consent_policy_version: str | None = Field(default=None, max_length=40)

    @field_validator("name", "revision")
    @classmethod
    def clean_required_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This value cannot be blank")
        return value


class DatasetMetadataRead(APIModel):
    id: str
    name: str
    revision: str
    description: str | None
    sample_count: int | None
    samples_per_class: dict[str, int] | None
    consent_policy_version: str | None
    created_by: str | None
    created_at: datetime


class ModelEvaluationRead(APIModel):
    id: str
    model_version_id: str
    evaluated_at: datetime
    dataset_name: str | None
    dataset_revision: str | None
    sample_count: int | None
    metrics: dict[str, Any] | None
    confusion_matrix: dict[str, Any] | list[Any] | None
    evaluator_id: str | None


class ModelVersionRead(APIModel):
    id: str
    name: str
    version: str
    training_date: datetime | None
    dataset_size: int | None
    samples_per_class: dict[str, int] | None
    validation_accuracy: float | None
    precision: float | None
    recall: float | None
    f1_score: float | None
    confusion_matrix: dict[str, Any] | list[Any] | None
    validation_status: str
    artifact_sha256: str | None
    created_at: datetime


class AuditEventRead(APIModel):
    id: str
    actor_id: str | None
    action: str
    entity_type: str
    entity_id: str | None
    request_id: str | None
    details: dict[str, Any]
    created_at: datetime


class CheckinReportOptions(BaseModel):
    include_reflection: bool = False
