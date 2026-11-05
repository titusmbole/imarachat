# ImaraChat Backend

FastAPI service for ImaraChat with DoveORM, JWT device sessions and a
Socket.IO realtime one-to-one (P2P) chat API.

## Stack

- FastAPI + Uvicorn
- Jinja2 templates + Tailwind CSS (CDN) for server-rendered pages
- DoveORM 0.8 (SQLite by default; MySQL/PostgreSQL supported)
- Pydantic v2 / pydantic-settings
- bcrypt password hashing + rotating JWT access/refresh tokens (PyJWT)
- python-socketio 5 (WebSocket + polling fallback)

## Structure

```
backend/
├── app/
│   ├── main.py                  # FastAPI factory + combined Socket.IO ASGI app
│   ├── settings.py              # env-driven settings + DOVEORM dict
│   ├── database.py              # configure() DoveORM once per process
│   ├── models/
│   │   ├── user.py              # users
│   │   ├── user_session.py      # login/device sessions
│   │   └── chat.py              # P2P chats, participants, messages, attachments
│   ├── schemas/
│   │   ├── auth.py
│   │   └── chat.py              # REST + socket payload schemas
│   ├── routes/
│   │   ├── auth.py
│   │   ├── chat.py
│   │   └── web.py               # landing page (/)
│   ├── controllers/
│   │   ├── auth_controller.py
│   │   └── chat_controller.py
│   ├── services/
│   │   ├── auth_service.py      # users, sessions, token rotation
│   │   └── chat_service.py      # P2P chats, messages, delivery status
│   ├── templates/
│   │   ├── base.html            # Tailwind CDN, fonts, theme
│   │   ├── landing.html
│   │   └── components/          # auth_modal.html, ui.html (input/button macros)
│   ├── static/
│   │   ├── img/                 # logo.svg, doodles.svg (chat wallpaper)
│   │   └── js/auth.js           # modal, validation, login/sign-up, session
│   ├── realtime/
│   │   └── server.py            # Socket.IO server, auth, events, presence
│   └── shared/
│       ├── security.py          # bcrypt + JWT helpers
│       ├── dependencies.py      # get_current_user / get_current_session
│       ├── exceptions.py        # AppError hierarchy + handlers
│       └── utils.py
├── migrations/                  # DoveORM migrations
├── doveorm.toml
├── requirements.txt
└── .env.example
```

Request flow: **route → controller → service → model**.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # then edit JWT_SECRET_KEY
```

Apply the database schema (all migrations are already generated):

```bash
doveorm apply
doveorm doctor                # health check
```

Run the API and Socket.IO server together:

```bash
uvicorn app.main:app --reload
```

- Landing page: http://127.0.0.1:8000/
- API info: http://127.0.0.1:8000/api
- Swagger UI: http://127.0.0.1:8000/docs
- OpenAPI JSON: http://127.0.0.1:8000/openapi.json
- Health: http://127.0.0.1:8000/health
- Socket.IO endpoint: `ws://127.0.0.1:8000/socket.io`

For production use one Uvicorn worker (presence is in-memory). If you need
multiple workers, add a Socket.IO Redis message queue and sticky sessions.

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

## Auth API

Base path: `/api/v1`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create account, returns user + tokens |
| POST | `/auth/login` | — | Log in with username **or** email |
| POST | `/auth/refresh` | — | Rotate refresh token (old one becomes invalid) |
| POST | `/auth/logout` | Bearer | Revoke the current device session |
| GET | `/auth/sessions` | Bearer | List active device sessions |
| DELETE | `/auth/sessions/{id}` | Bearer | Revoke one device session |
| GET | `/auth/me` | Bearer | Current user |

### Register

```bash
curl -X POST http://127.0.0.1:8000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -H 'X-Device-Name: laptop' \
  -d '{
    "name": "Titus Kilunda",
    "username": "titus",
    "email": "titus@example.com",
    "password": "Secret1234"
  }'
```

### Login

```bash
curl -X POST http://127.0.0.1:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"identifier": "titus", "password": "Secret1234"}'
```

`identifier` accepts either the username or the email address.
Send `X-Device-Name` to label the session in `/auth/sessions`.

### Refresh

```bash
curl -X POST http://127.0.0.1:8000/api/v1/auth/refresh \
  -H 'Content-Type: application/json' \
  -d '{"refresh_token": "<refresh_token>"}'
```

Each refresh rotates the token. Reusing an old refresh token returns
`401 refresh_token_reused`.

## Chat API

REST is used only to open chats and load history. Sending messages and all
status acknowledgements happen over Socket.IO (see below).

