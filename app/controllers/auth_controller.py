"""Auth controllers: turn service results into API responses."""

from typing import Optional

from fastapi import Request

from app.models import User, UserSession
from app.schemas.auth import (
    AuthResponse,
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    SessionResponse,
    TokenPair,
    UserResponse,
)
from app.services.auth_service import auth_service
from app.shared.security import access_token_expires_in


def _client_meta(request: Request) -> dict:
    return {
        "ip_address": request.client.host if request.client else None,
        "user_agent": request.headers.get("user-agent"),
        "device_name": request.headers.get("x-device-name"),
    }


def _auth_response(user: User, session: UserSession) -> AuthResponse:
    access_token, refresh_token = auth_service.issue_tokens(user, session)
    return AuthResponse(
        user=UserResponse.from_model(user),
        tokens=TokenPair(
            access_token=access_token,
            refresh_token=refresh_token,
            expires_in=access_token_expires_in(),
            session_id=session.id,
        ),
    )


def register(payload: RegisterRequest, request: Request) -> AuthResponse:
    user, session = auth_service.register(payload, **_client_meta(request))
    return _auth_response(user, session)


def login(payload: LoginRequest, request: Request) -> AuthResponse:
    user, session = auth_service.authenticate(payload, **_client_meta(request))
    return _auth_response(user, session)


def refresh(payload: RefreshRequest) -> AuthResponse:
    user, session = auth_service.refresh(payload.refresh_token)
    return _auth_response(user, session)


def me(current_user: User) -> UserResponse:
    return UserResponse.from_model(current_user)


def logout(current_session: UserSession) -> dict:
    auth_service.revoke_session(current_session)
    return {"status": "ok"}


def list_sessions(
    current_user: User, current_session: Optional[UserSession] = None
) -> list:
    sessions = auth_service.list_sessions(current_user.id)
    return [
        SessionResponse.from_model(
            session,
            is_current=current_session is not None and session.id == current_session.id,
        )
        for session in sessions
    ]


def revoke_session(current_user: User, session_id: int) -> dict:
    session = auth_service.find_session(session_id, current_user.id)
    auth_service.revoke_session(session)
    return {"status": "ok"}
