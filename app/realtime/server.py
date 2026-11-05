"""Socket.IO server and realtime chat events."""

import asyncio
import logging
from typing import Optional

import socketio
from pydantic import ValidationError as PydanticValidationError

from app.models import User
from app.schemas.chat import (
    MessageEdit,
    MessageResponse,
    MessageStatusUpdate,
    ReadReceipt,
    SocketChatEvent,
    SocketMessageDelete,
    SocketMessageEdit,
    SocketMessageSend,
    SocketReadEvent,
)
from app.services.auth_service import auth_service
from app.services.chat_service import chat_service
from app.settings import settings
from app.shared.exceptions import AppError, UnauthorizedError
from app.shared.utils import utcnow

logger = logging.getLogger("imarachat.socketio")

_cors = "*" if settings.cors_origins == ["*"] else settings.cors_origins

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=_cors,
    logger=False,
    engineio_logger=False,
)


class PresenceManager:
    """Tracks which users have at least one live Socket.IO connection."""

    def __init__(self) -> None:
        self._connections: dict = {}

    def add(self, user_id: int, sid: str) -> bool:
        """Add a connection. Returns True when the user just came online."""
        sids = self._connections.setdefault(user_id, set())
        was_offline = not sids
        sids.add(sid)
        return was_offline

    def remove(self, user_id: int, sid: str) -> bool:
        """Remove a connection. Returns True when the user went offline."""
        sids = self._connections.get(user_id)
        if not sids:
            return False
        sids.discard(sid)
        if not sids:
            self._connections.pop(user_id, None)
            return True
        return False

    def is_online(self, user_id: int) -> bool:
        return bool(self._connections.get(user_id))

    def sids(self, user_id: int) -> list:
        return list(self._connections.get(user_id, ()))


presence = PresenceManager()

# New messages are handed to this in-memory queue after the sender receives
# MSG_SENT. The worker checks whether the recipient is online. Messages for an
# offline recipient stay in the persistent queue (messages.status == "sent")
# and are delivered when they reconnect.
_delivery_queue: asyncio.Queue = asyncio.Queue()
_delivery_worker_task: Optional[asyncio.Task] = None
_DELIVERY_BATCH_SIZE = 100


# ── delivery queue ─────────────────────────────────────────────────────────


def start_delivery_worker() -> None:
    """Start the Socket.IO message delivery worker (idempotent)."""
    global _delivery_worker_task
    if _delivery_worker_task is None or _delivery_worker_task.done():
        _delivery_worker_task = asyncio.create_task(_delivery_worker())
        logger.info("message delivery worker started")


async def stop_delivery_worker() -> None:
    """Cancel the delivery worker during application shutdown."""
    global _delivery_worker_task
    task = _delivery_worker_task
    _delivery_worker_task = None
    if task is not None and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


async def enqueue_message_delivery(message_id: int) -> None:
    """Queue a message for immediate/on-connect delivery."""
    start_delivery_worker()
    await _delivery_queue.put(message_id)


async def _delivery_worker() -> None:
    while True:
        message_id = await _delivery_queue.get()
        try:
            await _deliver_message(message_id)
        except Exception:  # pragma: no cover - keep the worker alive
            logger.exception("message delivery failed message_id=%s", message_id)
        finally:
            _delivery_queue.task_done()


# ── helpers ────────────────────────────────────────────────────────────────


def _chat_room(chat_id: int) -> str:
    return f"chat:{chat_id}"


def _user_room(user_id: int) -> str:
    return f"user:{user_id}"


def _extract_token(auth, environ) -> Optional[str]:
    token = None
    if isinstance(auth, dict):
        token = auth.get("token") or auth.get("access_token")
    elif isinstance(auth, str):
        token = auth
    if not token:
        header = environ.get("HTTP_AUTHORIZATION", "")
        if isinstance(header, bytes):
            header = header.decode("latin-1")
        if header.lower().startswith("bearer "):
            token = header[7:]
    if isinstance(token, str):
        token = token.strip()
        return token or None
    return None


async def _socket_session(sid: str) -> dict:
    try:
        data = await sio.get_session(sid)
    except KeyError as exc:
        raise UnauthorizedError(
            "Socket session not found", code="not_authenticated"
        ) from exc
    if not data or "user_id" not in data:
        raise UnauthorizedError("Socket session not found", code="not_authenticated")
    return data


def _user_payload(session: dict) -> dict:
    return {
        "id": session["user_id"],
        "name": session.get("name"),
        "username": session.get("username"),
    }


