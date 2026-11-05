"""Auth request/response schemas."""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class RegisterRequest(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    username: str = Field(min_length=3, max_length=50, pattern=r"^[A-Za-z0-9_.-]+$")
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)

    @field_validator("name", "username")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("username")
    @classmethod
    def normalise_username(cls, value: str) -> str:
        return value.lower()

    @field_validator("email")
    @classmethod
    def normalise_email(cls, value: str) -> str:
        return value.lower()


class LoginRequest(BaseModel):
    """``identifier`` accepts a username or an email address."""

    identifier: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=72)

    @field_validator("identifier")
    @classmethod
    def strip_identifier(cls, value: str) -> str:
        return value.strip()


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=1)


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    username: str
    email: EmailStr
    is_active: bool
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    @classmethod
    def from_model(cls, user) -> "UserResponse":
        return cls(**user.to_dict())


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    session_id: Optional[int] = None


class SessionResponse(BaseModel):
    id: int
    device_name: Optional[str] = None
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    last_used_at: Optional[datetime] = None
    expires_at: datetime
    revoked_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    is_current: bool = False

    @classmethod
    def from_model(cls, session, *, is_current: bool = False) -> "SessionResponse":
        return cls(
            id=session.id,
            device_name=session.device_name,
            ip_address=session.ip_address,
            user_agent=session.user_agent,
            last_used_at=session.last_used_at,
            expires_at=session.expires_at,
            revoked_at=session.revoked_at,
            created_at=session.created_at,
            is_current=is_current,
        )


class AuthResponse(BaseModel):
    user: UserResponse
    tokens: TokenPair
