"""Device/login session model used to rotate and revoke refresh tokens."""

from doveorm import (
    BelongsTo,
    CharField,
    CASCADE,
    DateTimeField,
    ForeignKey,
    Model,
    table,
)

from app.shared.utils import utcnow


@table(
    name="user_sessions",
    indexes=[("user_id",), ("expires_at",), ("revoked_at",)],
    ordering=["-created_at"],
)
class UserSession(Model):
    """A login session belonging to a user.

    Each row represents one device/browser login. The refresh token for that
    login carries the session id (``sid``) and the session's ``jti`` claim, so
    rotating a refresh token invalidates the previous token while revoking the
    row logs the device out.
    """

    user_id = ForeignKey("User", on_delete=CASCADE)
    user = BelongsTo("User", foreign_key="user_id")

    refresh_jti = CharField(max_length=128, nullable=False, unique=True, sensitive=True)
    device_name = CharField(max_length=120, nullable=True)
    ip_address = CharField(max_length=45, nullable=True)
    user_agent = CharField(max_length=512, nullable=True)

    last_used_at = DateTimeField(nullable=True)
    expires_at = DateTimeField(nullable=False)
    revoked_at = DateTimeField(nullable=True)

    created_at = DateTimeField(auto_now_add=True, nullable=True)
    updated_at = DateTimeField(auto_now=True, nullable=True)

    def is_valid(self) -> bool:
        """Return True when the session can still authenticate requests."""
        if self.revoked_at is not None:
            return False
        if self.expires_at is None:
            return True
        now = utcnow()
        expires_at = self.expires_at
        # Be tolerant of databases configured without timezone support.
        if expires_at.tzinfo is None:
            now = now.replace(tzinfo=None)
        return expires_at > now
