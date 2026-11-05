"""Chat controllers: turn service results into API responses."""

from typing import List, Optional, Tuple

from app.models import User
from app.schemas.chat import (
    ChatCreate,
    ChatResponse,
    MarkReadRequest,
    MessageCreate,
    MessageEdit,
    MessagePage,
    MessageResponse,
    ReadReceipt,
)
from app.services.chat_service import chat_service
from app.shared.utils import utcnow


def _chat_response(chat, user_id: int) -> ChatResponse:
    return ChatResponse.from_context(**chat_service.chat_context(chat, user_id))


def create_chat(current_user: User, payload: ChatCreate) -> Tuple[ChatResponse, ChatResponse]:
    """Return the chat as seen by the creator and by the peer."""
    chat = chat_service.create_chat(current_user, payload.user_id)
    return (
        _chat_response(chat, current_user.id),
        _chat_response(chat, payload.user_id),
    )


def list_chats(current_user: User) -> List[ChatResponse]:
    return [
        ChatResponse.from_context(**context)
        for context in chat_service.list_chats(current_user.id)
    ]


def get_chat(current_user: User, chat_id: int) -> ChatResponse:
    chat, _participant = chat_service.require_membership(chat_id, current_user.id)
    return _chat_response(chat, current_user.id)


def delete_chat(current_user: User, chat_id: int) -> List[int]:
    return chat_service.delete_chat(current_user.id, chat_id)


def list_messages(
    current_user: User,
    chat_id: int,
    *,
    before_id: Optional[int] = None,
    limit: int = 30,
) -> MessagePage:
    messages, has_more, next_before_id = chat_service.list_messages(
        current_user.id, chat_id, before_id=before_id, limit=limit
    )
    return MessagePage(
        items=[MessageResponse.from_model(message) for message in messages],
        has_more=has_more,
        next_before_id=next_before_id,
    )


def send_message(
    current_user: User, chat_id: int, payload: MessageCreate
) -> MessageResponse:
    message, _created = chat_service.create_message(current_user, chat_id, payload)
    return MessageResponse.from_model(message)


def mark_read(
    current_user: User, chat_id: int, payload: MarkReadRequest
) -> Tuple[ReadReceipt, List[dict]]:
    participant, message_id, updates = chat_service.mark_read(
        current_user.id, chat_id, payload.message_id
    )
    receipt = ReadReceipt(
        chat_id=chat_id,
        user_id=current_user.id,
        message_id=message_id,
        read_at=participant.last_read_at or utcnow(),
    )
    return receipt, updates


def edit_message(
    current_user: User, chat_id: int, message_id: int, payload: MessageEdit
) -> MessageResponse:
    message = chat_service.edit_message(
        current_user.id, chat_id, message_id, payload
    )
    return MessageResponse.from_model(message)


def delete_message(current_user: User, chat_id: int, message_id: int) -> MessageResponse:
    message = chat_service.delete_message(current_user.id, chat_id, message_id)
    return MessageResponse.from_model(message)
