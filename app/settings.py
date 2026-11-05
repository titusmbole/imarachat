"""Application settings.

Values come from environment variables (and an optional ``.env`` file).
``DOVEORM`` is the dict the DoveORM CLI reads through
``settings = "app.settings:DOVEORM"`` in ``doveorm.toml``.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Application
    APP_NAME: str = "ImaraChat API"
    APP_VERSION: str = "0.1.0"
    APP_ENV: str = "development"
    API_V1_PREFIX: str = "/api/v1"
    DEBUG: bool = True

    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    CORS_ORIGINS: str = "*"

    # Database (DoveORM)
    DATABASE_ENGINE: str = "sqlite"
    DATABASE_PATH: str = "imarachat.db"
    DATABASE_NAME: str = ""
    DATABASE_HOST: str = ""
    DATABASE_PORT: int = 0
    DATABASE_USER: str = ""
    DATABASE_PASSWORD: str = ""
    LOG_QUERIES: bool = False
    USE_TZ: bool = True

    # Chat attachments
    UPLOAD_DIR: str = "uploads"
    MAX_UPLOAD_MB: int = 25

    # Auth / JWT
    JWT_SECRET_KEY: str = "dev-only-change-this-secret-key-before-deploying-imarachat"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    @property
    def cors_origins(self) -> list:
        """Return CORS origins as a list."""
        if self.CORS_ORIGINS.strip() == "*":
            return ["*"]
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]

    @property
    def doveorm_settings(self) -> dict:
        """Settings dict passed to ``doveorm.configure()``."""
        options = {
            "DATABASE_ENGINE": self.DATABASE_ENGINE,
            "DATABASE_PATH": self.DATABASE_PATH,
            "LOG_QUERIES": self.LOG_QUERIES,
            "USE_TZ": self.USE_TZ,
        }
        if self.DATABASE_ENGINE.lower() in {"mysql", "postgres", "postgresql"}:
            options.update(
                {
                    "DATABASE_NAME": self.DATABASE_NAME,
                    "DATABASE_HOST": self.DATABASE_HOST,
                    "DATABASE_PORT": self.DATABASE_PORT,
                    "DATABASE_USER": self.DATABASE_USER,
                    "DATABASE_PASSWORD": self.DATABASE_PASSWORD,
                }
            )
        return options


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

# Read by the ``doveorm`` command (see doveorm.toml).
DOVEORM = settings.doveorm_settings
