"""P2P chat request/response schemas and socket event payloads."""

from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from app.services.upload_service import is_media_url

MessageType = Literal["text", "image", "file", "audio", "video", "system"]
MessageStatus = Literal["sent", "delivered", "read"]


class UserSummary(BaseModel):
    """Public user data that is safe to show to the other chat participant."""

    id: int
    name: str
    username: str

    @classmethod
    def from_model(cls, user) -> "UserSummary":
        return cls(id=user.id, name=user.name, username=user.username)


class UserDirectory(BaseModel):
    """A page of people to chat with, plus how many exist in total."""

    items: List[UserSummary]
    total: int = 0


class AttachmentInput(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    file_name: Optional[str] = Field(default=None, max_length=255)
    mime_type: Optional[str] = Field(default=None, max_length=120)
    file_size: Optional[int] = Field(default=None, ge=0)

    @field_validator("url")
    @classmethod
    def must_be_uploaded_file(cls, value: str) -> str:
        # Only files from POST /uploads; never javascript:, data: or other sites.
        if not is_media_url(value):
            raise ValueError("Attachments must be uploaded through /uploads first")
        return value


class AttachmentResponse(BaseModel):
    id: int
    url: str
    file_name: Optional[str] = None
    mime_type: Optional[str] = None
    file_size: Optional[int] = None
    created_at: Optional[datetime] = None

    @classmethod
    def from_model(cls, attachment) -> "AttachmentResponse":
        return cls(
            id=attachment.id,
            url=attachment.url,
            file_name=attachment.file_name,
            mime_type=attachment.mime_type,
            file_size=attachment.file_size,
            created_at=attachment.created_at,
        )


class MessageCreate(BaseModel):
    content: Optional[str] = Field(default=None, max_length=10000)
    type: MessageType = "text"
    reply_to_id: Optional[int] = Field(default=None, gt=0)
    client_message_id: Optional[str] = Field(default=None, max_length=100)
    attachments: List[AttachmentInput] = Field(default_factory=list, max_length=10)

    @field_validator("content", "client_message_id")
    @classmethod
    def strip_optional_text(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @model_validator(mode="after")
    def validate_message(self) -> "MessageCreate":
        if self.type == "text" and not self.content:
            raise ValueError("A text message needs non-empty content")
        if self.type in ("image", "file", "audio", "video") and not self.attachments:
            raise ValueError("This message type needs at least one attachment")
        return self


class MessageEdit(BaseModel):
    content: str = Field(min_length=1, max_length=10000)

    @field_validator("content")
    @classmethod
    def strip_content(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Content cannot be empty")
        return value


class MessageResponse(BaseModel):
    id: int
    chat_id: int
    sender: Optional[UserSummary] = None
    recipient_id: Optional[int] = None
    type: str
    content: Optional[str] = None
    reply_to_id: Optional[int] = None
    client_message_id: Optional[str] = None
    status: MessageStatus = "sent"
    delivered_at: Optional[datetime] = None
    read_at: Optional[datetime] = None
    attachments: List[AttachmentResponse] = Field(default_factory=list)
    edited_at: Optional[datetime] = None
    deleted_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    @classmethod
    def from_model(cls, message) -> "MessageResponse":
        sender = message.sender
        return cls(
            id=message.id,
            chat_id=message.chat_id,
            sender=UserSummary.from_model(sender) if sender else None,
            recipient_id=message.recipient_id,
            type=message.type,
            content=message.content,
            reply_to_id=message.reply_to_id,
            client_message_id=message.client_message_id,
            status=message.status or "sent",
            delivered_at=message.delivered_at,
            read_at=message.read_at,
            attachments=[AttachmentResponse.from_model(a) for a in message.attachments],
            edited_at=message.edited_at,
            deleted_at=message.deleted_at,
            created_at=message.created_at,
            updated_at=message.updated_at,
        )


class MessagePage(BaseModel):
    items: List[MessageResponse]
    has_more: bool = False
    next_before_id: Optional[int] = None


class ChatCreate(BaseModel):
    """Open (or reuse) the one-to-one chat with another user."""

    user_id: int = Field(gt=0)


class ChatResponse(BaseModel):
    id: int
    peer: Optional[UserSummary] = None
    last_message_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    last_message: Optional[MessageResponse] = None
    unread_count: int = 0
    is_pinned: bool = False
    muted_until: Optional[datetime] = None

    @classmethod
    def from_context(
        cls,
        *,
        chat,
        membership,
        peer,
        last_message,
        unread_count: int,
    ) -> "ChatResponse":
        return cls(
            id=chat.id,
            peer=UserSummary.from_model(peer) if peer else None,
            last_message_at=chat.last_message_at,
            created_at=chat.created_at,
            updated_at=chat.updated_at,
            last_message=MessageResponse.from_model(last_message) if last_message else None,
            unread_count=unread_count,
            is_pinned=bool(membership.is_pinned) if membership else False,
            muted_until=membership.muted_until if membership else None,
        )


class MarkReadRequest(BaseModel):
    message_id: Optional[int] = Field(default=None, gt=0)


class ReadReceipt(BaseModel):
    chat_id: int
    user_id: int
    message_id: Optional[int] = None
    read_at: datetime


class MessageStatusUpdate(BaseModel):
    """Payload emitted for ``MSG_SENT`` / ``MSG_DELIVERED`` / ``MSG_READ``."""

    chat_id: int
    message_id: int
    client_message_id: Optional[str] = None
    sender_id: Optional[int] = None
    recipient_id: Optional[int] = None
    status: MessageStatus
    delivered_at: Optional[datetime] = None
    read_at: Optional[datetime] = None


# ── Socket.IO payloads ──────────────────────────────────────────────────────


class SocketMessageSend(MessageCreate):
    chat_id: int = Field(gt=0)


class SocketChatEvent(BaseModel):
    chat_id: int = Field(gt=0)


class SocketReadEvent(SocketChatEvent):
    message_id: Optional[int] = Field(default=None, gt=0)


class SocketMessageEdit(SocketChatEvent):
    message_id: int = Field(gt=0)
    content: str = Field(min_length=1, max_length=10000)

    @field_validator("content")
    @classmethod
    def strip_content(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Content cannot be empty")
        return value


class SocketMessageDelete(SocketChatEvent):
    message_id: int = Field(gt=0)
