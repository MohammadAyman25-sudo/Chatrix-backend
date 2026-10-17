# API Request/Response Examples

Base URL: `http://localhost:5000/api/v1`
Auth: httpOnly cookies (`access_token`, `refresh_token`), so send requests with credentials (Cookie jar). All errors follow the error middleware shape: `{ "message": "..." }`.

Email verification: enabled by default (`EMAIL_VERIFICATION_ENABLED=true`). Registration creates the account **unverified and without a session**; the user must confirm via the emailed link (`POST /auth/verify-email`) before `POST /auth/login` will succeed. Every `PublicUser` exposes `emailVerified`. When `RESEND_API_KEY` is unset, verification emails are printed to the server console instead of sent. Set `EMAIL_VERIFICATION_ENABLED=false` to skip verification entirely (register then issues cookies as before). All outbound mail runs as jobs on a **persistent MongoDB-backed queue** and is delivered in the background (never blocking the request), with backoff retries that survive restarts.

New-message notifications: when someone sends you a message while you are offline, the backend emails you a short preview (subject/body naming the sender or group) at most once per conversation per 10 minutes, unless your `settings.notifications` is `false`. Online users are not emailed (they get `message:new` over the socket). A message with no text shows a media label (📷 Photo, 🎥 Video, 🎙️ Voice message, 📎 Attachment).

Rate limiting: all API routes are limited per client IP (600 requests / 15 min). Additional per-route limits apply and return `429` with `{ "message": "..." }`: `/auth/login`, `/auth/register`, `/auth/verify-email` and `/auth/resend-verification` (10 / 15 min per IP), `/auth/refresh` (60 / 15 min), `GET /users/search` (30 / min per user), `GET /messages/search` (30 / min per user), message sends (60 / min per user, both REST and Socket.IO), message edits and forwards over sockets (30 / min per user), upload signing (30 / 15 min per user) and upload confirmation (60 / min per user). Set `RATE_LIMIT_ENABLED=false` to disable locally.

