from datetime import datetime, timedelta, timezone
import secrets
import hmac
from uuid import uuid4

import jwt
from fastapi import Depends, HTTPException, Request, status
from pwdlib import PasswordHash
from sqlalchemy.orm import Session

from .config import get_settings
from .database import get_db
from .models import User, UserRole


password_hash = PasswordHash.recommended()
JWT_ISSUER = "mindful-api"
JWT_AUDIENCE = "mindful-client"
SESSION_COOKIE = "mindful_session"
CSRF_COOKIE = "mindful_csrf"


def hash_password(password: str) -> str:
    return password_hash.hash(password)


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        return password_hash.verify(password, stored_hash)
    except Exception:
        return False


def create_session_token(user: User) -> tuple[str, str, int]:
    settings = get_settings()
    expires_in = settings.access_token_minutes * 60
    now = datetime.now(timezone.utc)
    csrf_token = secrets.token_urlsafe(32)
    payload = {
        "sub": user.id,
        "ver": user.token_version,
        "csrf": csrf_token,
        "jti": str(uuid4()),
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
        "iat": now,
        "nbf": now,
        "exp": now + timedelta(seconds=expires_in),
    }
    return jwt.encode(payload, settings.mindful_secret_key, algorithm="HS256"), csrf_token, expires_in


def unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": "invalid_authentication", "message": "Authentication is required or the session has expired."},
    )


def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
) -> User:
    signed_token = request.cookies.get(SESSION_COOKIE)
    if not signed_token:
        raise unauthorized()
    settings = get_settings()
    try:
        payload = jwt.decode(
            signed_token,
            settings.mindful_secret_key,
            algorithms=["HS256"],
            issuer=JWT_ISSUER,
            audience=JWT_AUDIENCE,
            options={"require": ["sub", "ver", "exp", "iat", "iss", "aud"]},
        )
    except jwt.PyJWTError as exc:
        raise unauthorized() from exc
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        cookie_csrf = request.cookies.get(CSRF_COOKIE, "")
        header_csrf = request.headers.get("x-csrf-token", "")
        claim_csrf = payload.get("csrf", "")
        if not cookie_csrf or not header_csrf or not isinstance(claim_csrf, str) or not hmac.compare_digest(cookie_csrf, header_csrf) or not hmac.compare_digest(cookie_csrf, claim_csrf):
            raise HTTPException(status_code=403, detail={"code": "csrf_check_failed", "message": "Refresh your session and try again."})
    user = db.get(User, payload.get("sub"))
    if user is None or not user.is_active or user.token_version != payload.get("ver"):
        raise unauthorized()
    return user


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != UserRole.ADMIN.value:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "admin_required", "message": "This operation requires an administrator account."},
        )
    return current_user