async def _emit_error(sid: str, exc: Exception) -> dict:
    if isinstance(exc, AppError):
        payload = {"code": exc.code, "message": exc.message}
    elif isinstance(exc, PydanticValidationError):
        payload = {
            "code": "validation_error",
            "message": "Invalid event payload",
            "details": [
                {
                    "type": error.get("type"),
                    "loc": list(error.get("loc", ())),
                    "msg": error.get("msg"),
                }
                for error in exc.errors()
            ],
        }
    else:
        logger.exception("Unhandled Socket.IO error")
        payload = {"code": "internal_error", "message": "Something went wrong"}

    await sio.emit("chat:error", payload, to=sid)
    return {"ok": False, "error": payload}


async def _guarded(sid: str, handler, *args):
    try:
        return await handler(sid, *args)
    except (AppError, PydanticValidationError) as exc:
        return await _emit_error(sid, exc)
    except Exception as exc:  # pragma: no cover - defensive boundary
        return await _emit_error(sid, exc)


def _active_user(user_id: int) -> User:
    user = User.find(user_id)
    if user is None or not user.is_active:
        raise UnauthorizedError("User no longer exists", code="user_not_found")
    return user


def _create_message_sync(user_id: int, data: SocketMessageSend) -> tuple:
    user = _active_user(user_id)
    message, created = chat_service.create_message(user, data.chat_id, data)
    payload = MessageResponse.from_model(message).model_dump(mode="json")
    return payload, created


def _mark_read_sync(user_id: int, data: SocketReadEvent) -> tuple:
    participant, message_id, updates = chat_service.mark_read(
        user_id, data.chat_id, data.message_id
    )
    receipt = ReadReceipt(
        chat_id=data.chat_id,
        user_id=user_id,
        message_id=message_id,
        read_at=participant.last_read_at or utcnow(),
    ).model_dump(mode="json")
    return receipt, updates


def _edit_message_sync(user_id: int, data: SocketMessageEdit) -> dict:
    message = chat_service.edit_message(
        user_id, data.chat_id, data.message_id, MessageEdit(content=data.content)
    )
    return MessageResponse.from_model(message).model_dump(mode="json")


def _delete_message_sync(user_id: int, data: SocketMessageDelete) -> dict:
    message = chat_service.delete_message(user_id, data.chat_id, data.message_id)
    return MessageResponse.from_model(message).model_dump(mode="json")


def _message_payload(message) -> dict:
    return MessageResponse.from_model(message).model_dump(mode="json")


def _status_payload(update: dict) -> dict:
    return MessageStatusUpdate(**update).model_dump(mode="json")


async def emit_message_sent(user_id: int, message_payload: dict) -> None:
    """Acknowledge a persisted message to the sender (single tick)."""
    await sio.emit(
        "MSG_SENT",
        {
            "chat_id": message_payload["chat_id"],
            "message_id": message_payload["id"],
            "client_message_id": message_payload.get("client_message_id"),
            "sender_id": user_id,
            "recipient_id": message_payload.get("recipient_id"),
            "status": message_payload.get("status", "sent"),
            "delivered_at": message_payload.get("delivered_at"),
            "read_at": message_payload.get("read_at"),
            "message": message_payload,
        },
        room=_user_room(user_id),
    )


async def emit_read_updates(updates: list) -> list:
    """Notify the sender that the recipient read their messages (blue ticks)."""
    payloads = []
    for update in updates:
        payload = _status_payload(update)
        payloads.append(payload)
        sender_id = update.get("sender_id")
        if sender_id:
            await sio.emit("MSG_READ", payload, room=_user_room(sender_id))
    return payloads


async def broadcast_read_cursor(chat_id: int, receipt: dict) -> None:
    """Broadcast the read cursor for clients showing "read up to" state."""
    await sio.emit("message:read", receipt, room=_chat_room(chat_id))


async def _deliver(message) -> bool:
    """Push one message to its online recipient and ack the sender.

    Returns True when the message moved from sent -> delivered.
    """
    recipient_id = message.recipient_id
    if recipient_id is None or not presence.is_online(recipient_id):
        return False

    # Recipient has a live socket: emit the message, then mark it delivered
    # and tell the sender (double tick).
    await sio.emit(
        "MSG_RECEIVED",
        {"chat_id": message.chat_id, "message": _message_payload(message)},
        room=_user_room(recipient_id),
    )
    update = await asyncio.to_thread(
        chat_service.mark_delivered, message.id, recipient_id
    )
    if update is None:
        return False
    if update.get("sender_id"):
        await sio.emit(
            "MSG_DELIVERED",
            _status_payload(update),
            room=_user_room(update["sender_id"]),
        )
    return True


