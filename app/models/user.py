"""User model."""

from doveorm import BooleanField, CharField, DateTimeField, EmailField, Model, table


@table(
    name="users",
    indexes=[("username",), ("email",)],
    ordering=["-created_at"],
)
class User(Model):
    """An application user.

    ``password`` stores a bcrypt hash, never the plain-text password. The
    field is marked sensitive so it never appears in ``to_dict()`` output,
    logs or validation errors, and non-editable so it cannot be mass-assigned
    through ``from_input()`` / ``assign()``.
    """

    name = CharField(max_length=120, nullable=False)
    username = CharField(max_length=50, nullable=False, unique=True)
    email = EmailField(max_length=254, nullable=False, unique=True)
    password = CharField(max_length=255, nullable=False, sensitive=True, editable=False)
    is_active = BooleanField(default=True)
    created_at = DateTimeField(auto_now_add=True, nullable=True)
    updated_at = DateTimeField(auto_now=True, nullable=True)
