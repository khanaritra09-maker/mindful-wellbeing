"""Add indexes for paged model evaluation and audit history queries.

Revision ID: 0004_query_indexes
Revises: 0003_privacy_consent
"""
from alembic import op


revision = "0004_query_indexes"
down_revision = "0003_privacy_consent"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_index("ix_model_evaluations_model_version_id", table_name="model_evaluations")
    op.create_index("ix_model_evaluations_model_time", "model_evaluations", ["model_version_id", "evaluated_at"])
    op.create_index("ix_audit_events_created_at", "audit_events", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_audit_events_created_at", table_name="audit_events")
    op.drop_index("ix_model_evaluations_model_time", table_name="model_evaluations")
    op.create_index("ix_model_evaluations_model_version_id", "model_evaluations", ["model_version_id"])
