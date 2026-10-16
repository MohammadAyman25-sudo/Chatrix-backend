# API Request/Response Examples

Base URL: `http://localhost:5000/api/v1`
Auth: httpOnly cookies (`access_token`, `refresh_token`), so send requests with credentials (Cookie jar). All errors follow the error middleware shape: `{ "message": "..." }`.

Email verification: enabled by default (`EMAIL_VERIFICATION_ENABLED=true`). Registration creates the account **unverified and without a session**; the user must confirm via the emailed link (`POST /auth/verify-email`) before `POST /auth/login` will succeed. Every `PublicUser` exposes `emailVerified`. When `RESEND_API_KEY` is unset, verification emails are printed to the server console instead of sent. Set `EMAIL_VERIFICATION_ENABLED=false` to skip verification entirely (register then issues cookies as before). All outbound mail is queued in memory and sent in the background (never blocking the request), with retries on failure.

New-message notifications: when someone sends you a message while you are offline, the backend emails you a short preview (subject/body naming the sender or group) at most once per conversation per 10 minutes, unless your `settings.notifications` is `false`. Online users are not emailed (they get `message:new` over the socket). A message with no text shows a media label (📷 Photo, 🎥 Video, 🎙️ Voice message, 📎 Attachment).

Rate limiting: all API routes are limited per client IP (600 requests / 15 min). Additional per-route limits apply and return `429` with `{ "message": "..." }`: `/auth/login`, `/auth/register`, `/auth/verify-email` and `/auth/resend-verification` (10 / 15 min per IP), `/auth/refresh` (60 / 15 min), `GET /users/search` (30 / min per user), message sends (60 / min per user, both REST and Socket.IO), message edits and forwards over sockets (30 / min per user), message attachment uploads (60 / min per user) and avatar/group-icon uploads (30 / 15 min per user). Set `RATE_LIMIT_ENABLED=false` to disable locally.

## Auth

### POST /auth/register

**Password policy:** 8–72 characters, must contain at least one lowercase Latin letter, one uppercase Latin letter, one number and one special symbol, and may only use Latin letters, numbers and special symbols. `confirmPassword` must match `password`. Passwords found in the Have I Been Pwned data set (or the bundled common-password list) are rejected.

**Email verification:** with verification enabled (the default) the account is created **unverified**, no session cookies are set, and `emailVerificationSent: true` is returned. `POST /auth/login` returns `403` until the emailed link is redeemed via `POST /auth/verify-email`.

**Body:**

```json
{
  "username": "alice",
  "email": "alice@example.com",
  "password": "Str0ng!Pass",
  "confirmPassword": "Str0ng!Pass"
}
```

**Response 400 (validation failed):**

```json
{
  "message": "Validation failed",
  "issues": [
    {
      "code": "custom",
      "path": ["password"],
      "message": "Password must contain at least one number (0-9)"
    }
  ]
}
```

**Response 400 (compromised password):**

```json
{
  "message": "This password has appeared in a data breach. Please choose a different password."
}
```

**Response 201:**

```json
{
  "user": {
    "id": "64f123abc456def789012345",
    "username": "alice",
    "displayName": null,
    "email": "alice@example.com",
    "emailVerified": false,
    "bio": null,
    "avatarUrl": null,
    "settings": {
      "theme": "system",
      "notifications": true,
      "readReceipts": true
    },
    "createdAt": "2025-10-14T12:00:00.000Z"
  },
  "emailVerificationSent": true
}
```

_With `EMAIL_VERIFICATION_ENABLED=false` the response omits `emailVerificationSent` and sets httpOnly `access_token` / `refresh_token` cookies (same as login). With verification on, no cookies are set here._

### POST /auth/login

**Body:**

```json
{
  "email": "alice@example.com",
  "password": "password123"
}
```

**Response 200:**

```json
{ "user": { ...PublicUser... } }
```

_Sets cookies._

**Response 403 (email not verified — only when verification is enabled):**

```json
{
  "message": "Email not verified. Check your inbox for the verification link, or request a new one."
}
```

**Response 401 (bad credentials):**

```json
{ "message": "Invalid email or password" }
```

### POST /auth/verify-email

Redeems the token from the verification link (no session required — the token proves ownership of the address). The token is single-use and expires after 24 hours; requesting a new link invalidates the previous one.