async def _deliver_message(message_id: int) -> None:
    """Delivery-queue job: deliver one message if its recipient is online."""
    message = await asyncio.to_thread(chat_service.get_message_for_delivery, message_id)
    if message is None or message.status != "sent":
        return
    await _deliver(message)


async def deliver_pending_for_user(user_id: int) -> None:
    """Flush the persistent delivery queue for a user who just connected."""
    while presence.is_online(user_id):
        messages = await asyncio.to_thread(
            chat_service.get_pending_messages, user_id, _DELIVERY_BATCH_SIZE
        )
        if not messages:
            return

        progress = False
        for message in messages:
            if not presence.is_online(user_id):
                return
            if await _deliver(message):
                progress = True

        if not progress or len(messages) < _DELIVERY_BATCH_SIZE:
            return


# ── room membership helpers used by REST routes ────────────────────────────


async def add_user_to_chat_room(user_id: int, chat_id: int, chat=None) -> None:
    """Subscribe a user's live sockets to a newly opened chat."""
    for sid in presence.sids(user_id):
        await sio.enter_room(sid, _chat_room(chat_id))
    event = {"chat_id": chat_id}
    if chat is not None:
        event["chat"] = chat
    await sio.emit("chat:added", event, room=_user_room(user_id))


async def close_chat_room(chat_id: int) -> None:
    """Notify everyone and detach all sockets from a deleted chat."""
    await sio.emit("chat:deleted", {"chat_id": chat_id}, room=_chat_room(chat_id))
    await sio.close_room(_chat_room(chat_id))


# ── connection lifecycle ───────────────────────────────────────────────────


@sio.event
async def connect(sid, environ, auth):
    token = _extract_token(auth, environ)
    if not token:
        raise ConnectionRefusedError("Authentication required")

    try:
        user, session, _payload = await asyncio.to_thread(
            auth_service.resolve_access_token, token
        )
    except AppError as exc:
        raise ConnectionRefusedError(exc.message) from exc

    await sio.save_session(
        sid,
        {
            "user_id": user.id,
            "name": user.name,
            "username": user.username,
            "session_id": session.id if session else None,
        },
    )
    await sio.enter_room(sid, _user_room(user.id))

    chat_ids = await asyncio.to_thread(chat_service.get_chat_ids_for_user, user.id)
    for chat_id in chat_ids:
        await sio.enter_room(sid, _chat_room(chat_id))

    just_came_online = presence.add(user.id, sid)
    if just_came_online:
        event = {"user": _user_payload(await _socket_session(sid))}
        for chat_id in chat_ids:
            await sio.emit(
                "presence:online",
                {**event, "chat_id": chat_id},
                room=_chat_room(chat_id),
                skip_sid=sid,
            )

    # Deliver anything that was queued while this user was offline.
    await deliver_pending_for_user(user.id)

    logger.info(
        "socket connected sid=%s user=%s session=%s chats=%s",
        sid,
        user.id,
        session.id if session else None,
        len(chat_ids),
    )


@sio.event
async def disconnect(sid, reason=None):
    try:
        data = await _socket_session(sid)
    except AppError:
        return

    user_id = data["user_id"]
    went_offline = presence.remove(user_id, sid)
    logger.info("socket disconnected sid=%s user=%s reason=%s", sid, user_id, reason)

    if went_offline:
        chat_ids = await asyncio.to_thread(chat_service.get_chat_ids_for_user, user_id)
        event = {"user": _user_payload(data)}
        for chat_id in chat_ids:
            await sio.emit(
                "presence:offline",
                {**event, "chat_id": chat_id},
                room=_chat_room(chat_id),
                skip_sid=sid,
            )


# ── chat room events ───────────────────────────────────────────────────────


async def _chat_join(sid: str, raw):
    data = SocketChatEvent(**(raw or {}))
    session = await _socket_session(sid)
    await asyncio.to_thread(
        chat_service.require_membership, data.chat_id, session["user_id"]
    )
    await sio.enter_room(sid, _chat_room(data.chat_id))
    await sio.emit(
        "presence:online",
        {"chat_id": data.chat_id, "user": _user_payload(session)},
        room=_chat_room(data.chat_id),
        skip_sid=sid,
    )
    return {"ok": True, "chat_id": data.chat_id}


