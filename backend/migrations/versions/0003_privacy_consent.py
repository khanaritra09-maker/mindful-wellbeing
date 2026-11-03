"""Record separate voice consent scopes.

Revision ID: 0003_privacy_consent
Revises: 0002_profiles_dataset
"""
from alembic import op
import sqlalchemy as sa

revision = "0003_privacy_consent"
down_revision = "0002_profiles_dataset"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("voice_samples") as batch:
        batch.add_column(sa.Column("recording_consent_given", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("speaker_consent_confirmed", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table("voice_samples") as batch:
        batch.drop_column("speaker_consent_confirmed")
        batch.drop_column("recording_consent_given")
