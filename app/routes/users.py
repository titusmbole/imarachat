"""User directory routes."""

from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query

from app.controllers import users_controller
from app.models import User
from app.schemas.chat import UserDirectory
from app.shared.dependencies import get_current_user

router = APIRouter(prefix="/users", tags=["users"])


@router.get(
    "/discover",
    response_model=UserDirectory,
    summary="People you can start a chat with",
)
def discover(
    limit: int = Query(default=5, ge=1, le=500),
    q: Optional[str] = Query(default=None, max_length=100, description="Search name or username"),
    sort: Literal["recent", "name"] = Query(default="recent"),
    current_user: User = Depends(get_current_user),
) -> UserDirectory:
    q = q.strip() if q else None
    return users_controller.discover(current_user, limit=limit, q=q or None, sort=sort)