**Body:**

```json
{
  "token": "8Qp...base64url...XA"
}
```

**Response 200:**

```json
{ "user": { ...PublicUser, "emailVerified": true ... } }
```

**Response 400 (unknown, already-used or expired token):**

```json
{ "message": "Invalid or expired verification token" }
```

### POST /auth/resend-verification

Issues a fresh verification link for an unverified account. Always answers `202` with the same body, whether or not the address exists or is already verified, so it cannot be used to enumerate accounts.

**Body:**

```json
{
  "email": "alice@example.com"
}
```

**Response 202:**

```json
{ "message": "If that address has an unverified account, a verification email was sent." }
```

### GET /auth/me (auth required)

**Response 200:**

```json
{ "user": { ...PublicUser... } }
```

### POST /auth/refresh

**Response 204** (no body). _Sets new cookies. Uses `refresh_token` cookie._

### POST /auth/logout

**Response 204** (no body). _Clears cookies._

## Users

### PATCH /users/me (auth required)

**Body:**

```json
{
  "displayName": "Alice",
  "bio": "Hello!"
}
```

**Response 200:**

```json
{ "user": { ...PublicUser... } }
```

### GET /users/me/settings (auth required)

Returns the caller's settings.

**Response 200:**

```json
{
  "settings": {
    "theme": "dark",
    "notifications": true,
    "readReceipts": true
  }
}
```

### PATCH /users/me/settings (auth required)

Partial update: send only the fields you want to change; omitted fields keep their current value. At least one field is required — an empty body (or one with no recognised fields) returns `400 { "message": "Validation failed", "issues": [...] }`.

**Body (all fields optional):**

```json
{
  "theme": "dark",
  "notifications": true,
  "readReceipts": true
}
```

- `theme`: `"light" | "dark" | "system"`.
- `notifications`: turns **new-message email notifications** on/off (`false` opts out). When a message is sent to a conversation while you are offline, the backend emails you at most once per conversation per 10 minutes, unless this is `false`. Online users are never emailed (they get `message:new`).
- `readReceipts`: when `false`, your read receipts are **not** broadcast — senders stop receiving your `message:status` `"read"` updates (your `"delivered"` updates are unaffected). Defaults to `true`.

**Example — disable both:**

```json
{
  "notifications": false,
  "readReceipts": false
}
```

**Response 200:**

```json
{
  "settings": {
    "theme": "dark",
    "notifications": false,
    "readReceipts": false
  }
}
```

Both endpoints act on the caller (`/users/me`). The same settings object is embedded in every `PublicUser` (e.g. from `login` and `GET /auth/me`).

### POST /users/me/avatar (auth required, multipart/form-data)

**Form:**

- `avatar` (file) — JPEG/PNG/WebP/GIF, ≤5MB

**Response 200:**

```json
{ "user": { ...PublicUser, "avatarUrl": "https://..." } }
```

### DELETE /users/me/avatar (auth required)

**Response 200:**

```json
{ "user": { ...PublicUser, "avatarUrl": null } }
```

### GET /users/search?q=<query>&limit=<n> (auth required)

Find people to chat with. Case-insensitive match on `username` or `displayName`;
the caller is always excluded. `q` is required (1–50 chars), `limit` defaults to 20 (max 50).
**Response 200** — a bare array of public profiles (never email/settings):

```json
[
  {
    "id": "64f123abc456def789012346",
    "username": "bob",
    "displayName": "Bob",
    "bio": "Hi there!",
    "avatarUrl": null
  }
]
```

### GET /users/:userId (auth required)

Public profile of another user. Returns the same shape as a search result.
**Response 200:**

```json
{
  "user": {
    "id": "64f123abc456def789012346",
    "username": "bob",
    "displayName": "Bob",
    "bio": "Hi there!",
    "avatarUrl": null
  }
}
```

**Response 404** for unknown or malformed ids (no existence probing).

## Conversations

### GET /conversations (auth required)

**Response 200:**

