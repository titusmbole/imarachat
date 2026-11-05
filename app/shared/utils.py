"""Small utility helpers."""

from datetime import datetime, timezone


def utcnow() -> datetime:
    """Return the current time as an aware UTC datetime."""
    return datetime.now(timezone.utc)


def unique_violation(exc: Exception) -> bool:
    """Return True when a database error is a UNIQUE constraint violation.

    The message is checked instead of importing a driver-specific exception
    so the same helper works with SQLite, MySQL and PostgreSQL.
    """
    message = str(exc).lower()
    return "unique" in message or "duplicate" in message