async def _chat_leave(sid: str, raw):
    data = SocketChatEvent(**(raw or {}))
    session = await _socket_session(sid)
    await asyncio.to_thread(
        chat_service.require_membership, data.chat_id, session["user_id"]
    )
    await sio.leave_room(sid, _chat_room(data.chat_id))
    return {"ok": True, "chat_id": data.chat_id}


@sio.on("chat:join")
async def chat_join(sid, data):
    return await _guarded(sid, _chat_join, data)


@sio.on("chat:leave")
async def chat_leave(sid, data):
    return await _guarded(sid, _chat_leave, data)


# ── message events ─────────────────────────────────────────────────────────


async def _message_send(sid: str, raw):
    data = SocketMessageSend(**(raw or {}))
    session = await _socket_session(sid)

    payload, created = await asyncio.to_thread(
        _create_message_sync, session["user_id"], data
    )
    await sio.enter_room(sid, _chat_room(data.chat_id))

    # Sequence: persist -> MSG_SENT to sender -> queue delivery.
    await emit_message_sent(session["user_id"], payload)
    await enqueue_message_delivery(payload["id"])

    return {
        "ok": True,
        "message": payload,
        "status": payload.get("status", "sent"),
        "duplicate": not created,
    }


async def _message_read(sid: str, raw):
    data = SocketReadEvent(**(raw or {}))
    session = await _socket_session(sid)
    receipt, updates = await asyncio.to_thread(
        _mark_read_sync, session["user_id"], data
    )
    await broadcast_read_cursor(data.chat_id, receipt)
    status_updates = await emit_read_updates(updates)
    return {"ok": True, **receipt, "status_updates": status_updates}


async def _message_edit(sid: str, raw):
    data = SocketMessageEdit(**(raw or {}))
    session = await _socket_session(sid)
    payload = await asyncio.to_thread(_edit_message_sync, session["user_id"], data)
    await sio.emit(
        "message:updated",
        {"chat_id": data.chat_id, "message": payload},
        room=_chat_room(data.chat_id),
    )
    return {"ok": True, "message": payload}


async def _message_delete(sid: str, raw):
    data = SocketMessageDelete(**(raw or {}))
    session = await _socket_session(sid)
    payload = await asyncio.to_thread(_delete_message_sync, session["user_id"], data)
    await sio.emit(
        "message:deleted",
        {"chat_id": data.chat_id, "message": payload},
        room=_chat_room(data.chat_id),
    )
    return {"ok": True, "message": payload}


@sio.on("message:send")
async def message_send(sid, data):
    return await _guarded(sid, _message_send, data)


@sio.on("MSG_SEND")
async def message_send_status_alias(sid, data):
    return await _guarded(sid, _message_send, data)


@sio.on("message:read")
async def message_read(sid, data):
    return await _guarded(sid, _message_read, data)


@sio.on("MSG_READ")
async def message_read_status_alias(sid, data):
    return await _guarded(sid, _message_read, data)


@sio.on("message:edit")
async def message_edit(sid, data):
    return await _guarded(sid, _message_edit, data)


@sio.on("message:delete")
async def message_delete(sid, data):
    return await _guarded(sid, _message_delete, data)


# ── typing events ──────────────────────────────────────────────────────────


async def _typing(sid: str, raw, is_typing: bool):
    data = SocketChatEvent(**(raw or {}))
    session = await _socket_session(sid)
    await asyncio.to_thread(
        chat_service.require_membership, data.chat_id, session["user_id"]
    )
    await sio.emit(
        "typing:start" if is_typing else "typing:stop",
        {"chat_id": data.chat_id, "user": _user_payload(session)},
        room=_chat_room(data.chat_id),
        skip_sid=sid,
    )
    return {"ok": True, "chat_id": data.chat_id}


@sio.on("typing:start")
async def typing_start(sid, data):
    return await _guarded(sid, _typing, data, True)


@sio.on("typing:stop")
async def typing_stop(sid, data):
    return await _guarded(sid, _typing, data, False)


# ── presence query ─────────────────────────────────────────────────────────


async def _presence_check(sid: str, raw):
    data = SocketChatEvent(**(raw or {}))
    session = await _socket_session(sid)
    await asyncio.to_thread(
        chat_service.require_membership, data.chat_id, session["user_id"]
    )
    member_ids = await asyncio.to_thread(
        chat_service.get_member_user_ids, data.chat_id
    )
    return {
        "ok": True,
        "chat_id": data.chat_id,
        "online_user_ids": [user_id for user_id in member_ids if presence.is_online(user_id)],
    }


@sio.on("presence:check")
async def presence_check(sid, data):
    return await _guarded(sid, _presence_check, data)
