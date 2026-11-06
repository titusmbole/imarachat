#!/usr/bin/env bash
#
# Entrypoint for the ImaraChat container.
# Applies DoveORM schema/migrations, then execs the passed command (uvicorn).
#
set -euo pipefail

echo "[imarachat] Applying database migrations (doveorm apply)..."
doveorm apply

# Warn when running the default dev JWT secret outside of development.
if [ "${APP_ENV:-development}" != "development" ] \
   && [ "${JWT_SECRET_KEY:-}" = "dev-only-change-this-secret-key-before-deploying-imarachat" ]; then
  echo "[imarachat] WARNING: JWT_SECRET_KEY is the default development value!" >&2
  echo "[imarachat]         Generate a strong key before deploying to production." >&2
fi

echo "[imarachat] Starting application..."
exec "$@"