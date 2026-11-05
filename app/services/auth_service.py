"""Authentication and device-session business logic."""

import secrets
from datetime import timedelta
from typing import Optional, Tuple

from doveorm import Q

from app.database import db
from app.models import User, UserSession
from app.schemas.auth import LoginRequest, RegisterRequest
from app.settings import settings
from app.shared.exceptions import ConflictError, UnauthorizedError
from app.shared.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    new_token_id,
    verify_password,
)
from app.shared.utils import unique_violation, utcnow


def _truncate(value: Optional[str], limit: int) -> Optional[str]:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    return value[:limit]


class AuthService:
    @staticmethod
    def get_by_identifier(identifier: str):
        """Find a user by username or email (case-insensitive)."""
        identifier = identifier.strip().lower()
        return User.filter(
            Q(username__iexact=identifier) | Q(email__iexact=identifier)
        ).first()

    @staticmethod
    def _create_session(
        user: User,
        *,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
        device_name: Optional[str] = None,
    ) -> UserSession:
        now = utcnow()
        return UserSession.create(
            user_id=user.id,
            refresh_jti=new_token_id(),
            device_name=_truncate(device_name, 120),
            ip_address=_truncate(ip_address, 45),
            user_agent=_truncate(user_agent, 512),
            last_used_at=now,
            expires_at=now + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
        )

    @staticmethod
    def register(
        payload: RegisterRequest,
        *,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
        device_name: Optional[str] = None,
    ) -> Tuple[User, UserSession]:
        username = payload.username.lower()
        email = payload.email.lower()

        if User.existsByUsername(username):
            raise ConflictError("Username is already taken", code="username_taken")
        if User.existsByEmail(email):
            raise ConflictError("Email is already registered", code="email_taken")

        try:
            with db().transaction():
                user = User.create(
                    name=payload.name,
                    username=username,
                    email=email,
                    password=hash_password(payload.password),
                )
                session = AuthService._create_session(
                    user,
                    ip_address=ip_address,
                    user_agent=user_agent,
                    device_name=device_name,
                )
            return user, session
        except Exception as exc:
            # Covers the race between the checks above and the UNIQUE indexes.
            if unique_violation(exc):
                raise ConflictError(
                    "Username or email is already registered", code="user_exists"
                ) from exc
            raise

    @staticmethod
    def authenticate(
        payload: LoginRequest,
        *,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
        device_name: Optional[str] = None,
    ) -> Tuple[User, UserSession]:
        user = AuthService.get_by_identifier(payload.identifier)
        if user is None or not verify_password(payload.password, user.password):
            raise UnauthorizedError("Invalid credentials", code="invalid_credentials")
        if not user.is_active:
            raise UnauthorizedError("This account is disabled", code="account_disabled")

        session = AuthService._create_session(
            user,
            ip_address=ip_address,
            user_agent=user_agent,
            device_name=device_name,
        )
        return user, session

    @staticmethod
    def issue_tokens(user: User, session: UserSession) -> Tuple[str, str]:
        access_token = create_access_token(
            user.id, session_id=session.id, jti=new_token_id()
        )
        refresh_token = create_refresh_token(
            user.id, session_id=session.id, jti=session.refresh_jti
        )
        return access_token, refresh_token

    @staticmethod
    def refresh(refresh_token: str) -> Tuple[User, UserSession]:
        payload = decode_token(refresh_token, expected_type="refresh")
        session = AuthService._session_from_payload(payload)
        token_jti = payload.get("jti")
        if not token_jti or not secrets.compare_digest(session.refresh_jti, str(token_jti)):
            raise UnauthorizedError(
                "Refresh token has already been used", code="refresh_token_reused"
            )

        user = AuthService._active_user(session.user_id)

        # Rotate the refresh token and extend the session on every use.
        now = utcnow()
        session.refresh_jti = new_token_id()
        session.last_used_at = now
        session.expires_at = now + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
        session.save(
            update_fields=["refresh_jti", "last_used_at", "expires_at", "updated_at"]
        )
        return user, session

    @staticmethod
    def resolve_access_token(token: str) -> Tuple[User, Optional[UserSession], dict]:
        """Validate an access token and return its user and session.

        Socket.IO connections use the same check as HTTP requests. Tokens
        issued before sessions existed (no ``sid`` claim) are still accepted.
        """
        payload = decode_token(token, expected_type="access")
        user_id = AuthService._subject(payload)
        session = None
        if payload.get("sid") is not None:
            session = AuthService._session_from_payload(payload)
        return AuthService._active_user(user_id), session, payload

    @staticmethod
    def current_session(access_token: str) -> UserSession:
        payload = decode_token(access_token, expected_type="access")
        return AuthService._session_from_payload(payload)

    @staticmethod
    def list_sessions(user_id: int):
        sessions = UserSession.where(user_id=user_id, revoked_at=None).order_by(
            "-last_used_at"
        ).get()
        return [session for session in sessions if session.is_valid()]

    @staticmethod
    def find_session(session_id: int, user_id: int) -> UserSession:
        session = UserSession.find(session_id)
        if session is None or session.user_id != user_id:
            raise UnauthorizedError("Session not found", code="session_not_found")
        return session

    @staticmethod
    def revoke_session(session: UserSession) -> None:
        if session.revoked_at is None:
            session.revoked_at = utcnow()
            session.save(update_fields=["revoked_at", "updated_at"])

    @staticmethod
    def revoke_all_sessions(user_id: int, *, except_session_id: Optional[int] = None) -> int:
        sessions = UserSession.where(user_id=user_id, revoked_at=None).get()
        now = utcnow()
        count = 0
        for session in sessions:
            if except_session_id is not None and session.id == except_session_id:
                continue
            session.revoked_at = now
            session.save(update_fields=["revoked_at", "updated_at"])
            count += 1
        return count

    @staticmethod
    def _subject(payload: dict) -> int:
        try:
            return int(payload.get("sub", ""))
        except (TypeError, ValueError) as exc:
            raise UnauthorizedError("Invalid token subject", code="invalid_token") from exc

    @staticmethod
    def _session_from_payload(payload: dict) -> UserSession:
        raw_session_id = payload.get("sid")
        try:
            session_id = int(raw_session_id)
        except (TypeError, ValueError) as exc:
            raise UnauthorizedError(
                "Token is missing a valid session", code="invalid_session"
            ) from exc

        session = UserSession.find(session_id)
        if session is None or not session.is_valid():
            raise UnauthorizedError(
                "Session has expired or been revoked", code="session_expired"
            )
        return session

    @staticmethod
    def _active_user(user_id: int) -> User:
        user = User.find(user_id)
        if user is None:
            raise UnauthorizedError("User no longer exists", code="user_not_found")
        if not user.is_active:
            raise UnauthorizedError("This account is disabled", code="account_disabled")
        return user


auth_service = AuthService()
