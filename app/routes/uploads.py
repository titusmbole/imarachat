"""Attachment uploads and downloads.

Uploads are raw request bodies (``Content-Type`` = the file's type), so no
multipart parser is needed and large files stream straight to disk:

    POST /api/v1/uploads?name=holiday.jpg     body: <file bytes>

The returned ``url`` goes into ``attachments`` of a chat message. Files are
served back from ``/media/<name>``; only images, video and audio are shown
inline, everything else downloads.
"""

from typing import Optional

from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.models import User
from app.services.upload_service import upload_service
from app.shared.dependencies import get_current_user

router = APIRouter(prefix="/uploads", tags=["uploads"])
media_router = APIRouter(include_in_schema=False)


class UploadResponse(BaseModel):
    url: str
    file_name: Optional[str] = None
    mime_type: str
    file_size: int


@router.post(
    "",
    response_model=UploadResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Upload a chat attachment (raw body)",
)
async def upload(
    request: Request,
    name: Optional[str] = Query(default=None, max_length=255),
    current_user: User = Depends(get_current_user),
) -> UploadResponse:
    declared = request.headers.get("content-length")
    url, content_type, size = await upload_service.save(
        request.stream(),
        content_type=request.headers.get("content-type"),
        declared_size=int(declared) if declared and declared.isdigit() else None,
    )
    file_name = (name or "").strip().replace("/", "_").replace("\\", "_") or None
    return UploadResponse(url=url, file_name=file_name, mime_type=content_type, file_size=size)


@media_router.get("/media/{name}", name="media")
def media(name: str) -> FileResponse:
    path, content_type, inline = upload_service.resolve(name)
    return FileResponse(
        path,
        media_type=content_type,
        headers={
            "Content-Disposition": "inline" if inline else "attachment",
            "X-Content-Type-Options": "nosniff",
            # Never let an uploaded file run script on this origin.
            "Content-Security-Policy": "default-src 'none'; media-src 'self'; img-src 'self'; sandbox",
            "Cache-Control": "private, max-age=31536000, immutable",
        },
    )
