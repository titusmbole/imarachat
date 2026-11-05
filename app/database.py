"""DoveORM database configuration.

Importing this module configures DoveORM once per process. Models are bound to
the database automatically (``AUTO_WIRE_MODELS`` is on by default).
"""

from doveorm import configure, get_database, is_configured

from app.settings import DOVEORM


def _configure() -> None:
    if not is_configured():
        configure(**DOVEORM)


_configure()


def db():
    """Return the configured DoveORM database instance."""
    return get_database()
