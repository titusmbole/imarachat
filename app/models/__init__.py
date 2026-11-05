"""ORM models.

Importing this package registers every model with DoveORM. Foreign keys use
string model names and are resolved lazily, so the import order below is only
for readability.
"""

from app import database  # noqa: F401  (configures DoveORM before models load)
from app.models.user import User
from app.models.chat import Chat, ChatParticipant, Message, MessageAttachment
from app.models.user_session import UserSession

__all__ = [
    "Chat",
    "ChatParticipant",
    "Message",
    "MessageAttachment",
    "User",
    "UserSession",
]
