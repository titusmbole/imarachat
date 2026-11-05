"""Server-rendered (Jinja2) pages."""

from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from app.settings import settings

APP_DIR = Path(__file__).resolve().parent.parent

templates = Jinja2Templates(directory=str(APP_DIR / "templates"))
templates.env.globals["app_name"] = "ImaraChat"

router = APIRouter(include_in_schema=False)


@router.get("/", response_class=HTMLResponse, name="landing")
def landing(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "landing.html",
        {"api_prefix": settings.API_V1_PREFIX},
    )
