"""Password hashing and JWT helpers."""

import secrets
from datetime import timedelta
from typing import Any, Dict, Optional

import bcrypt
import jwt

from app.settings import settings
from app.shared.exceptions import BadRequestError, UnauthorizedError
from app.shared.utils import utcnow

# bcrypt only uses the first 72 bytes of a password.
BCRYPT_MAX_BYTES = 72


def hash_password(password: str) -> str:
    """Hash a plain-text password with bcrypt."""
    raw = password.encode("utf-8")
    if len(raw) > BCRYPT_MAX_BYTES:
        raise BadRequestError("Password must be at most 72 bytes long")
    return bcrypt.hashpw(raw, bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    """Check a plain-text password against a stored bcrypt hash."""
    raw = password.encode("utf-8")
    if len(raw) > BCRYPT_MAX_BYTES:
        return False
    try:
        return bcrypt.checkpw(raw, password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def new_token_id() -> str:
    """Return an unguessable id used for session/refresh-token rotation."""
    return secrets.token_urlsafe(32)


def _encode(
    subject: str,
    token_type: str,
    expires_delta: timedelta,
    *,
    session_id: Optional[int] = None,
    jti: Optional[str] = None,
) -> str:
    now = utcnow()
    payload: Dict[str, Any] = {
        "sub": str(subject),
        "type": token_type,
        "iat": now,
        "exp": now + expires_delta,
    }
    if session_id is not None:
        payload["sid"] = str(session_id)
    if jti is not None:
        payload["jti"] = jti
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def create_access_token(
    user_id: int, *, session_id: Optional[int] = None, jti: Optional[str] = None
) -> str:
    return _encode(
        subject=str(user_id),
        token_type="access",
        expires_delta=timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
        session_id=session_id,
        jti=jti,
    )


def create_refresh_token(
    user_id: int, *, session_id: Optional[int] = None, jti: Optional[str] = None
) -> str:
    return _encode(
        subject=str(user_id),
        token_type="refresh",
        expires_delta=timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
        session_id=session_id,
        jti=jti,
    )


def decode_token(token: str, expected_type: Optional[str] = None) -> Dict[str, Any]:
    """Decode and validate a JWT, raising ``UnauthorizedError`` on failure."""
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
        )
    except jwt.ExpiredSignatureError as exc:
        raise UnauthorizedError("Token has expired", code="token_expired") from exc
    except jwt.InvalidTokenError as exc:
        raise UnauthorizedError("Invalid token", code="invalid_token") from exc

    if expected_type and payload.get("type") != expected_type:
        raise UnauthorizedError("Invalid token type", code="invalid_token_type")
    return payload


def access_token_expires_in() -> int:
    return settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60
