"""Initial Mindful application schema.

Revision ID: 0001_initial_schema
Revises:
"""
from alembic import op
import sqlalchemy as sa


revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None

mood_enum = sa.Enum("Calm", "Okay", "Low", "Anxious", "Overwhelmed", "Not sure", name="mood_value")
voice_emotion_enum = sa.Enum("calm", "happy", "sad", "angry", "anxious", "neutral", name="voice_emotion")


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("display_name", sa.String(80), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("role", sa.String(16), nullable=False, server_default="user"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("token_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("role in ('user', 'admin')", name="ck_users_role"),
        sa.UniqueConstraint("email", name="uq_users_email"),
    )
    op.create_table(
        "mood_checkins",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("mood", mood_enum, nullable=False),
        sa.Column("intensity", sa.Integer(), nullable=False),
        sa.Column("reflection", sa.String(500), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("intensity >= 1 and intensity <= 10", name="ck_checkin_intensity_range"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_checkins_user_created", "mood_checkins", ["user_id", "created_at"])
    op.create_table(
        "journal_entries",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("checkin_id", sa.String(36), nullable=True),
        sa.Column("title", sa.String(100), nullable=False, server_default=""),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("entry_date", sa.DateTime(timezone=True), nullable=False),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["checkin_id"], ["mood_checkins.id"], ondelete="SET NULL"),
    )
    op.create_index("ix_journal_user_date", "journal_entries", ["user_id", "entry_date"])
    op.create_table(
        "wellness_activity_records",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("activity_key", sa.String(40), nullable=False),
        sa.Column("title", sa.String(100), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_activity_user_completed", "wellness_activity_records", ["user_id", "completed_at"])
    op.create_table(
        "voice_samples",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("label", voice_emotion_enum, nullable=False),
        sa.Column("description", sa.String(240), nullable=False, server_default=""),
        sa.Column("storage_key", sa.String(80), nullable=False),
        sa.Column("content_type", sa.String(80), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("consent_given", sa.Boolean(), nullable=False),
        sa.Column("consent_text_version", sa.String(40), nullable=False),
        sa.Column("consented_by", sa.String(36), nullable=False),
        sa.Column("consented_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.String(36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_by", sa.String(36), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("size_bytes > 0", name="ck_voice_samples_size_positive"),
        sa.ForeignKeyConstraint(["consented_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["deleted_by"], ["users.id"]),
        sa.UniqueConstraint("sha256", name="uq_voice_samples_sha256"),
        sa.UniqueConstraint("storage_key", name="uq_voice_samples_storage_key"),
    )
    op.create_index("ix_voice_samples_label_created", "voice_samples", ["label", "created_at"])
    op.create_table(
        "model_versions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("version", sa.String(40), nullable=False),
        sa.Column("training_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dataset_size", sa.Integer(), nullable=True),
        sa.Column("samples_per_class", sa.JSON(), nullable=True),
        sa.Column("validation_accuracy", sa.Float(), nullable=True),
        sa.Column("precision", sa.Float(), nullable=True),
        sa.Column("recall", sa.Float(), nullable=True),
        sa.Column("f1_score", sa.Float(), nullable=True),
        sa.Column("confusion_matrix", sa.JSON(), nullable=True),
        sa.Column("validation_status", sa.String(24), nullable=False, server_default="missing"),
        sa.Column("artifact_sha256", sa.String(64), nullable=True),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.UniqueConstraint("name", "version", name="uq_model_name_version"),
    )
    op.create_table(
        "model_evaluations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("model_version_id", sa.String(36), nullable=False),
        sa.Column("evaluated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("dataset_name", sa.String(120), nullable=True),
        sa.Column("dataset_revision", sa.String(80), nullable=True),
        sa.Column("sample_count", sa.Integer(), nullable=True),
        sa.Column("metrics", sa.JSON(), nullable=True),
        sa.Column("confusion_matrix", sa.JSON(), nullable=True),
        sa.Column("evaluator_id", sa.String(36), nullable=True),
        sa.ForeignKeyConstraint(["model_version_id"], ["model_versions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["evaluator_id"], ["users.id"]),
    )
    op.create_index("ix_model_evaluations_model_version_id", "model_evaluations", ["model_version_id"])
    op.create_table(
        "audit_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("actor_id", sa.String(36), nullable=True),
        sa.Column("action", sa.String(60), nullable=False),
        sa.Column("entity_type", sa.String(40), nullable=False),
        sa.Column("entity_id", sa.String(36), nullable=True),
        sa.Column("request_id", sa.String(64), nullable=True),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="SET NULL"),
    )
    op.create_index("ix_audit_entity_time", "audit_events", ["entity_type", "entity_id", "created_at"])
    op.create_index("ix_audit_events_actor_id", "audit_events", ["actor_id"])


def downgrade() -> None:
    op.drop_index("ix_audit_events_actor_id", table_name="audit_events")
    op.drop_index("ix_audit_entity_time", table_name="audit_events")
    op.drop_table("audit_events")
    op.drop_index("ix_model_evaluations_model_version_id", table_name="model_evaluations")
    op.drop_table("model_evaluations")
    op.drop_table("model_versions")
    op.drop_index("ix_voice_samples_label_created", table_name="voice_samples")
    op.drop_table("voice_samples")
    op.drop_index("ix_activity_user_completed", table_name="wellness_activity_records")
    op.drop_table("wellness_activity_records")
    op.drop_index("ix_journal_user_date", table_name="journal_entries")
    op.drop_table("journal_entries")
    op.drop_index("ix_checkins_user_created", table_name="mood_checkins")
    op.drop_table("mood_checkins")
    op.drop_table("users")
    bind = op.get_bind()
    voice_emotion_enum.drop(bind, checkfirst=True)
    mood_enum.drop(bind, checkfirst=True)
