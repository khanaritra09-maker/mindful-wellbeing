"""Separate profile information and add dataset revision metadata.

Revision ID: 0002_profiles_dataset
Revises: 0001_initial_schema
"""
from alembic import op
import sqlalchemy as sa


revision = "0002_profiles_dataset"
down_revision = "0001_initial_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_profiles",
        sa.Column("user_id", sa.String(36), primary_key=True),
        sa.Column("display_name", sa.String(80), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.execute(sa.text("INSERT INTO user_profiles (user_id, display_name, created_at, updated_at) SELECT id, display_name, created_at, updated_at FROM users"))
    op.drop_column("users", "display_name")

    op.create_table(
        "dataset_metadata",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("revision", sa.String(80), nullable=False),
        sa.Column("description", sa.String(500), nullable=True),
        sa.Column("sample_count", sa.Integer(), nullable=True),
        sa.Column("samples_per_class", sa.JSON(), nullable=True),
        sa.Column("consent_policy_version", sa.String(40), nullable=True),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("name", "revision", name="uq_dataset_name_revision"),
    )
    with op.batch_alter_table("voice_samples") as batch_op:
        batch_op.add_column(sa.Column("dataset_id", sa.String(36), nullable=True))
        batch_op.create_foreign_key("fk_voice_samples_dataset_id_dataset_metadata", "dataset_metadata", ["dataset_id"], ["id"], ondelete="SET NULL")
        batch_op.create_index("ix_voice_samples_dataset_id", ["dataset_id"])


def downgrade() -> None:
    op.drop_index("ix_voice_samples_dataset_id", table_name="voice_samples")
    with op.batch_alter_table("voice_samples") as batch_op:
        batch_op.drop_constraint("fk_voice_samples_dataset_id_dataset_metadata", type_="foreignkey")
        batch_op.drop_column("dataset_id")
    op.drop_table("dataset_metadata")

    op.add_column("users", sa.Column("display_name", sa.String(80), nullable=True))
    op.execute(sa.text("UPDATE users SET display_name = (SELECT display_name FROM user_profiles WHERE user_profiles.user_id = users.id)"))
    op.drop_table("user_profiles")
    with op.batch_alter_table("users") as batch_op:
        batch_op.alter_column("display_name", existing_type=sa.String(80), nullable=False)