```json
{
  "items": [
    {
      "id": "64f123abc456def789012347",
      "type": "direct",
      "name": null,
      "avatarUrl": null,
      "participants": [
        {
          "id": "64f123abc456def789012345",
          "username": "alice",
          "displayName": "Alice",
          "avatarUrl": null
        },
        {
          "id": "64f123abc456def789012346",
          "username": "bob",
          "displayName": null,
          "avatarUrl": null
        }
      ],
      "lastMessageAt": null,
      "createdAt": "2025-10-14T12:00:00.000Z",
      "unreadCount": 0
    },
    {
      "id": "64f123abc456def789012348",
      "type": "group",
      "name": "Team Chat",
      "avatarUrl": "/uploads/conversations/64f123abc456def789012348/icon/a1b2.png",
      "participants": [
        {
          "id": "64f123abc456def789012345",
          "username": "alice",
          "displayName": "Alice",
          "avatarUrl": null
        },
        {
          "id": "64f123abc456def789012346",
          "username": "bob",
          "displayName": null,
          "avatarUrl": null
        },
        {
          "id": "64f123abc456def789012349",
          "username": "carol",
          "displayName": null,
          "avatarUrl": null
        }
      ],
      "lastMessageAt": "2025-10-14T12:10:00.000Z",
      "createdAt": "2025-10-14T12:05:00.000Z",
      "unreadCount": 4
    }
  ]
}
```

`unreadCount` is the number of messages **addressed to the requesting user** in that conversation that they have not marked read yet (own messages never count). It is computed for the caller, so two users see different counts. `GET /conversations` is the only place it is returned; realtime `conversation:new` / `conversation:updated` payloads omit it, so clients keep the count locally (increment on `message:new`, reset to `0` when the chat is opened and `message:read` is sent).

### POST /conversations (auth required)

**Direct:**

```json
{
  "type": "direct",
  "participantIds": ["64f123abc456def789012346"]
}
```

**Group:**

```json
{
  "type": "group",
  "name": "Team Chat",
  "participantIds": ["64f123abc456def789012346", "64f123abc456def789012349"]
}
```

**Response 201 (created new):**

```json
{
  "conversation": {
    "id": "64f123abc456def789012347",
    "type": "direct",
    "name": null,
    "avatarUrl": null,
    "participants": [...],
    "lastMessageAt": null,
    "createdAt": "2025-10-14T12:00:00.000Z"
  }
}
```

**Response 200 (existing direct deduped):**

```json
{ "conversation": { ...same direct... } }
```

### PATCH /conversations/:id (auth required)

Rename a **group** (any member may). Direct conversations return `400`; non-members `404`.

**Body:**

```json
{ "name": "Weekend Trip" }
```

**Response 200:**

```json
{ "conversation": { ...ConversationDto, "name": "Weekend Trip" ... } }
```

### POST /conversations/:id/avatar (auth required, multipart/form-data)

Set or replace a **group** icon (any member). Emits `conversation:updated` to the other members. Direct conversations return `400`; non-members `404`.

**Form:** `avatar` (file) — JPEG/PNG/WebP/GIF, ≤5MB

**Response 200:**

```json
{ "conversation": { ...ConversationDto, "avatarUrl": "/uploads/conversations/.../icon/a1b2.png" ... } }
```

### DELETE /conversations/:id/avatar (auth required)

Clear a group icon. Emits `conversation:updated` to the other members.

**Response 200:**

```json
{ "conversation": { ...ConversationDto, "avatarUrl": null ... } }
```

### POST /conversations/:id/participants (auth required)

Invite users to a **group** (any member may). Ids already in the group are ignored; if **all** of them already are, the request is rejected with `400`. Unknown/non-existent ids return `400`. Invitees receive `conversation:new`; existing members receive `conversation:updated`. Invitees can read the group's full history immediately.

**Body:**

```json
{ "participantIds": ["64f123abc456def789012349", "64f123abc456def789012350"] }
```

**Response 200:**

```json
{ "conversation": { ...ConversationDto with the added participants... } }
```

**Response 400 (everyone already in the group):**

```json
{ "message": "Everyone you selected is already in this group" }
```

## Messages (REST)

### POST /conversations/:id/messages (auth required)

**Body:**

```json
{
  "content": "Hello!"
}
```

**Body (reply to a message):**

```json
{
  "content": "Thanks!",
  "replyToId": "64f123abc456def789012350"
}
```

**Body (reply privately):** deliver the reply as a **direct message to the author** of the quoted message instead of to this conversation.

```json
{
  "content": "Let's talk about this 1:1",
  "replyToId": "64f123abc456def789012350",
  "replyPrivately": true
}
```

