"""P2P chat and message business logic."""

from typing import List, Optional, Tuple

from app.database import db
from app.models import Chat, ChatParticipant, Message, MessageAttachment, User
from app.schemas.chat import MessageCreate, MessageEdit
from app.shared.exceptions import (
    BadRequestError,
    ForbiddenError,
    NotFoundError,
)
from app.shared.utils import unique_violation, utcnow

UNREAD_STATUSES = ["sent", "delivered"]


def _direct_key(user_a: int, user_b: int) -> str:
    return f"{min(user_a, user_b)}:{max(user_a, user_b)}"


def _status_update(message: Message) -> dict:
    return {
        "chat_id": message.chat_id,
        "message_id": message.id,
        "client_message_id": message.client_message_id,
        "sender_id": message.sender_id,
        "recipient_id": message.recipient_id,
        "status": message.status,
        "delivered_at": message.delivered_at,
        "read_at": message.read_at,
    }


class ChatService:
    # ── lookups / authorization ───────────────────────────────────────────

    @staticmethod
    def get_chat(chat_id: int) -> Chat:
        chat = Chat.find(chat_id)
        if chat is None:
            raise NotFoundError("Chat not found", code="chat_not_found")
        return chat

    @staticmethod
    def get_membership(chat_id: int, user_id: int) -> Optional[ChatParticipant]:
        return ChatParticipant.where(chat_id=chat_id, user_id=user_id).first()

    @staticmethod
    def require_membership(chat_id: int, user_id: int) -> Tuple[Chat, ChatParticipant]:
        chat = ChatService.get_chat(chat_id)
        participant = ChatService.get_membership(chat_id, user_id)
        if participant is None:
            # Do not reveal whether the chat exists to non-members.
            raise NotFoundError("Chat not found", code="chat_not_found")
        return chat, participant

    @staticmethod
    def get_chat_ids_for_user(user_id: int) -> List[int]:
        return [
            participant.chat_id
            for participant in ChatParticipant.where(user_id=user_id).get()
        ]

    @staticmethod
    def get_member_user_ids(chat_id: int) -> List[int]:
        return [
            participant.user_id
            for participant in ChatParticipant.where(chat_id=chat_id).get()
        ]

    @staticmethod
    def get_peer_id(chat_id: int, user_id: int) -> Optional[int]:
        """Return the other user in a P2P chat."""
        peer = (
            ChatParticipant.where(chat_id=chat_id)
            .exclude(user_id=user_id)
            .first()
        )
        return peer.user_id if peer is not None else None

    # ── chats ─────────────────────────────────────────────────────────────

    @staticmethod
    def create_chat(creator: User, target_id: int) -> Chat:
        """Open the one-to-one chat with another user (idempotent)."""
        if target_id == creator.id:
            raise BadRequestError(
                "You cannot start a chat with yourself", code="invalid_participant"
            )
        target = User.where(id=target_id, is_active=True).first()
        if target is None:
            raise BadRequestError(
                "User does not exist or is inactive", code="invalid_participant"
            )

        direct_key = _direct_key(creator.id, target_id)
        existing = Chat.where(direct_key=direct_key).first()
        if existing is not None:
            return existing

        try:
            with db().transaction():
                chat = Chat.create(created_by=creator.id, direct_key=direct_key)
                ChatParticipant.bulk_create(
                    [
                        ChatParticipant(chat_id=chat.id, user_id=creator.id),
                        ChatParticipant(chat_id=chat.id, user_id=target_id),
                    ]
                )
            return chat
        except Exception as exc:
            if unique_violation(exc):
                existing = Chat.where(direct_key=direct_key).first()
                if existing is not None:
                    return existing
            raise

    @staticmethod
    def delete_chat(user_id: int, chat_id: int) -> List[int]:
        """Delete a chat and its messages for both users.

        Returns the user ids that were in the chat so their sockets can be
        notified. Deleting frees the pair so a new chat can be opened later.
        """
        chat, _participant = ChatService.require_membership(chat_id, user_id)
        member_ids = ChatService.get_member_user_ids(chat_id)
        chat.delete()
        return member_ids

    # ── chat views ────────────────────────────────────────────────────────

    @staticmethod
    def unread_count(chat_id: int, user_id: int) -> int:
        return Message.where(
            chat_id=chat_id,
            recipient_id=user_id,
            deleted_at=None,
            status__in=UNREAD_STATUSES,
        ).count()

    @staticmethod
    def chat_context(chat: Chat, current_user_id: int) -> dict:
        membership = ChatService.get_membership(chat.id, current_user_id)
        peer_id = ChatService.get_peer_id(chat.id, current_user_id)
        last_message = (
            Message.where(chat_id=chat.id)
            .prefetch_related("sender", "attachments")
            .order_by("-id")
            .first()
        )
        return {
            "chat": chat,
            "membership": membership,
            "peer": User.find(peer_id) if peer_id else None,
            "last_message": last_message,
            "unread_count": ChatService.unread_count(chat.id, current_user_id),
        }

    @staticmethod
    def list_chats(current_user_id: int) -> List[dict]:
        participations = (
            ChatParticipant.where(user_id=current_user_id)
            .prefetch_related("chat")
            .get()
        )
        contexts = [
            ChatService.chat_context(participation.chat, current_user_id)
            for participation in participations
            if participation.chat is not None
        ]

        def sort_key(context):
            chat = context["chat"]
            timestamp = chat.last_message_at or chat.created_at
            return timestamp.timestamp() if timestamp else 0

        contexts.sort(key=sort_key, reverse=True)
        return contexts

    # ── messages ──────────────────────────────────────────────────────────

    @staticmethod
    def create_message(
        sender: User, chat_id: int, payload: MessageCreate
    ) -> Tuple[Message, bool]:
        chat, _participant = ChatService.require_membership(chat_id, sender.id)
        if payload.type == "system":
            raise BadRequestError(
                "System messages cannot be sent by clients", code="invalid_message_type"
            )

        recipient_id = ChatService.get_peer_id(chat_id, sender.id)
        if recipient_id is None:
            raise BadRequestError(
                "This chat has no recipient", code="recipient_not_found"
            )

        if payload.reply_to_id is not None:
            reply = Message.find(payload.reply_to_id)
            if reply is None or reply.chat_id != chat_id:
                raise BadRequestError(
                    "Reply target is not in this chat", code="invalid_reply"
                )

        if payload.client_message_id:
            existing = Message.where(
                chat_id=chat_id,
                sender_id=sender.id,
                client_message_id=payload.client_message_id,
            ).first()
            if existing is not None:
                return existing, False

        try:
            with db().transaction():
                message = Message.create(
                    chat_id=chat_id,
                    sender_id=sender.id,
                    recipient_id=recipient_id,
                    type=payload.type,
                    content=payload.content,
                    reply_to_id=payload.reply_to_id,
                    client_message_id=payload.client_message_id,
                    status="sent",
                )
                if payload.attachments:
                    MessageAttachment.bulk_create(
                        [
                            MessageAttachment(
                                message_id=message.id,
                                url=attachment.url,
                                file_name=attachment.file_name,
                                mime_type=attachment.mime_type,
                                file_size=attachment.file_size,
                            )
                            for attachment in payload.attachments
                        ]
                    )
                chat.last_message_at = message.created_at or utcnow()
                chat.save(update_fields=["last_message_at", "updated_at"])
            return message, True
        except Exception as exc:
            if payload.client_message_id and unique_violation(exc):
                existing = Message.where(
                    chat_id=chat_id,
                    sender_id=sender.id,
                    client_message_id=payload.client_message_id,
                ).first()
                if existing is not None:
                    return existing, False
            raise

    @staticmethod
    def list_messages(
        user_id: int,
        chat_id: int,
        *,
        before_id: Optional[int] = None,
        limit: int = 30,
    ) -> Tuple[List[Message], bool, Optional[int]]:
        ChatService.require_membership(chat_id, user_id)
        limit = max(1, min(limit, 100))
        query = (
            Message.where(chat_id=chat_id)
            .prefetch_related("sender", "attachments")
            .order_by("-id")
        )
        if before_id is not None:
            query = query.where(id__lt=before_id)

        rows = query.limit(limit + 1).get()
        has_more = len(rows) > limit
        rows = rows[:limit]
        rows.reverse()
        next_before_id = rows[0].id if has_more and rows else None
        return rows, has_more, next_before_id

    @staticmethod
    def get_message(chat_id: int, message_id: int) -> Message:
        message = Message.find(message_id)
        if message is None or message.chat_id != chat_id:
            raise NotFoundError("Message not found", code="message_not_found")
        return message

    # ── delivery status ───────────────────────────────────────────────────

    @staticmethod
    def mark_delivered(message_id: int, recipient_id: int) -> Optional[dict]:
        """Move a message from sent -> delivered.

        The conditional UPDATE makes this atomic, so a duplicate delivery job
        returns ``None`` instead of emitting a second MSG_DELIVERED.
        """
        now = utcnow()
        updated = Message.where(
            id=message_id, recipient_id=recipient_id, status="sent"
        ).update(status="delivered", delivered_at=now, updated_at=now)
        if not updated:
            return None
        message = Message.find(message_id)
        return _status_update(message) if message is not None else None

    @staticmethod
    def mark_read(
        user_id: int, chat_id: int, message_id: Optional[int] = None
    ) -> Tuple[ChatParticipant, Optional[int], List[dict]]:
        """Mark every message the user received up to ``message_id`` as read.

        Returns the participant, the read cursor and one status update per
        message that changed (used to emit MSG_READ to the sender).
        """
        _chat, participant = ChatService.require_membership(chat_id, user_id)

        if message_id is None:
            latest = Message.where(chat_id=chat_id).order_by("-id").first()
            target_id = latest.id if latest is not None else None
        else:
            target_id = ChatService.get_message(chat_id, message_id).id

        if target_id is None:
            return participant, None, []

        current_id = participant.last_read_message_id or 0
        read_through_id = max(target_id, current_id)
        now = utcnow()
        if read_through_id > current_id:
            participant.last_read_message_id = read_through_id
            participant.last_read_at = now
            participant.save(
                update_fields=["last_read_message_id", "last_read_at", "updated_at"]
            )

        unread = (
            Message.where(
                chat_id=chat_id,
                recipient_id=user_id,
                id__lte=read_through_id,
                status__in=UNREAD_STATUSES,
            )
            .order_by("id")
            .get()
        )
        updates: List[dict] = []
        for message in unread:
            if message.delivered_at is None:
                message.delivered_at = now
            message.status = "read"
            message.read_at = now
            message.save(update_fields=["status", "delivered_at", "read_at", "updated_at"])
            updates.append(_status_update(message))
        return participant, participant.last_read_message_id, updates

    # ── delivery queue helpers ────────────────────────────────────────────

    @staticmethod
    def get_pending_messages(recipient_id: int, limit: int = 100) -> List[Message]:
        """Messages waiting for a now-online recipient (status ``sent``)."""
        return (
            Message.where(recipient_id=recipient_id, status="sent")
            .prefetch_related("sender", "attachments")
            .order_by("id")
            .limit(limit)
            .get()
        )

    @staticmethod
    def get_message_for_delivery(message_id: int) -> Optional[Message]:
        return (
            Message.where(id=message_id)
            .prefetch_related("sender", "attachments")
            .first()
        )

    # ── edit / delete ─────────────────────────────────────────────────────

    @staticmethod
    def edit_message(
        user_id: int, chat_id: int, message_id: int, payload: MessageEdit
    ) -> Message:
        ChatService.require_membership(chat_id, user_id)
        message = ChatService.get_message(chat_id, message_id)
        if message.sender_id != user_id:
            raise ForbiddenError(
                "You can only edit your own messages", code="not_message_owner"
            )
        if message.deleted_at is not None:
            raise BadRequestError(
                "Deleted messages cannot be edited", code="message_deleted"
            )

        message.content = payload.content
        message.edited_at = utcnow()
        message.save(update_fields=["content", "edited_at", "updated_at"])
        return message

    @staticmethod
    def delete_message(user_id: int, chat_id: int, message_id: int) -> Message:
        ChatService.require_membership(chat_id, user_id)
        message = ChatService.get_message(chat_id, message_id)
        if message.sender_id != user_id:
            raise ForbiddenError(
                "You can only delete your own messages", code="not_message_owner"
            )
        if message.deleted_at is not None:
            return message

        message.content = None
        message.deleted_at = utcnow()
        message.save(update_fields=["content", "deleted_at", "updated_at"])

        latest = Message.where(chat_id=chat_id, deleted_at=None).order_by("-id").first()
        chat = ChatService.get_chat(chat_id)
        chat.last_message_at = latest.created_at if latest is not None else None
        chat.save(update_fields=["last_message_at", "updated_at"])
        return message


chat_service = ChatService()