| Method | Path | Description |
|---|---|---|
| POST | `/chats` | Open the chat with another user: `{"user_id": 2}` |
| GET | `/chats` | List my chats with `peer`, last message and unread count |
| GET | `/chats/{id}` | One chat |
| DELETE | `/chats/{id}` | Delete the chat and its messages for both users |
| GET | `/chats/{id}/messages?before_id=&limit=30` | Paginated history (oldest → newest), including statuses |
| PATCH | `/chats/{id}/messages/{message_id}` | Edit your message |
| DELETE | `/chats/{id}/messages/{message_id}` | Soft-delete your message |
| POST | `/chats/{id}/messages` | Legacy HTTP send (use Socket.IO `MSG_SEND`) |
| POST | `/chats/{id}/read` | Legacy HTTP read (use Socket.IO `MSG_READ`) |

### Open a chat

```bash
curl -X POST http://127.0.0.1:8000/api/v1/chats \
  -H "Authorization: Bearer <access_token>" \
  -H 'Content-Type: application/json' \
  -d '{"user_id": 2}'
```

```json
{
  "id": 1,
  "peer": {"id": 2, "name": "Jane", "username": "jane"},
  "last_message": null,
  "unread_count": 0,
  "is_pinned": false,
  "muted_until": null,
  "last_message_at": null,
  "created_at": "...",
  "updated_at": "..."
}
```

Opening a chat is idempotent: either user opening the same pair gets the same
chat. You cannot open a chat with yourself. Both users' online sockets are
subscribed to the new chat and receive `chat:added`.

Message types: `text`, `image`, `file`, `audio`, `video`. `system` messages
cannot be sent by clients. Only the sender can edit or delete a message.

## Realtime Socket.IO

Connect with the access token:

```js
import { io } from "socket.io-client";

const socket = io("http://127.0.0.1:8000", {
  auth: { token: accessToken },
  transports: ["websocket"],
});
```

The server also accepts `Authorization: Bearer <token>` in the handshake
headers. Invalid or revoked tokens are rejected.

On connect the socket automatically joins:

- `user:{user_id}`: all of a user's devices
- `chat:{chat_id}` for every chat the user belongs to

## Message status (WhatsApp-style ticks)

Every message has one sender and one recipient, so its `status` is exactly
what the sender should render.

### Statuses

| Status | Meaning | Tick to render |
|---|---|---|
| `sent` | The server received and saved the message. The recipient has not received it yet. | ✓ single grey tick |
| `delivered` | The message reached a connected device of the recipient. | ✓✓ double grey ticks |
| `read` | The recipient opened the chat and saw it. | ✓✓ double blue ticks |

Before the server confirms a message, the client should show it as **pending**
(a clock icon). This is client-only; the server never stores `pending`.

Statuses only move forward: `sent → delivered → read`. The message records
when each step happened in `delivered_at` and `read_at`.

### Flow

```
Sender                       Server                                Recipient
  │  MSG_SEND {chat_id, content, client_message_id}                   │
  │ ───────────────────────────▶ save message (status=sent)           │
  │ ◀─────────── MSG_SENT ─────  (single tick)                        │
  │                              add to delivery queue                │
  │                              recipient online?                    │
  │                                yes ── MSG_RECEIVED ─────────────▶ │
  │                                       status → delivered          │
  │ ◀────────── MSG_DELIVERED ─  (double tick)                        │
  │                                no  ── stays "sent" in the queue;  │
  │                                       sent on next connect ─────▶ │
  │                                                                   │ user opens chat
  │                              ◀──────── MSG_READ {chat_id, message_id}
  │                              status → read                        │
  │ ◀──────────── MSG_READ ────  (blue ticks)                         │
```

1. The sender emits `MSG_SEND`. The server checks the sender is in the chat,
   then saves the message with `recipient_id` set to the other user and
   `status = "sent"`.
2. The server emits `MSG_SENT` to every connected device of the sender. The
   ack of `MSG_SEND` contains the same message.
3. The message is added to the in-memory delivery queue. The delivery worker
   checks whether the recipient is online.
4. If the recipient is online, the server emits `MSG_RECEIVED` to all their
   devices. It then marks the message `delivered` and emits `MSG_DELIVERED`
   to the sender.
5. If the recipient is offline, the message stays `sent`. Messages with
   `status = "sent"` are the persistent queue, so they survive a server
   restart. When the recipient connects, every waiting message is sent as
   `MSG_RECEIVED` and the sender gets `MSG_DELIVERED` for each one.
6. When the recipient opens the chat, the client emits `MSG_READ`. Every
   message they received up to that one becomes `read`, and the sender gets
   one `MSG_READ` event per message.

Retries are safe: sending the same `client_message_id` again returns the
existing message (`duplicate: true`) and its current status. It does not
create a second message.

### Client example

```js
// Sender
const clientMessageId = crypto.randomUUID();
renderPending(clientMessageId);                         // 🕓

const ack = await socket.emitWithAck("MSG_SEND", {
  chat_id: 1,
  content: "Hello",
  client_message_id: clientMessageId,
});
if (!ack.ok) renderFailed(clientMessageId, ack.error);

// client_message_id lets you match the server message to the pending bubble.
socket.on("MSG_SENT", (e) => setStatus(e.client_message_id, e.message_id, "sent")); // ✓
socket.on("MSG_DELIVERED", (e) => setStatus(e.client_message_id, e.message_id, "delivered")); // ✓✓
socket.on("MSG_READ", (e) => setStatus(e.client_message_id, e.message_id, "read")); // ✓✓ blue

// Recipient
socket.on("MSG_RECEIVED", ({ chat_id, message }) => {
  addMessage(message);
  if (isChatOpen(chat_id)) {
    socket.emit("MSG_READ", { chat_id, message_id: message.id });
  }
});

// When the user opens a chat: mark everything up to the latest message as read
socket.emit("MSG_READ", { chat_id: 1 });
```

