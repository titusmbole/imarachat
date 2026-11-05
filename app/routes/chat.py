"""P2P chat and message routes.

Sending and acknowledging messages happens over Socket.IO (MSG_SEND /
MSG_READ). These routes cover opening chats and loading history.
"""

import asyncio
from typing import List, Optional

from fastapi import APIRouter, Depends, Query, status

from app.controllers import chat_controller
from app.models import User
from app.realtime.server import (
    add_user_to_chat_room,
    broadcast_read_cursor,
    close_chat_room,
    emit_message_sent,
    emit_read_updates,
    enqueue_message_delivery,
)
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
from app.shared.dependencies import get_current_user

router = APIRouter(prefix="/chats", tags=["chats"])


@router.post(
    "",
    response_model=ChatResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Open the one-to-one chat with another user",
)
async def create_chat(
    payload: ChatCreate, current_user: User = Depends(get_current_user)
) -> ChatResponse:
    mine, theirs = await asyncio.to_thread(
        chat_controller.create_chat, current_user, payload
    )
    await add_user_to_chat_room(current_user.id, mine.id, chat=mine.model_dump(mode="json"))
    await add_user_to_chat_room(payload.user_id, theirs.id, chat=theirs.model_dump(mode="json"))
    return mine


@router.get("", response_model=List[ChatResponse], summary="List my chats")
def list_chats(current_user: User = Depends(get_current_user)) -> List[ChatResponse]:
    return chat_controller.list_chats(current_user)


@router.get("/{chat_id}", response_model=ChatResponse, summary="Get a chat")
def get_chat(
    chat_id: int, current_user: User = Depends(get_current_user)
) -> ChatResponse:
    return chat_controller.get_chat(current_user, chat_id)


@router.delete("/{chat_id}", summary="Delete a chat for both users")
async def delete_chat(
    chat_id: int, current_user: User = Depends(get_current_user)
) -> dict:
    await asyncio.to_thread(chat_controller.delete_chat, current_user, chat_id)
    await close_chat_room(chat_id)
    return {"status": "ok", "chat_id": chat_id, "chat_deleted": True}


@router.get(
    "/{chat_id}/messages",
    response_model=MessagePage,
    summary="List messages (newest page first, returned oldest-to-newest)",
)
def list_messages(
    chat_id: int,
    before_id: Optional[int] = Query(default=None, gt=0),
    limit: int = Query(default=30, ge=1, le=100),
    current_user: User = Depends(get_current_user),
) -> MessagePage:
    return chat_controller.list_messages(
        current_user, chat_id, before_id=before_id, limit=limit
    )


@router.post(
    "/{chat_id}/messages",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Send a message over HTTP (legacy; prefer Socket.IO MSG_SEND)",
)
async def send_message(
    chat_id: int,
    payload: MessageCreate,
    current_user: User = Depends(get_current_user),
) -> MessageResponse:
    response = await asyncio.to_thread(
        chat_controller.send_message, current_user, chat_id, payload
    )
    await emit_message_sent(current_user.id, response.model_dump(mode="json"))
    await enqueue_message_delivery(response.id)
    return response


@router.post(
    "/{chat_id}/read",
    response_model=ReadReceipt,
    summary="Mark messages as read (legacy; prefer Socket.IO MSG_READ)",
)
async def mark_read(
    chat_id: int,
    payload: MarkReadRequest,
    current_user: User = Depends(get_current_user),
) -> ReadReceipt:
    receipt, updates = await asyncio.to_thread(
        chat_controller.mark_read, current_user, chat_id, payload
    )
    await broadcast_read_cursor(chat_id, receipt.model_dump(mode="json"))
    await emit_read_updates(updates)
    return receipt


@router.patch(
    "/{chat_id}/messages/{message_id}",
    response_model=MessageResponse,
    summary="Edit your message",
)
def edit_message(
    chat_id: int,
    message_id: int,
    payload: MessageEdit,
    current_user: User = Depends(get_current_user),
) -> MessageResponse:
    return chat_controller.edit_message(current_user, chat_id, message_id, payload)


@router.delete(
    "/{chat_id}/messages/{message_id}",
    response_model=MessageResponse,
    summary="Soft-delete your message",
)
def delete_message(
    chat_id: int,
    message_id: int,
    current_user: User = Depends(get_current_user),
) -> MessageResponse:
    return chat_controller.delete_message(current_user, chat_id, message_id)
