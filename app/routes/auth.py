"""Auth routes."""

from typing import List

from fastapi import APIRouter, Depends, Request, status

from app.controllers import auth_controller
from app.models import User, UserSession
from app.schemas.auth import (
    AuthResponse,
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    SessionResponse,
    UserResponse,
)
from app.shared.dependencies import get_current_session, get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post(
    "/register",
    response_model=AuthResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create an account",
)
def register(payload: RegisterRequest, request: Request) -> AuthResponse:
    return auth_controller.register(payload, request)


@router.post("/login", response_model=AuthResponse, summary="Log in")
def login(payload: LoginRequest, request: Request) -> AuthResponse:
    return auth_controller.login(payload, request)


@router.post("/refresh", response_model=AuthResponse, summary="Rotate tokens")
def refresh(payload: RefreshRequest) -> AuthResponse:
    return auth_controller.refresh(payload)


@router.post("/logout", summary="Revoke the current session")
def logout(current_session: UserSession = Depends(get_current_session)) -> dict:
    return auth_controller.logout(current_session)


@router.get(
    "/sessions",
    response_model=List[SessionResponse],
    summary="List active device sessions",
)
def list_sessions(
    current_user: User = Depends(get_current_user),
    current_session: UserSession = Depends(get_current_session),
) -> List[SessionResponse]:
    return auth_controller.list_sessions(current_user, current_session)


@router.delete(
    "/sessions/{session_id}",
    summary="Revoke one of your device sessions",
)
def revoke_session(
    session_id: int,
    current_user: User = Depends(get_current_user),
) -> dict:
    return auth_controller.revoke_session(current_user, session_id)


@router.get("/me", response_model=UserResponse, summary="Current user")
def me(current_user: User = Depends(get_current_user)) -> UserResponse:
    return auth_controller.me(current_user)
