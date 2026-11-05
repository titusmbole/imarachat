"""User directory business logic."""

from typing import List, Optional, Tuple

from doveorm import Q

from app.models import User

SORTS = {"recent": "-created_at", "name": "name"}


class UserService:
    @staticmethod
    def discover(
        current_user_id: int,
        *,
        limit: int = 5,
        q: Optional[str] = None,
        sort: str = "recent",
    ) -> Tuple[List[User], int]:
        """Return active users the current user can start a chat with.

        Gives back up to ``limit`` users plus the total number matching, so
        clients can show a few avatars and a "+N more" hint. ``q`` filters by
        name or username; ``sort`` is ``recent`` (newest first) or ``name``.
        """
        query = User.where(is_active=True).exclude(id=current_user_id)
        if q:
            query = query.filter(Q(name__icontains=q) | Q(username__icontains=q))
        total = query.count()
        users = query.order_by(SORTS.get(sort, SORTS["recent"])).limit(limit).get()
        return list(users), total


user_service = UserService()