### Status event payload

`MSG_SENT`, `MSG_DELIVERED` and `MSG_READ` share this shape:

```json
{
  "chat_id": 1,
  "message_id": 12,
  "client_message_id": "local-uuid-123",
  "sender_id": 1,
  "recipient_id": 2,
  "status": "delivered",
  "delivered_at": "2026-11-05T06:55:01.123Z",
  "read_at": null
}
```

`MSG_SENT` also includes the full saved `message`.

## Realtime Socket.IO events

### Client → server events

| Event | Payload | Description |
|---|---|---|
| `MSG_SEND` (alias `message:send`) | `{"chat_id": 1, "content": "Hi", "client_message_id": "uuid"}` | Send a message → `MSG_SENT`, then queued delivery |
| `MSG_READ` (alias `message:read`) | `{"chat_id": 1, "message_id": 12}` | Mark read up to a message (omit `message_id` for the latest) |
| `message:edit` | `{"chat_id": 1, "message_id": 12, "content": "Edited"}` | Edit your message |
| `message:delete` | `{"chat_id": 1, "message_id": 12}` | Soft-delete your message |
| `typing:start` / `typing:stop` | `{"chat_id": 1}` | Typing indicator |
| `presence:check` | `{"chat_id": 1}` | Ack with the online user ids in the chat |
| `chat:join` / `chat:leave` | `{"chat_id": 1}` | Join/leave a chat room explicitly (rarely needed) |

All events support an acknowledgement. Example:

```js
const ack = await socket.emitWithAck("MSG_SEND", {
  chat_id: 1,
  content: "Hello from the socket",
  client_message_id: "socket-uuid-1",
});

if (ack.ok) {
  console.log(ack.status, ack.message); // "sent", {...}
}
```

The `MSG_READ` ack also contains `status_updates`, the list of messages that
changed to `read`.

### Server → client events

| Event | Sent to | Payload |
|---|---|---|
| `MSG_SENT` | Sender's devices | Status payload + `message` (single tick) |
| `MSG_RECEIVED` | Recipient's devices | `{"chat_id": 1, "message": {...}}` |
| `MSG_DELIVERED` | Sender's devices | Status payload (double tick) |
| `MSG_READ` | Sender's devices | Status payload (blue ticks) |
| `message:updated` | Both users | `{"chat_id": 1, "message": {...}}` |
| `message:deleted` | Both users | `{"chat_id": 1, "message": {...}}` |
| `message:read` | Both users | `{"chat_id": 1, "user_id": 2, "message_id": 12, "read_at": "..."}` (read cursor) |
| `typing:start` / `typing:stop` | The other user | `{"chat_id": 1, "user": {"id": 2, "name": "...", "username": "..."}}` |
| `presence:online` / `presence:offline` | The other user | `{"chat_id": 1, "user": {...}}` |
| `chat:added` | Both users | `{"chat_id": 1, "chat": {...}}` when a chat is opened |
| `chat:deleted` | Both users | `{"chat_id": 1}` when a chat is deleted |
| `chat:error` | The caller | `{"code": "forbidden", "message": "..."}` |

Message payloads include `recipient_id`, `status`, `delivered_at`, `read_at`,
`sender`, `attachments`, `reply_to_id`, `edited_at` and `deleted_at`. Message
history from `GET /chats/{id}/messages` includes the same fields, so ticks
show correctly after a reload.

## Security notes

- Passwords are bcrypt hashes; the field is `sensitive=True` and
  `editable=False`, so it never appears in `to_dict()` or mass assignment.
- Every login creates a `UserSession`. Access tokens carry the session id
  (`sid`); revoking the session invalidates both access and refresh tokens.
- Refresh tokens rotate on every use; a reused token is rejected.
- Socket.IO messages are authorized against `ChatParticipant` membership, not
  just room membership.
- Validation errors never echo submitted values (including passwords).
- Set a strong `JWT_SECRET_KEY` outside local development:
  `python -c "import secrets; print(secrets.token_urlsafe(64))"`.

## Database changes

After editing a model:

```bash
doveorm generate --name describe_change
doveorm apply
doveorm verify          # CI gate: fails if a model change has no migration
```

Switch to PostgreSQL/MySQL by setting `DATABASE_ENGINE` and the matching
`DATABASE_*` variables in `.env`, then install the driver:

```bash
pip install "doveorm[postgres]"   # or "doveorm[mysql]"
```

The same code also supports `doveorm generate` / `doveorm apply` against the
configured database.