If that DM is new, the response additionally carries `"conversation"` (the created direct `ConversationDto`) and a `conversation:new` event fires first. `replyToId` must belong to this conversation; `400` if it is missing/invalid, or if you are the quoted message's author.

**Response 201:**

```json
{
  "message": {
    "id": "64f123abc456def789012351",
    "conversationId": "64f123abc456def789012347",
    "content": "Hello!",
    "sender": {
      "id": "64f123abc456def789012345",
      "username": "alice",
      "displayName": "Alice",
      "avatarUrl": null
    },
    "replyTo": {
      "id": "64f123abc456def789012350",
      "content": "Hello!",
      "type": "text",
      "attachments": [],
      "sender": {
        "id": "64f123abc456def789012345",
        "username": "alice",
        "displayName": "Alice",
        "avatarUrl": null
      }
    },
    "status": "sent",
    "editedAt": null,
    "forwarded": false,
    "createdAt": "2025-10-14T12:01:00.000Z"
  }
}
```

Recipients who are **offline** also get an email notification (at most once per conversation per 10 minutes, and only if their `settings.notifications` is on). Online recipients just receive `message:new`.

### PATCH /conversations/:id/messages/:messageId (auth required)

Edit the content of **your own text message** within 15 minutes of sending. Sets `editedAt` on the message and broadcasts `message:edited` to the other participants.

**Body:**

```json
{ "content": "Hello (edited)!" }
```

**Response 200:**

```json
{ "message": { ...MessageDto, "editedAt": "2025-10-14T12:03:00.000Z" ... } }
```

Errors: `400` for non-text messages or after the 15-minute window, `403` if you are not the sender, `404` for unknown/non-member.

### POST /conversations/:id/messages/:messageId/forward (auth required)

Forward a message to other chats and/or users. Each target gets a **new message** that keeps the original content and attachments but is re-attributed to you and marked `forwarded: true` (recipients see a "Forwarded" label, never the original author). You must be a member of the source conversation (else `404`) and of every target conversation (else `404`).

**Body:**

```json
{
  "conversationIds": ["64f123abc456def789012348"],
  "userIds": ["64f123abc456def789012351"]
}
```

- `conversationIds` — existing conversations to forward into (max 20).
- `userIds` — people to forward to; the direct chat is found or created for each (max 20). Forwarding to yourself is rejected (`400`).

At least one target is required (`400` otherwise). Unknown targets return `400`/`404`. Each copy is broadcast as `message:new` to that conversation's participants; a direct chat created for a `userId` is broadcast as `conversation:new` first. Like a normal send, each copy also emails its offline recipients (deduped per conversation).

**Response 201:**

```json
{
  "messages": [{ ...one MessageDto per target conversation, each with "forwarded": true... }],
  "conversations": [{ ...ConversationDto, only present when a new direct chat was created... }]
}
```

### GET /conversations/:id/messages (auth required, keyset pagination)

**Query:** `?cursor=<base64url>&limit=30` (cursor/limit optional)
**Response 200:**

```json
{
  "items": [
    {
      "id": "64f123abc456def789012350",
      "conversationId": "64f123abc456def789012347",
      "content": "Hello!",
      "sender": {
        "id": "64f123abc456def789012345",
        "username": "alice",
        "displayName": "Alice",
        "avatarUrl": null
      },
      "status": "sent",
      "editedAt": null,
      "forwarded": false,
      "createdAt": "2025-10-14T12:01:00.000Z"
    }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

**Cursor:** base64url-encoded cursor from `_id` (oldest message). Next page uses `cursor` to get messages `< cursor`.

### POST /conversations/:id/attachments (auth required, multipart/form-data)

Uploads message media **without** creating a message. Use this to send a **voice note**: record audio in the browser, `POST` it here, then send the returned attachment(s) via the `message:send` socket event.

**Form fields:** `files` (1–10 files, ≤100MB each; images, video, audio or documents), optional `duration` (seconds; applied to audio/video results).
**Response 201:**

```json
{
  "attachments": [
    {
      "type": "audio",
      "url": "/uploads/messages/64f123abc456def789012347/64f123abc456def789012345/a1b2.webm",
      "key": "messages/64f123abc456def789012347/64f123abc456def789012345/a1b2.webm",
      "name": "voice-note.webm",
      "size": 20480,
      "mimeType": "audio/webm",
      "duration": 7
    }
  ]
}
```

Then send the voice message over the socket:

```js
socket.emit(
  'message:send',
  { conversationId, type: 'audio', attachments: [attachment] },
  (ack) => ack.ok && console.log(ack.message),
);
```

Errors: `400` no files, `400` unsupported file type, `404` not a conversation member, `429` too many uploads.

### GET /conversations/:id/presence (auth required)

Live online / last-seen for the conversation's participants (used when a chat opens).
**Response 200:**

```json
{
  "items": [
    { "userId": "64f123abc456def789012345", "status": "online", "lastSeenAt": null },
    {
      "userId": "64f123abc456def789012346",
      "status": "offline",
      "lastSeenAt": "2025-10-14T11:58:00.000Z"
    }
  ]
}
```

Members only: non-members get `404`.

## Socket.IO

- URL: `http://localhost:5000` (same server), auth via `access_token` httpOnly cookie.
- Emits target `user:<id>` rooms (not conversation rooms). Sender excluded from events they trigger except via ack.
- Events:

### Client -> Server

- `message:send` (payload: `{ conversationId, content?, clientTempId?, type?, attachments?, replyToId?, replyPrivately? }`, ack: `{ ok: true, message, clientTempId, conversation? }` | `{ ok: false, error }`)
- `message:edit` (payload: `{ conversationId, messageId, content }`, ack: `{ ok: true, message }` | `{ ok: false, error }`)
- `message:forward` (payload: `{ conversationId, messageId, conversationIds?, userIds? }`, ack: `{ ok: true, messages, conversations? }` | `{ ok: false, error }`)
- `typing:start` (payload: `{ conversationId }`)
- `typing:stop` (payload: `{ conversationId }`)
- `recording:start` (payload: `{ conversationId }`)
- `recording:stop` (payload: `{ conversationId }`)
- `message:read` (payload: `{ conversationId }`)

### Server -> Client

- `message:new` (payload: `MessageDto`)
- `message:edited` (payload: `MessageDto` — same message with updated `content`/`editedAt`)
- `conversation:new` (payload: `ConversationDto` — also fires when a private reply creates a DM)
- `conversation:updated` (payload: `ConversationDto` — group renamed, icon changed, or participants invited)
- `typing:update` (payload: `{ conversationId, userId, isTyping }`)
- `recording:update` (payload: `{ conversationId, userId, isRecording }`)
- `message:status` (payload: `{ conversationId, userId, status: 'delivered'|'read', at: string }`)
- `presence:update` (payload: `{ userId, status: 'online'|'offline', lastSeenAt: string | null }`)

### Notes

- On connect: auto-join `user:<id>`, broadcast presence to contacts if came online, mark pending delivered messages as delivered.
- On the last disconnect: `User.lastSeenAt` is persisted and contacts receive `presence:update` with `status: 'offline'` and the timestamp. While online, `lastSeenAt` is `null`.
- `message:send` REST and socket both call `message.service.sendMessage` and broadcast `message:new` to others (sender gets ack from socket or 201 from REST). With `replyPrivately`, both also return/broadcast the resulting `conversation` when a new DM is created.
- `message:edit` REST and socket both call `message.service.editMessage`; the editor gets the updated message via ack/response, others via `message:edited`. Only the sender, only text messages, only within 15 minutes.
- `message:forward` REST and socket both call `message.service.forwardMessage`; each target chat gets a `message:new` (with `forwarded: true`) and the sender gets the copies via ack/response. A direct chat created for a `userId` target is announced with `conversation:new` before its message. Forwarding is throttled per user.
- Group management (rename / icon / invite) is REST-only; results reach clients through `conversation:updated` (existing members) and `conversation:new` (invitees).
- `unreadCount` is only returned by `GET /conversations` (per caller). Socket `conversation:new` / `conversation:updated` payloads do not carry it, so clients maintain the badge themselves: increment on `message:new`, reset when the chat opens (`message:read`).
- Read receipts respect `settings.readReceipts`. Typing/recording/status/presence are not persisted (only `lastSeenAt` is).
- Attachment `url` may be an absolute URL or an app-relative path (`/uploads/...`).
