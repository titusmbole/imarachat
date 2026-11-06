# syntax=docker/dockerfile:1
#
# ImaraChat — FastAPI + Socket.IO realtime chat backend
#
# Build:
#   docker build -t imarachat:latest .
#
# Run (development):
#   cp .env.example .env        # then edit JWT_SECRET_KEY
#   docker run --rm --env-file .env -p 8000:8000 imarachat:latest
#
# The container runs `doveorm apply` on startup, then serves uvicorn on port 8000.
# For production, override JWT_SECRET_KEY and set APP_ENV=production via the
# environment (env vars take precedence over .env in pydantic-settings).
#

FROM python:3.12-slim

WORKDIR /app

# Runtime system packages
# MySQL client dev libraries + build tools are required for the mysqlclient driver.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        default-libmysqlclient-dev \
        pkg-config \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies (cached in their own layer)
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
    && pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir "doveorm[mysql]==0.8.0"

# Application code
COPY app ./app
COPY migrations ./migrations
COPY doveorm.toml .
COPY .env.example .

# Directory for chat attachments
RUN mkdir -p uploads

# Non-root runtime user
RUN groupadd -r imarachat && useradd -r -g imarachat -d /app imarachat \
    && chown -R imarachat:imarachat /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER imarachat

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')" || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]