# Imarachat

FastAPI service for ImaraChat with DoveORM, JWT device sessions and a
Socket.IO realtime one-to-one (P2P) chat API.

## What it does

ImaraChat is a P2P-only chat backend. Users register and log in with bcrypt-hashed
passwords, get rotating JWT access/refresh tokens tied to device sessions, and send
real-time one-to-one messages over Socket.IO (WebSocket with polling fallback). It
also serves a server-rendered landing page (Jinja2 + Tailwind CSS CDN). Chats are
strictly one-to-one—no groups—and messages support delivery/read status, edits,
soft deletes, and attachments.

## Architecture

**Stack:** FastAPI + Uvicorn; DoveORM 0.8 (SQLite default; MySQL/PostgreSQL
supported); Pydantic v2 / pydantic-settings; bcrypt + PyJWT; python-socketio 5.

**Layering:** route → controller → service → model.

**Key parts:**
- `app/main.py` — FastAPI factory + combined Socket.IO ASGI app
- `app/settings.py` — env-driven settings + DOVEORM dict
- `app/database.py` — configures DoveORM once per process
- `app/models/` — User, UserSession, Chat, ChatParticipant, Message, MessageAttachment
- `app/services/` — business logic (auth, chat)
- `app/realtime/server.py` — Socket.IO server, auth, events, presence
- `app/shared/` — security, dependencies, exceptions, utils
- `app/templates/` and `app/static/` — server-rendered UI
- `migrations/` and `doveorm.toml` — DoveORM schema

**Security:** passwords are never echoed or mass-assigned; every login creates a
`UserSession`; access tokens carry the session id (`sid`) and are invalidated on
revocation; refresh tokens rotate on every use; Socket.IO is authorized against
`ChatParticipant` membership.

**Production:** one Uvicorn worker (in-memory presence). Multiple workers require
a Socket.IO Redis message queue and sticky sessions.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # then edit JWT_SECRET_KEY
```

Apply the database schema:

```bash
doveorm apply
doveorm doctor                # health check
```

Run the API and Socket.IO server together:

```bash
uvicorn app.main:app --reload
```

- App: http://127.0.0.1:8000/
- Socket.IO: ws://127.0.0.1:8000/socket.io

## DoveORM setup

- `app/settings.py` — defines the env-driven `DOVEORM` dict.
- `app/database.py` — calls `configure()` once per process to initialize DoveORM.
- `doveorm.toml` — DoveORM configuration file.
- `migrations/` — generated DoveORM migrations.

Commands:

```bash
doveorm apply                 # apply schema / migrations
doveorm doctor                # health check
doveorm generate --name <change>   # create a migration after editing a model
doveorm verify                # CI gate: fails if a model change lacks a migration
```

Switch to PostgreSQL/MySQL by setting `DATABASE_ENGINE` and the matching
`DATABASE_*` variables in `.env`, then install the driver:

```bash
pip install "doveorm[postgres]"   # or "doveorm[mysql]"
```

## Landing page

`GET /` renders `app/templates/landing.html` (extends `base.html`) and is
styled with Tailwind CSS from the CDN (`@tailwindcss/browser@4`). It has:

- an app bar with the ImaraChat logo on the left, and **Log in** and
  **Get started** buttons on the right
- a WhatsApp-style doodle wallpaper (`static/img/doodles.svg`)
- a green chat icon in the center

### Login and sign-up modal

**Log in** and **Get started** open one modal
(`templates/components/auth_modal.html`) with a sliding Log in / Sign up
switch. It is a native `<dialog>`, so focus stays inside it and Esc closes it.
It opens as a bottom sheet on phones and as a centered card on larger screens.

- Inputs use floating labels, icons, a show/hide password button, a password
  strength meter, and a username suggested from the full name. They come from
  the macros in `templates/components/ui.html`.
- Forms are checked in the browser with the same rules as the API. Server
  errors are shown next to the right field (`username_taken`, `email_taken`)
  or in a banner (`invalid_credentials`).
- The forms call `POST /api/v1/auth/register` and `POST /api/v1/auth/login`
  with an `X-Device-Name` such as `Chrome on macOS`. On success the tokens are
  stored in `localStorage` (`imarachat.auth`), and the app bar shows the user
  with a **Log out** button.
- On page load the session is checked with `/auth/me`. If the access token has
  expired, it is refreshed with `/auth/refresh`.
- `/#login` and `/#get-started` open the modal directly.

The logic is in `static/js/auth.js` (plain JavaScript, no build step). Brand
colors are set in the `@theme` block in `base.html`.

The Tailwind CDN build compiles styles in the browser. It is fine for
development; for production, build Tailwind with its CLI and serve the
generated CSS file instead.

## Data model

ImaraChat is **P2P only**: every chat is a private one-to-one conversation
between exactly two users. There are no groups.

| Model | Table | Purpose |
|---|---|---|
| `User` | `users` | Account with name, username, email, bcrypt password |
| `UserSession` | `user_sessions` | One row per device/login; owns refresh-token rotation and revocation |
| `Chat` | `chats` | One-to-one conversation; `direct_key` (`"minId:maxId"`) allows only one chat per pair |
| `ChatParticipant` | `chat_participants` | One of the two users, with read cursor, pin and mute |
| `Message` | `messages` | `sender_id` → `recipient_id`, with `status`, `delivered_at`, `read_at`, replies, edits and soft deletes |
| `MessageAttachment` | `message_attachments` | URL-based file/image/audio metadata |

Messages are soft-deleted so history, pagination cursors and read state stay
consistent. `client_message_id` makes socket/HTTP retries idempotent.






