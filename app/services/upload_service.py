"""Chat attachment storage on the local disk.

Files are saved under ``settings.UPLOAD_DIR`` with a random name; the
original file name travels with the message instead. The stored extension
comes from a fixed list of content types, never from the user's file name,
so a file can only ever be served as one of the types below.
"""

import os
import re
import uuid
from pathlib import Path
from typing import AsyncIterator, Optional, Tuple

from app.settings import settings
from app.shared.exceptions import AppError, BadRequestError, NotFoundError

# content type -> (stored extension, safe to show inline in the browser)
CONTENT_TYPES = {
    "image/jpeg": (".jpg", True),
    "image/png": (".png", True),
    "image/gif": (".gif", True),
    "image/webp": (".webp", True),
    "image/avif": (".avif", True),
    "image/heic": (".heic", False),
    "video/mp4": (".mp4", True),
    "video/webm": (".webm", True),
    "video/quicktime": (".mov", True),
    "audio/mpeg": (".mp3", True),
    "audio/mp4": (".m4a", True),
    "audio/ogg": (".ogg", True),
    "audio/wav": (".wav", True),
    "audio/webm": (".weba", True),
    "application/pdf": (".pdf", False),
    "text/plain": (".txt", False),
    "text/csv": (".csv", False),
    "application/zip": (".zip", False),
    "application/msword": (".doc", False),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (".docx", False),
    "application/vnd.ms-excel": (".xls", False),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": (".xlsx", False),
    "application/vnd.ms-powerpoint": (".ppt", False),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": (".pptx", False),
    # Anything else is accepted as an opaque download.
    "application/octet-stream": (".bin", False),
}
EXTENSIONS = {ext: (content_type, inline) for content_type, (ext, inline) in CONTENT_TYPES.items()}

# What a stored attachment URL looks like: /media/<32 hex chars><known ext>
MEDIA_PREFIX = "/media/"
STORED_NAME = re.compile(r"^[0-9a-f]{32}\.[a-z0-9]{2,5}$")


class PayloadTooLargeError(AppError):
    status_code = 413
    code = "file_too_large"


def max_upload_bytes() -> int:
    return settings.MAX_UPLOAD_MB * 1024 * 1024


def upload_dir() -> Path:
    path = Path(settings.UPLOAD_DIR)
    path.mkdir(parents=True, exist_ok=True)
    return path


def normalize_content_type(content_type: Optional[str]) -> str:
    value = (content_type or "").split(";")[0].strip().lower()
    if value == "image/jpg":
        value = "image/jpeg"
    return value if value in CONTENT_TYPES else "application/octet-stream"


def is_media_url(url: str) -> bool:
    return url.startswith(MEDIA_PREFIX) and bool(STORED_NAME.match(url[len(MEDIA_PREFIX):]))


class UploadService:
    @staticmethod
    async def save(
        chunks: AsyncIterator[bytes],
        *,
        content_type: Optional[str],
        declared_size: Optional[int] = None,
    ) -> Tuple[str, str, int]:
        """Stream an upload to disk. Returns (url, content_type, size)."""
        limit = max_upload_bytes()
        if declared_size is not None and declared_size > limit:
            raise PayloadTooLargeError(f"Files can be up to {settings.MAX_UPLOAD_MB} MB")

        kind = normalize_content_type(content_type)
        extension, _inline = CONTENT_TYPES[kind]
        name = f"{uuid.uuid4().hex}{extension}"
        directory = upload_dir()
        final_path = directory / name
        temp_path = directory / f".{name}.part"

        size = 0
        try:
            with open(temp_path, "wb") as handle:
                async for chunk in chunks:
                    size += len(chunk)
                    if size > limit:
                        raise PayloadTooLargeError(
                            f"Files can be up to {settings.MAX_UPLOAD_MB} MB"
                        )
                    handle.write(chunk)
            if size == 0:
                raise BadRequestError("The file is empty", code="empty_file")
            os.replace(temp_path, final_path)
        finally:
            if temp_path.exists():
                temp_path.unlink()

        return f"{MEDIA_PREFIX}{name}", kind, size

    @staticmethod
    def resolve(name: str) -> Tuple[Path, str, bool]:
        """Find a stored file. Returns (path, content_type, show_inline)."""
        if not STORED_NAME.match(name):
            raise NotFoundError("File not found", code="file_not_found")
        extension = name[name.index("."):]
        if extension not in EXTENSIONS:
            raise NotFoundError("File not found", code="file_not_found")
        path = upload_dir() / name
        if not path.is_file():
            raise NotFoundError("File not found", code="file_not_found")
        content_type, inline = EXTENSIONS[extension]
        return path, content_type, inline


upload_service = UploadService()
