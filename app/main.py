"""FastAPI application entry point."""

import logging
from contextlib import asynccontextmanager

import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app import database  # noqa: F401  (configures DoveORM on import)
from app.realtime.server import (
    sio,
    start_delivery_worker,
    stop_delivery_worker,
)
from app.routes.auth import router as auth_router
from app.routes.chat import router as chat_router
from app.routes.uploads import media_router, router as uploads_router
from app.routes.users import router as users_router
from app.routes.web import APP_DIR, router as web_router
from app.settings import settings
from app.shared.exceptions import register_exception_handlers

logging.basicConfig(level=logging.INFO if not settings.DEBUG else logging.DEBUG)
logger = logging.getLogger("imarachat")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting %s v%s (%s)", settings.APP_NAME, settings.APP_VERSION, settings.APP_ENV)
    start_delivery_worker()
    try:
        yield
    finally:
        await stop_delivery_worker()
        logger.info("Shutting down %s", settings.APP_NAME)


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.APP_NAME,
        version=settings.APP_VERSION,
        debug=settings.DEBUG,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        # A wildcard origin cannot be combined with credentialed requests.
        allow_credentials=settings.cors_origins != ["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_exception_handlers(app)

    app.mount("/static", StaticFiles(directory=str(APP_DIR / "static")), name="static")

    app.include_router(web_router)
    app.include_router(auth_router, prefix=settings.API_V1_PREFIX)
    app.include_router(chat_router, prefix=settings.API_V1_PREFIX)
    app.include_router(users_router, prefix=settings.API_V1_PREFIX)
    app.include_router(uploads_router, prefix=settings.API_V1_PREFIX)
    app.include_router(media_router)

    @app.get("/api", tags=["meta"])
    def api_info():
        return {
            "name": settings.APP_NAME,
            "version": settings.APP_VERSION,
            "docs": "/docs",
            "health": "/health",
            "socketio": "/socket.io",
        }

    @app.get("/health", tags=["meta"])
    def health():
        return {"status": "ok", "version": settings.APP_VERSION}

    return app


fastapi_app = create_app()

# Socket.IO is served at /socket.io; every other request is forwarded to
# FastAPI. Uvicorn runs this combined ASGI application.
app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app, socketio_path="socket.io")
