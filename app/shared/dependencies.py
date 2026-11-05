"""Reusable FastAPI dependencies."""

from typing import Optional

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.models import User, UserSession
from app.services.auth_service import auth_service
from app.shared.exceptions import UnauthorizedError

bearer_scheme = HTTPBearer(auto_error=False)


def _credentials(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> str:
    if credentials is None or not credentials.credentials:
        raise UnauthorizedError("Authentication required", code="not_authenticated")
    return credentials.credentials


def get_current_user(
    token: str = Depends(_credentials),
) -> User:
    user, _session, _payload = auth_service.resolve_access_token(token)
    return user


def get_current_session(
    token: str = Depends(_credentials),
) -> UserSession:
    return auth_service.current_session(token)


CurrentUser = Depends(get_current_user)
CurrentSession = Depends(get_current_session)
