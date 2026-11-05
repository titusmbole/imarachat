"""One-to-one (P2P) chat, membership, message and attachment models."""

from doveorm import (
    BelongsTo,
    BooleanField,
    CASCADE,
    CharField,
    DateTimeField,
    ForeignKey,
    HasMany,
    IntegerField,
    Model,
    SET_NULL,
    TextField,
    table,
)


@table(
    name="chats",
    indexes=[("created_by",), ("last_message_at",)],
    ordering=["-last_message_at"],
)
class Chat(Model):
    """A one-to-one conversation between exactly two users."""

    created_by = ForeignKey("User", on_delete=SET_NULL, nullable=True)
    creator = BelongsTo("User", foreign_key="created_by")

    # Sorted "minId:maxId" so the same two users cannot have two chats.
    direct_key = CharField(max_length=64, nullable=False, unique=True)

    last_message_at = DateTimeField(nullable=True)
    created_at = DateTimeField(auto_now_add=True, nullable=True)
    updated_at = DateTimeField(auto_now=True, nullable=True)

    members = HasMany("ChatParticipant", foreign_key="chat_id")
    messages = HasMany("Message", foreign_key="chat_id")


@table(
    name="chat_participants",
    indexes=[
        ("chat_id",),
        ("user_id",),
        ("user_id", "last_read_message_id"),
    ],
    unique_together=[("chat_id", "user_id")],
    ordering=["joined_at"],
)
class ChatParticipant(Model):
    """One of the two users in a chat, with their read cursor."""

    chat_id = ForeignKey("Chat", on_delete=CASCADE)
    chat = BelongsTo("Chat", foreign_key="chat_id")

    user_id = ForeignKey("User", on_delete=CASCADE)
    user = BelongsTo("User", foreign_key="user_id")

    last_read_message_id = IntegerField(nullable=True)
    last_read_at = DateTimeField(nullable=True)
    muted_until = DateTimeField(nullable=True)
    is_pinned = BooleanField(default=False)

    joined_at = DateTimeField(auto_now_add=True, nullable=True)
    updated_at = DateTimeField(auto_now=True, nullable=True)


@table(
    name="messages",
    indexes=[
        ("chat_id", "id"),
        ("chat_id", "created_at"),
        ("sender_id",),
        ("recipient_id", "status"),
        ("created_at",),
    ],
    unique_together=[("chat_id", "sender_id", "client_message_id")],
    ordering=["-id"],
)
class Message(Model):
    """A message from one user to the other user in a chat.

    ``status`` drives the sender's ticks: sent (single) -> delivered (double)
    -> read (blue). Messages with ``status='sent'`` are the persistent
    delivery queue for an offline recipient.

    Messages are soft-deleted (``deleted_at``). ``client_message_id`` lets
    clients retry safely after a dropped socket connection.
    """

    chat_id = ForeignKey("Chat", on_delete=CASCADE)
    chat = BelongsTo("Chat", foreign_key="chat_id")

    sender_id = ForeignKey("User", on_delete=SET_NULL, nullable=True)
    sender = BelongsTo("User", foreign_key="sender_id")

    recipient_id = ForeignKey("User", on_delete=SET_NULL, nullable=True)
    recipient = BelongsTo("User", foreign_key="recipient_id")

    type = CharField(max_length=20, nullable=False, default="text")
    content = TextField(nullable=True)
    reply_to_id = ForeignKey("Message", on_delete=SET_NULL, nullable=True)
    reply_to = BelongsTo("Message", foreign_key="reply_to_id")

    client_message_id = CharField(max_length=100, nullable=True)

    status = CharField(max_length=20, nullable=False, default="sent")
    delivered_at = DateTimeField(nullable=True)
    read_at = DateTimeField(nullable=True)

    edited_at = DateTimeField(nullable=True)
    deleted_at = DateTimeField(nullable=True)
    created_at = DateTimeField(auto_now_add=True, nullable=True)
    updated_at = DateTimeField(auto_now=True, nullable=True)

    attachments = HasMany("MessageAttachment", foreign_key="message_id")


@table(
    name="message_attachments",
    indexes=[("message_id",)],
    ordering=["id"],
)
class MessageAttachment(Model):
    """A file/image/audio attachment attached to a message."""

    message_id = ForeignKey("Message", on_delete=CASCADE)
    message = BelongsTo("Message", foreign_key="message_id")

    url = CharField(max_length=2048, nullable=False)
    file_name = CharField(max_length=255, nullable=True)
    mime_type = CharField(max_length=120, nullable=True)
    file_size = IntegerField(nullable=True)

    created_at = DateTimeField(auto_now_add=True, nullable=True)
