"""User directory controllers."""

from typing import Optional

from app.models import User
from app.schemas.chat import UserDirectory, UserSummary
from app.services.user_service import user_service


def discover(
    current_user: User, *, limit: int = 5, q: Optional[str] = None, sort: str = "recent"
) -> UserDirectory:
    users, total = user_service.discover(current_user.id, limit=limit, q=q, sort=sort)
    return UserDirectory(
        items=[UserSummary.from_model(user) for user in users],
        total=total,
    )