Uploads: files are uploaded **directly from the client to Cloudflare R2** with a presigned `PUT` URL — no `multipart/form-data` and no file bytes through this API. Every upload (message media, voice notes, avatars, group icons) is the same `sign → PUT → confirm` flow; see [Uploads (direct to R2)](#uploads-direct-to-r2) for the full examples.

## Uploads (direct to R2)

### POST /uploads/sign (auth required)

Checks membership/limits, records a pending upload and returns a presigned `PUT` URL (valid 15 minutes).

**Body:**

```json
{
  "scope": "message",
  "conversationId": "64f123abc456def789012347",
  "name": "holiday.png",
  "size": 348122,
  "mimeType": "image/png",
  "duration": 7
}
```

- `scope` — `message` | `avatar` | `group-icon`.
- `conversationId` — required for `message` / `group-icon` (you must be a member; otherwise `404`); must be omitted for `avatar`.
- `size` — the exact number of bytes you are about to upload (re-verified on confirm).
- `mimeType` — must be allowed for the scope (see limits below).
- `duration` — optional seconds for audio/video, kept on the resulting attachment.

**Response 201:**

```json
{
  "upload": {
    "id": "665f1c0a9b3e4d0012a34567",
    "key": "messages/64f123abc456def789012347/64f123abc456def789012345/a1b2c3d4.png",
    "url": "https://<account-id>.r2.cloudflarestorage.com/...&X-Amz-Signature=...",
    "method": "PUT",
    "headers": { "Content-Type": "image/png" },
    "expiresAt": "2026-10-17T16:15:00.000Z"
  }
}
```

The `Content-Type` is **part of the signature** — the `PUT` must send exactly the returned headers.

**Response 400 (limit or MIME violation):** `{ "message": "File is larger than 5MB" }`
**Response 404 (not a conversation member):** `{ "message": "Conversation not found" }`
**Response 429:** too many sign requests.

### PUT <upload.url> (to R2, not this API)

```bash
curl -X PUT "$UPLOAD_URL" --data-binary @holiday.png -H "Content-Type: image/png"
```

A wrong `Content-Type`, an expired URL or a re-used URL fails with an R2 signature error.

### POST /uploads/:uploadId/confirm (auth required)

`HeadObject`s the object and completes the upload. Idempotent (a retried confirm returns the same result). Rejects a size/content-type mismatch or a missing object with `400` and deletes the pending record; unknown ids return `404`.

**Response 201 — scope `message` (pass `attachment` to `message:send` / `POST …/messages`):**

```json
{
  "attachment": {
    "type": "image",
    "url": "https://pub-example.r2.dev/messages/64f123abc456def789012347/64f123abc456def789012345/a1b2c3d4.png",
    "key": "messages/64f123abc456def789012347/64f123abc456def789012345/a1b2c3d4.png",
    "name": "holiday.png",
    "size": 348122,
    "mimeType": "image/png"
  }
}
```

- scope `avatar` → `{ "user": { ...PublicUser, "avatarUrl": "https://pub-example.r2.dev/avatars/..." } }` (the previous avatar object is deleted).
- scope `group-icon` → `{ "conversation": { ...ConversationDto, "avatarUrl": "..." } }` and a `conversation:updated` event to the other members.

**Limits:** `message` ≤ **100MB** (images/video/audio/documents — an explicit MIME allow-list), `avatar` and `group-icon` ≤ **5MB** (JPEG/PNG/WebP/GIF). Suggested keys are `messages/<conversationId>/<userId>/<uuid><ext>`, `avatars/<userId>/<uuid><ext>` and `conversations/<conversationId>/icon/<uuid><ext>`. Uploads that are never confirmed are swept after 24 hours by a background job.

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
- `readReceipts`: when `false`, your read receipts are **not** broadcast — senders stop receiving your `message:status` `"read"` updates (your `"delivered"` updates are unaffected). In a **direct** chat it also hides your read time from the sender's "Message info" (`GET .../messages/:messageId/info`), which reports `readReceiptsDisabled: true` instead, and the message's `status` never surfaces as `read` to the sender (it stays `delivered`). Ignored in **groups**, where read times are always shown. Defaults to `true`.

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

### Set the caller's avatar (direct upload, auth required)

No multipart: upload with `scope: 'avatar'` (no `conversationId`; JPEG/PNG/WebP/GIF, ≤5MB) following [Uploads (direct to R2)](#uploads-direct-to-r2).

**POST /uploads/sign body:**

```json
{ "scope": "avatar", "name": "me.jpg", "size": 51200, "mimeType": "image/jpeg" }
```

After the `PUT`, `POST /uploads/:uploadId/confirm` returns the updated user (and deletes the previous avatar object):

```json
{ "user": { ...PublicUser, "avatarUrl": "https://pub-example.r2.dev/avatars/64f123abc456def789012345/a1b2.jpg" } }
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
      "avatarUrl": "https://pub-example.r2.dev/conversations/64f123abc456def789012348/icon/a1b2.png",
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

### Set a group icon (direct upload, auth required)

Set or replace a **group** icon (any member). Upload with `scope: 'group-icon'` and `conversationId` (JPEG/PNG/WebP/GIF, ≤5MB) — see [Uploads (direct to R2)](#uploads-direct-to-r2). Direct conversations return `400` at sign time; non-members `404`.

**POST /uploads/sign body:**

```json
{
  "scope": "group-icon",
  "conversationId": "64f123abc456def789012347",
  "name": "icon.png",
  "size": 30500,
  "mimeType": "image/png"
}
```

After the `PUT`, `POST /uploads/:uploadId/confirm` returns the updated conversation and emits `conversation:updated` to the other members:

```json
{ "conversation": { ...ConversationDto, "avatarUrl": "https://pub-example.r2.dev/conversations/64f123abc456def789012347/icon/a1b2.png" ... } }
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

**Body (with attachments):** attachments come from the confirm step of the [direct upload flow](#uploads-direct-to-r2) — the returned `attachment` object goes straight into the array.

```json
{
  "type": "image",
  "content": "Look at this!",
  "attachments": [
    {
      "type": "image",
      "url": "https://pub-example.r2.dev/messages/64f123abc456def789012347/64f123abc456def789012345/a1b2c3d4.png",
      "key": "messages/64f123abc456def789012347/64f123abc456def789012345/a1b2c3d4.png",
      "name": "holiday.png",
      "size": 348122,
      "mimeType": "image/png"
    }
  ]
}
```

A message must have `content` or at least one `attachment` (`400` otherwise). `type` defaults to `text`; the server only uses it to label the message (`image`/`video`/`audio`/`file` for media).

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

### GET /conversations/:id/messages/:messageId/info (auth required)

Delivery/read receipt detail for **one of your own messages** (the "Message info" screen). Only the message's **sender** may call it — anyone else gets `403`; non-members / unknown messages get `404`.

**Response 200:**

```json
{
  "info": {
    "messageId": "64f123abc456def789012351",
    "conversationId": "64f123abc456def789012347",
    "conversationType": "group",
    "status": "delivered",
    "deliveredTo": [
      {
        "user": {
          "id": "64f123abc456def789012346",
          "username": "bob",
          "displayName": "Bob",
          "avatarUrl": null
        },
        "at": "2025-10-14T12:01:03.000Z"
      },
      {
        "user": {
          "id": "64f123abc456def789012349",
          "username": "carol",
          "displayName": "Carol",
          "avatarUrl": null
        },
        "at": "2025-10-14T12:01:05.000Z"
      }
    ],
    "readBy": [
      {
        "user": {
          "id": "64f123abc456def789012346",
          "username": "bob",
          "displayName": "Bob",
          "avatarUrl": null
        },
        "at": "2025-10-14T12:02:00.000Z"
      }
    ],
    "pending": [
      {
        "id": "64f123abc456def789012350",
        "username": "dave",
        "displayName": "Dave",
        "avatarUrl": null
      }
    ],
    "readReceiptsDisabled": false
  }
}
```

- `deliveredTo` / `readBy` — each entry is `{ user, at }`; `at` is the ISO time the recipient's client received/read the message (`null` for messages stored before receipt times were tracked).
- `pending` — recipients who have neither received nor read it yet.
- `status` — the aggregate from your point of view (`sent | delivered | read`), same value as on `MessageDto`.

**Privacy rules**

- **Direct conversation:** the other member's read time is only shown when their `settings.readReceipts` is on. If it is off, `readBy` omits them (their delivery is still shown), `readReceiptsDisabled` is `true`, and the aggregate `status` caps at `delivered` — it never surfaces as `read`. Their read time is never leaked through the delivery entry.
- **Group conversation:** `readReceipts` is ignored — every member who received/read appears in `deliveredTo` / `readBy` with their time, and `readReceiptsDisabled` is always `false`.

Errors: `403` you are not the sender, `404` unknown message / not a conversation member.

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

### GET /conversations/:id/media (auth required, keyset pagination)

Lists the shareable content of one conversation — the "Media, links and docs" tab — so the client can show all photos/videos/documents/links without scanning messages. Newest first, same cursor/`limit` semantics as message listing (`limit` counts messages; each item carries its own attachments).

**Query:** `?type=all|image|video|audio|file|link&cursor=<base64url>&limit=30` (`type` defaults to `all`, `limit` 1–100 default 30). Media kinds match the **attachment** type, so a message with several photos is one item with several attachments; `link` returns messages whose text contains a URL; `all` is their union.

Each item is a `MessageDto` plus `links` (URLs extracted from the message text; `[]` when there are none).

**Response 200:**

```json
{
  "items": [
    {
      "id": "64f123abc456def789012350",
      "conversationId": "64f123abc456def789012347",
      "content": "Look at these https://example.com/album",
      "type": "image",
      "attachments": [
        {
          "type": "image",
          "url": "https://cdn.example.com/photos/1.jpg",
          "name": "beach.jpg",
          "size": 184320,
          "mimeType": "image/jpeg",
          "width": 1920,
          "height": 1080
        }
      ],
      "sender": {
        "id": "64f123abc456def789012345",
        "username": "alice",
        "displayName": "Alice",
        "avatarUrl": null
      },
      "status": "read",
      "editedAt": null,
      "forwarded": false,
      "createdAt": "2025-10-14T12:01:00.000Z",
      "links": ["https://example.com/album"]
    }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

Members only: non-members get `404`.

### Upload message media without sending (auth required)

There is no multipart endpoint on a conversation any more. To attach media — or to send a **voice note** — run the [sign → PUT → confirm](#uploads-direct-to-r2) flow with `scope: 'message'` (requires `conversationId`; ≤100MB; optional `duration` for audio/video), then send the returned `attachment`:

```js
// 1. POST /uploads/sign
//    { scope: 'message', conversationId, name: 'voice-note.webm', size, mimeType: 'audio/webm', duration: 7 }
// 2. PUT the recording to upload.url with the returned Content-Type header
// 3. POST /uploads/:uploadId/confirm -> { attachment }

socket.emit(
  'message:send',
  { conversationId, type: 'audio', attachments: [attachment] },
  (ack) => ack.ok && console.log(ack.message),
);
```

Or over REST with `POST /conversations/:id/messages`:

```json
{
  "type": "audio",
  "attachments": [
    {
      "type": "audio",
      "url": "https://…",
      "name": "voice-note.webm",
      "size": 20480,
      "mimeType": "audio/webm",
      "duration": 7
    }
  ]
}
```

Errors: `400` unsupported file type or size above the limit at sign time, `400` on confirm when the stored object's size/content-type differs from what was signed, `404` not a conversation member, `429` too many uploads.

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

### GET /messages/search?q=<query>&limit=<n>&cursor=<base64url> (auth required)

Searches the messages of **every conversation the caller belongs to** (there is no per-conversation variant), newest first. Each hit is a `MessageDto` plus the `conversation` it came from, so the caller can render the chat title (direct conversations have no name — their `participants` are included).

**Query:** `q` (1–100 chars, required), `limit` (1–50, default 20), `cursor` (optional, same keyset cursor as message listing).

**Matching** ignores case, accents and letter variants, across languages: `أحمد` matches `احمد`, `مَرْحَبًا` matches `مرحبا`, `Straße` matches `strasse`, `café` matches `cafe`, `٢٠٢٤` matches `2024`. Multi-word queries use AND semantics (`hello world` also finds "world, hello!"). Punctuation/emoji-only queries return an empty page. Rate limit: 30/min per user.

**Response 200:**

```json
{
  "items": [
    {
      "id": "64f123abc456def789012350",
      "conversationId": "64f123abc456def789012347",
      "content": "Hello from أحمد",
      "sender": {
        "id": "64f123abc456def789012345",
        "username": "alice",
        "displayName": "Alice",
        "avatarUrl": null
      },
      "status": "sent",
      "editedAt": null,
      "forwarded": false,
      "createdAt": "2025-10-14T12:01:00.000Z",
      "conversation": {
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
            "displayName": "Bob",
            "avatarUrl": null
          }
        ],
        "lastMessageAt": "2025-10-14T12:01:00.000Z",
        "createdAt": "2025-10-13T09:00:00.000Z"
      }
    }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

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
- Per-message delivery/read **times** are persisted on the message (`deliveredAt`/`readAt`) and exposed to the sender via `GET /conversations/:id/messages/:messageId/info` (see Messages (REST)). Direct chats honour the reader's `readReceipts`; groups ignore it.
- Attachment `url` is the absolute R2 public URL. App-relative paths (`/uploads/...`) are still accepted for attachments stored before the move to R2.
- Socket events never carry file bytes: upload media over the REST [sign → PUT → confirm](#uploads-direct-to-r2) flow first, then pass the confirmed `attachment` objects in `message:send`. `attachments` must be `[]`/omitted together with empty content, or the send is rejected.
