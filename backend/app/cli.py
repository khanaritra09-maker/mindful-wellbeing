import argparse
from datetime import timedelta
from getpass import getpass

from sqlalchemy import delete, select

from .database import SessionLocal
from .config import get_settings
from .models import AuditEvent, User, UserProfile, UserRole, utcnow
from .security import hash_password


def create_admin(email: str) -> None:
    email = email.strip().lower()
    display_name = input("Admin display name: ").strip()
    if not display_name:
        raise SystemExit("Admin display name is required.")
    print("Password input is hidden: type or paste it, then press Enter. Nothing will appear on screen.")
    password = getpass("Admin password (12+ characters): ")
    confirm = getpass("Confirm password (input hidden): ")
    if len(password) < 12:
        raise SystemExit("Password is too short. Use at least 12 characters; no account was created.")
    if password != confirm:
        raise SystemExit("The two password entries do not match; no account was created.")
    with SessionLocal() as db:
        if db.scalar(select(User.id).where(User.email == email)):
            raise SystemExit("An account already uses that email address.")
        db.add(User(email=email, password_hash=hash_password(password), role=UserRole.ADMIN.value, profile=UserProfile(display_name=display_name)))
        db.commit()
    print(f"Administrator created: {email}")


def purge_audit_events() -> None:
    cutoff = utcnow() - timedelta(days=get_settings().audit_retention_days)
    with SessionLocal() as db:
        result = db.execute(delete(AuditEvent).where(AuditEvent.created_at < cutoff))
        db.commit()
    print(f"Removed {result.rowcount or 0} audit events older than the configured retention period.")


def main():
    parser = argparse.ArgumentParser(description="Mindful backend administration")
    subparsers = parser.add_subparsers(dest="command", required=True)
    create_parser = subparsers.add_parser("create-admin", help="Create the first or another administrator account")
    create_parser.add_argument("--email", required=True)
    subparsers.add_parser("purge-audit-events", help="Purge audit records beyond AUDIT_RETENTION_DAYS (minimum 365)")
    args = parser.parse_args()
    if args.command == "create-admin":
        create_admin(args.email)
    elif args.command == "purge-audit-events":
        purge_audit_events()


if __name__ == "__main__":
    main()
