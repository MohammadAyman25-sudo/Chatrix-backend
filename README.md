# Chatrix Backend

A real-time chat backend: REST API + Socket.IO, JWT cookie authentication, MongoDB persistence, direct-to-R2 media uploads and a persistent background job queue.

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)](https://expressjs.com)
[![MongoDB](https://img.shields.io/badge/MongoDB-Mongoose%209-47A248?logo=mongodb&logoColor=white)](https://mongoosejs.com)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4-010101?logo=socket.io&logoColor=white)](https://socket.io)
[![pnpm](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![Code style: Prettier](https://img.shields.io/badge/code_style-prettier-ff69b4)](https://prettier.io)

> This repository contains the **backend only**. The React frontend lives in a separate repository and connects to this API.

---

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Data model](#data-model)
- [Authentication & sessions](#authentication--sessions)
- [Messaging](#messaging)
- [Search](#search)
- [Rate limiting](#rate-limiting)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Direct uploads](#direct-uploads)
- [API reference](#api-reference)
- [Project structure](#project-structure)
- [Scripts](#scripts)
- [Testing](#testing)
- [Deployment notes](#deployment-notes)
- [Documentation](#documentation)
- [License](#license)

---

## Features

- **Authentication** — email/password registration and login with JWT access + refresh tokens stored in **httpOnly cookies** (never `localStorage`).
- **Email verification** — accounts are created unverified with a single-use, hashed, expiring token; login is blocked until the emailed link is redeemed. Optional via `EMAIL_VERIFICATION_ENABLED`.
- **Password security** — policy (8–72 chars, upper/lower/digit/symbol) enforced with `confirmPassword`, plus a bundled common-password list and a Have I Been Pwned k-anonymity check for breached passwords.
- **Direct & group conversations** — idempotent direct chats (deduplicated by a unique key), group name/icon management and member invitations. New members can read the full history.
- **Real-time messaging over Socket.IO** — send, edit (15-minute window), forward to chats or users, reply and _reply privately_ (auto-creates a DM with the quoted author).
- **Direct-to-R2 uploads** — attachments, voice notes, avatars and group icons go **straight from the client to Cloudflare R2** through presigned `PUT` URLs (`sign` → upload → `confirm`); the API never receives file bytes and no multipart handling exists.
- **Message status** — `sent → delivered → read` tracking with per-user read receipts. `GET /conversations/:id/messages/:messageId/info` tells the sender who received/read a message and when (direct chats honour the reader's `readReceipts` setting; groups always show every member).
- **Search** — cross-conversation message search that is case-, diacritic- and letter-variant-insensitive (`أحمد` matches `احمد`, `café` matches `cafe`).
- **Media, links & docs** — a per-conversation tab listing shared images/video/audio/files and extracted URLs, with keyset pagination.
- **Presence & ephemeral signals** — online/offline with last-seen timestamps, plus typing and recording indicators.
- **Unread counts** — each conversation reports how many messages the caller has not read.
- **Email notifications** — offline recipients get a short email preview, deduplicated per conversation; all mail runs as background jobs with retries.
- **Persistent job queue** — heavy work (email delivery, orphaned-upload cleanup) is a MongoDB-backed queue that survives restarts, retries with backoff and needs no extra infrastructure.
- **Rate limiting** — HTTP limiters per IP/user plus an in-memory fixed-window limiter for Socket.IO events.
- **Type-safe** — strict TypeScript, Zod validation at every boundary, and Vitest unit tests.

## Tech stack

| Layer           | Technology                                           |
| --------------- | ---------------------------------------------------- |
| Runtime         | Node.js ≥ 20 (ESM, `"type": "module"`)               |
| Language        | TypeScript 6 (strict, `verbatimModuleSyntax`)        |
| HTTP framework  | Express 5                                            |
| Realtime        | Socket.IO 4                                          |
| Database        | MongoDB via Mongoose 9                               |
| Validation      | Zod 4                                                |
| Auth            | `jsonwebtoken`, `bcryptjs`, httpOnly cookies         |
| Media storage   | Cloudflare R2 only (S3 SDK, presigned direct upload) |
| Background jobs | MongoDB-backed persistent job queue                  |
| Email           | Resend (with a console fallback)                     |
| Tooling         | pnpm, ESLint, Prettier, tsx, Vitest                  |

## Architecture

The app is layered so HTTP concerns never leak into business logic:

```
Client ──HTTP──▶ routes ─▶ controllers ─▶ services ─▶ models (Mongoose)
   │                          (Zod parse,    (business
   │                           cookies,       logic + DB)
   └──WebSocket──▶ sockets ─▶ services
                   (handlers / emitters)

Client ──presigned PUT──▶ Cloudflare R2        (file bytes never touch the API)
Worker ──polls──────────▶ jobs collection      (emails, orphan-upload cleanup)
```

- **`routes/`** — path + middleware wiring under `API_PREFIX = /api/v1`.
- **`controllers/`** — HTTP only: parse input with Zod, call a service, set cookies/status, serialize the response.
- **`services/`** — all business logic and database access. Zod schemas are exported from here so REST controllers and Socket.IO handlers validate identically. Also home to `upload.service.ts` (presigned-upload lifecycle), `job.service.ts` (persistent queue + worker), `storage.service.ts` (R2), `email.service.ts` and `notification.service.ts`.
- **`models/`** — Mongoose schemas and types (`User`, `Conversation`, `Message`, `Upload`, `Job`).
- **`middleware/`** — auth, error handling, rate limiting.
- **`sockets/`** — Socket.IO server, event handlers, emitters and the in-memory presence registry.
- **`utils/`** — cursors, tokens, password policy, search normalization and the fixed-window rate limiter.

`src/server.ts` attaches both the Express app and Socket.IO to the same `http.Server`. Emits target per-user rooms (`user:<id>`), never conversation rooms.

### Background jobs

Email delivery and orphaned-upload cleanup never run inside a request. `services/job.service.ts` persists jobs in a Mongo `Job` collection (`pending → running → completed | failed`): the worker claims work with an atomic `findOneAndUpdate`, retries with exponential backoff (3 attempts, persisted `runAt`), and reclaims jobs whose lock went stale. Handlers are registered per job type (`email:verification`, `email:notification-batch`, `email:message-notification`, `upload:cleanup`), payloads are plain JSON, and a `dedupeKey` index keeps singletons (like the cleanup job) unique. Under `NODE_ENV=test` an in-memory store is used automatically, so tests need no database.

## Data model

Five collections carry the whole system (see `src/models/`):

- **`User`** — `username` (unique) and `email` (unique) with a bcrypt-hashed `password`, optional `displayName`/`bio`/`avatarUrl` plus `avatarKey` (the R2 object key, `select: false`), email-verification fields (`emailVerifiedAt`, the **sha256** of the outstanding token and its expiry — both `select: false`, so a database leak exposes no usable links), `lastSeenAt`, and a `settings` subdocument (`theme: 'light' | 'dark' | 'system'`, `notifications`, `readReceipts`; `_id: false`).
- **`Conversation`** — `type: 'direct' | 'group'`, `participants[]`, group-only `name`/`avatarUrl`/`avatarKey`, `directKey` (the sorted participant ids joined with `:` — **unique**, which is what makes direct-chat creation idempotent and deduplicated), and `lastMessage`/`lastMessageAt` for list previews.
- **`Message`** — `conversation`, `sender`, `content` plus `contentNormalized` (a lowercased, mark-stripped, letter-variant-folded search copy maintained by a `pre('save')` hook and backfilled on boot — see [Search](#search)), `type: 'text' | 'image' | 'video' | 'audio' | 'file'`, `attachments[]` (`type`/`url`/`key`/`name`/`size`/`mimeType`/`width?`/`height?`/`duration?`), `replyTo`, `forwarded`, `editedAt?`, and the receipt bookkeeping: `recipients[]` (participants minus the sender), `deliveredTo[]`, `readTo[]`, and `deliveredAt`/`readAt` maps (recipient id → timestamp) powering per-message read receipts.
- **`Upload`** — one row per direct upload: `user`, `scope: 'message' | 'avatar' | 'group-icon'`, `conversation?` (null for avatars), a **unique** `key` (the R2 object key), declared `name`/`mimeType`/`size`, `actualSize?`, `duration?`, and `status: 'pending' | 'confirmed'`.
- **`Job`** — durable background work: `type`, a JSON-serializable `payload`, `status: 'pending' | 'running' | 'completed' | 'failed'`, `attempts`, `runAt` (retry backoff), `lockedAt?`, optional `dedupeKey`, `lastError?`.

## Authentication & sessions

- Logging in (or registering) sets two **httpOnly, `sameSite=lax`** cookies: `access_token` (path `/`, 15 min) and `refresh_token` (path `/api/v1/auth`, 7 days, so only the auth routes ever receive it). `secure` is enabled in production. Nothing is ever stored in `localStorage`.
- `POST /auth/refresh` rotates the pair and `POST /auth/logout` clears both. CORS runs with `credentials: true` and an explicit `CLIENT_ORIGIN` — `*` cannot work with cookie auth.
- The Socket.IO handshake reads the **same** `access_token` cookie (manual cookie parse in `sockets/index.ts`); there is no second token mechanism.
- Registration enforces the password policy in `utils/password.ts` (8–72 chars, one lowercase, one uppercase, one digit, one symbol, Latin-only, `confirmPassword` must match) and rejects compromised passwords with `isPasswordCompromised`: always the bundled common-password list, plus the Have I Been Pwned range API by k-anonymity (only a 5-char SHA-1 prefix leaves the server; network errors fail open so an outage can't block signups; `PWNED_PASSWORD_CHECK_ENABLED=false` skips the online lookup).
- With `EMAIL_VERIFICATION_ENABLED=true` (default) accounts start **unverified**: register answers `201` **without cookies**, and login answers `403` until the emailed link is redeemed. Tokens are single-use base64url strings with a 24 h TTL (only their sha256 is stored), and `POST /auth/resend-verification` always answers `202` with a fixed message so accounts cannot be enumerated.
- Authorization is membership- and owner-scoped everywhere: conversation/message routes return `404` for non-members, `/users/me*` always acts on `req.user.id`, and other users are only exposed through the `PublicProfile` projection (never email, settings, password or avatar keys). `src/routes/authorization.test.ts` asserts id-bearing routes reject unauthenticated access.

## Messaging

- **One service, two transports.** REST `POST …/messages` and socket `message:send` both call `message.service.sendMessage` and broadcast the same `message:new` to everyone **except** the sender — the sender gets the message from the HTTP response or the socket ack (`{ ok, message, clientTempId }` / `{ ok: false, error }`). The same sharing applies to edit and forward.
- **Types & attachments.** `text | image | video | audio | file`. Attachments are metadata returned by the [upload confirm step](#direct-uploads) and passed back in `attachments[]` — the bytes already live in R2 and never pass through this API.
- **Replies.** `replyToId` quotes a message in the same conversation; adding `replyPrivately: true` posts the message as a **direct message to the quoted author** instead (the direct chat is found or created; both sides receive `conversation:new`). Quoting a message from another conversation is rejected.
- **Edit** — your own text messages only, within a 15-minute window; sets `editedAt`, surfaced as the "edited" label.
- **Forward** — copies `content`/`type`/`attachments` into each target chat **using the same storage keys** (nothing is re-uploaded), re-attributed to the forwarder and flagged `forwarded`, so recipients never learn the original author. All targets are validated before any write, so a bad id can't cause a partial forward.
- **Status pipeline** `sent → delivered → read`, persisted per message in `recipients`/`deliveredTo`/`readTo` plus `deliveredAt`/`readAt` timestamps and broadcast as the conversation-scoped `message:status` event. Online recipients are marked delivered at send time, offline ones when they next connect; `message:read` marks a whole conversation read. Status is monotonic — clients must only advance it, never let `delivered` overwrite `read`.
- **Message info** — `GET …/messages/:messageId/info` (the sender only, `403` otherwise) returns who received/read a message and when. Direct chats hide the other member's read time when their `readReceipts` setting is off; groups always show every member.
- **Pagination** is keyset, newest first: the cursor is the base64url of the oldest loaded message id, and the response is `{ items, nextCursor, hasMore }`. Messages, the media tab and search all use the same scheme (the conversation list itself is simply the 50 most recent chats, sorted by `lastMessageAt`).
- **Unread counts** are computed per caller on `GET /conversations` only (one `Message.aggregate`); socket `conversation:new`/`conversation:updated` payloads deliberately omit them so clients maintain their own badge (increment on `message:new`, reset on open + `message:read`).
- **Offline notifications** — sending/forwarding queues one `email:message-notification` job per conversation batch; only **offline** recipients are emailed (online users already get `message:new`), with a short text/emoji preview, deduplicated to at most one email per conversation per 10 minutes, and honouring `settings.notifications`.

## Search

`GET /api/v1/messages/search?q=&limit=&cursor=` searches the messages of **every conversation the caller is a member of**, newest first, with the same keyset cursor as the message list. Matching is **normalization-based, not `$text`**: each message stores a `contentNormalized` copy (lowercased, diacritics/marks stripped, Arabic letter variants folded) that is tested with a case-insensitive substring match — `أحمد`/`احمد`, `مَرْحَبًا`/`مرحبا`, `Straße`/`strasse`, `café`/`cafe` all hit. Multi-word queries are split into tokens combined with **AND** semantics, and a query that normalizes to nothing (`!!!`, an emoji) returns an empty page. Each hit is a `MessageDto` plus its `conversation`, so the client can render the chat title without a second lookup.

`GET /api/v1/conversations/:id/media?type=&cursor=&limit=` powers the per-chat "Media, links and docs" tab: `type` filters by **attachment** type (`image`/`video`/`audio`/`file`) or `link` (messages containing a URL, extracted server-side), `all` is their union.

## Rate limiting

HTTP limiters (`middleware/rateLimit.middleware.ts`, `express-rate-limit`) are keyed per IP — or per user when mounted after `requireAuth`. 429 responses are `{ message }`:

| Limiter              | Applies to                           | Limit        |
| -------------------- | ------------------------------------ | ------------ |
| `globalLimiter`      | All API routes                       | 600 / 15 min |
| `authLimiter`        | register, login, verify/resend email | 10 / 15 min  |
| `refreshLimiter`     | token refresh                        | 60 / 15 min  |
| `searchLimiter`      | `users/search`, `messages/search`    | 30 / min     |
| `messageSendLimiter` | REST message send                    | 60 / min     |
| `uploadLimiter`      | `uploads/sign`                       | 30 / 15 min  |
| `attachmentLimiter`  | `uploads/:uploadId/confirm`          | 60 / min     |

`RATE_LIMIT_ENABLED=false` disables every HTTP limiter (the test setup sets this), and `TRUST_PROXY` controls how many proxies to trust so limiter keys use real client IPs.

Socket.IO events aren't HTTP, so they use the small in-memory fixed-window limiter in `utils/rateLimiter.ts`, per user: `message:send` **60/min**, `message:edit` **30/min**, `message:forward` **30/min** — a throttled event answers `ack({ ok: false, error })`. Presence, typing and recording signals are relayed as-is.

## Getting started

### Prerequisites

- **Node.js ≥ 20**
- **pnpm** (`corepack enable` is recommended)
- A reachable **MongoDB** instance (local or MongoDB Atlas)
- A **Cloudflare R2** bucket (all `R2_*` values are required — there is no local-disk fallback)

### Installation

```bash
git clone https://github.com/MohammadAyman25-sudo/Chatrix-backend.git
cd Chatrix-backend
pnpm install
```

### Configuration

Copy the example environment file and fill in the required values:

```bash
cp .env.example .env
```

At minimum you must set `MONGODB_URI`, `JWT_ACCESS_SECRET` (≥ 16 chars), `JWT_REFRESH_SECRET` (≥ 16 chars) and the `R2_*` variables. Environment variables are parsed with Zod at startup; the process exits with a readable error if anything is missing or invalid.

### Running

```bash
# Development (tsx watch, restarts on change)
pnpm dev

# Production build + start
pnpm build
pnpm start
```

The API listens on `http://localhost:5000` by default and exposes a health check at `GET /api/v1/health`.

## Environment variables

| Variable                       | Default                           | Description                                                                                     |
| ------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `NODE_ENV`                     | `development`                     | `development` \| `test` \| `production`.                                                        |
| `PORT`                         | `5000`                            | HTTP port.                                                                                      |
| `MONGODB_URI`                  | — **(required)**                  | Connection string. May contain the literal `<db_password>` placeholder.                         |
| `MONGODB_PASSWORD`             | —                                 | Substituted into `<db_password>` in `MONGODB_URI` (URL-encoded).                                |
| `CLIENT_ORIGIN`                | `http://localhost:5173`           | Allowed CORS origin **and** base URL for links in emails. Must be explicit (cookie auth).       |
| `JWT_ACCESS_SECRET`            | — **(required, ≥ 16 chars)**      | Signing secret for access tokens.                                                               |
| `JWT_REFRESH_SECRET`           | — **(required, ≥ 16 chars)**      | Signing secret for refresh tokens.                                                              |
| `JWT_ACCESS_EXPIRES_IN`        | `15m`                             | Access-token lifetime.                                                                          |
| `JWT_REFRESH_EXPIRES_IN`       | `7d`                              | Refresh-token lifetime.                                                                         |
| `TRUST_PROXY`                  | `0`                               | Number of reverse proxies in front (for real client IPs). Leave `0` when exposed directly.      |
| `RATE_LIMIT_ENABLED`           | `true`                            | Set to `false` to disable HTTP rate limiters.                                                   |
| `PWNED_PASSWORD_CHECK_ENABLED` | `true`                            | Set to `false` to skip the online HIBP check (the offline common-password list always applies). |
| `EMAIL_VERIFICATION_ENABLED`   | `true`                            | Set to `false` to skip email verification entirely.                                             |
| `EMAIL_FROM`                   | `Chatrix <onboarding@resend.dev>` | Sender shown on outgoing mail. Use an address on a domain verified in Resend.                   |
| `RESEND_API_KEY`               | —                                 | Resend API key. When unset, mail is logged to the console instead of sent.                      |
| `R2_ACCESS_KEY_ID`             | — **(required)**                  | Cloudflare R2 access key id.                                                                    |
| `R2_SECRET_ACCESS_KEY`         | — **(required)**                  | Cloudflare R2 secret access key.                                                                |
| `R2_BUCKET`                    | — **(required)**                  | R2 bucket name for all uploads.                                                                 |
| `R2_ENDPOINT`                  | — **(required)**                  | R2 S3 endpoint (`https://<account-id>.r2.cloudflarestorage.com`).                               |
| `R2_URL`                       | — **(required)**                  | Public bucket base URL used to build file URLs.                                                 |
| `R2_REGION`                    | `auto`                            | R2 region.                                                                                      |

## Direct uploads

File bytes **never pass through the API** — there is no multipart handling anywhere. Every upload (message attachments, voice notes, avatars, group icons) follows the same three-step flow against Cloudflare R2:

1. **Sign** — `POST /api/v1/uploads/sign` with `{ scope, name, size, mimeType, conversationId?, duration? }`.
   The server checks membership and per-scope limits, records a pending `Upload`, and returns a presigned `PUT`:

   ```json
   {
     "upload": {
       "id": "665f1c…",
       "key": "messages/<conversationId>/<userId>/<uuid>.png",
       "url": "https://<account-id>.r2.cloudflarestorage.com/…?X-Amz-Signature=…",
       "method": "PUT",
       "headers": { "Content-Type": "image/png" },
       "expiresAt": "2026-10-17T16:15:00.000Z"
     }
   }
   ```

2. **Upload** — the client `PUT`s the file bytes to `url`, sending **exactly** the returned headers.
   The `Content-Type` is part of the signature (a different one fails on verify), and the URL expires after 15 minutes.

3. **Confirm** — `POST /api/v1/uploads/:uploadId/confirm` re-stats the object and rejects size/content-type
   mismatches with `400` (the object is cleaned up). Confirm is idempotent and returns what the upload is for:
   - `scope: 'message'` → `{ "attachment": { type, url, key, name, size, mimeType, duration? } }` — pass it in
     `attachments` when sending the message (REST `POST …/messages` or socket `message:send`).
   - `scope: 'avatar'` → `{ "user": … }` (the previous avatar object is deleted).
   - `scope: 'group-icon'` → `{ "conversation": … }` (broadcast to members as `conversation:updated`).

### Accepted file types & sizes

The declared `mimeType` is **normalized before validation**: the base type is lowercased and any parameters after `;` are stripped, so the comparison ignores codec/charset suffixes and letter case. A browser voice note declared as `audio/webm;codecs=opus` therefore matches `audio/webm`, `Video/WebM; codecs=vp9,opus` matches `video/webm`, and `text/plain; charset=utf-8` matches `text/plain`. The **canonical base type** is what gets stored on the `Upload`, keyed into the object path and returned as `headers['Content-Type']` — send exactly that value on the `PUT`, since it is part of the presigned signature. A declaration with no base type at all (`;charset=utf-8`) is rejected.

| Scope                  | Size limit | Allowed MIME types                                   |
| ---------------------- | ---------- | ---------------------------------------------------- |
| `message`              | **100 MB** | images, videos, audio and documents (list below)     |
| `avatar`, `group-icon` | **5 MB**   | `image/jpeg`, `image/png`, `image/webp`, `image/gif` |

Message attachments (`MESSAGE_MEDIA_MIME_TYPES` in `src/utils/media.ts`):

- **Images** — `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/svg+xml`, `image/bmp`, `image/avif`, `image/tiff`, `image/heic`, `image/heif`, `image/x-icon`
- **Video** — `video/mp4`, `video/webm`, `video/quicktime`, `video/x-msvideo`, `video/x-matroska`, `video/x-ms-wmv`, `video/ogg`
- **Audio** — `audio/mpeg`, `audio/mp4`, `audio/ogg`, `audio/wav`, `audio/webm`, `audio/aac`, `audio/flac`, `audio/x-flac`, `audio/m4a`, `audio/x-m4a`, `audio/opus`, `audio/x-wav`, `audio/vnd.wave`, `audio/amr` — recorded voice notes arrive as `audio/webm;codecs=opus` and normalize to `audio/webm`
- **Documents** — `application/pdf`, Word/Excel/PowerPoint (`application/msword`, `application/vnd.ms-*`, `application/vnd.openxmlformats-officedocument.*`), OpenDocument (`application/vnd.oasis.opendocument.{text,spreadsheet,presentation}`), `application/epub+zip`, `application/rtf`, `text/markdown`, `text/plain`, `text/csv`, `application/json`
- **Archives** — `application/zip`, `application/x-zip-compressed`, `application/x-7z-compressed`, `application/vnd.rar`, `application/x-rar-compressed`, `application/gzip`, `application/x-gzip`, `application/x-tar`
- **`application/octet-stream`** — the catch-all many OSes use for documents they cannot label more precisely

Deliberately **not** accepted, even though the size limit would allow them: renderable markup (`text/html`, `application/xhtml+xml`, `application/xml`) and executable formats — those would be an XSS/malware vector when opened directly from the public bucket. Avatars and group icons accept only the four image types above.

`conversationId` is required for `message`/`group-icon` scopes (membership is checked at sign time — non-members get `404`, so ids can't be probed) and rejected for `avatar`. On confirm, a size or content-type mismatch with what was signed is rejected with `400` and the object is deleted. Never-confirmed uploads are swept after 24 hours by the background `upload:cleanup` job.

See [`API_EXAMPLES.md`](./API_EXAMPLES.md) and [`requests.http`](./requests.http) for runnable examples of each scope.

## API reference

All routes are mounted under `/api/v1`. Authentication uses the `access_token` httpOnly cookie; send requests with credentials. Errors use a consistent shape: `{ "message": "..." }` (validation failures add an `issues` array).

### Endpoints

| Method   | Endpoint                                                | Description                                           | Auth |
| -------- | ------------------------------------------------------- | ----------------------------------------------------- | :--: |
| `GET`    | `/api/v1/health`                                        | Liveness probe.                                       |  –   |
| `POST`   | `/api/v1/auth/register`                                 | Create an account (may require email verification).   |  –   |
| `POST`   | `/api/v1/auth/login`                                    | Log in and set auth cookies.                          |  –   |
| `POST`   | `/api/v1/auth/refresh`                                  | Rotate the session using the refresh cookie.          |  –   |
| `POST`   | `/api/v1/auth/logout`                                   | Clear auth cookies.                                   |  –   |
| `GET`    | `/api/v1/auth/me`                                       | Current user.                                         |  ✓   |
| `POST`   | `/api/v1/auth/verify-email`                             | Redeem a verification token.                          |  –   |
| `POST`   | `/api/v1/auth/resend-verification`                      | Re-send the verification email.                       |  –   |
| `GET`    | `/api/v1/users/me/settings`                             | Read the caller's settings.                           |  ✓   |
| `PATCH`  | `/api/v1/users/me/settings`                             | Update `theme`, `notifications`, `readReceipts`.      |  ✓   |
| `PATCH`  | `/api/v1/users/me`                                      | Update `displayName` / `bio`.                         |  ✓   |
| `DELETE` | `/api/v1/users/me/avatar`                               | Remove the caller's avatar.                           |  ✓   |
| `GET`    | `/api/v1/users/search?q=&limit=`                        | Find people to chat with.                             |  ✓   |
| `GET`    | `/api/v1/users/:userId`                                 | Another user's public profile.                        |  ✓   |
| `POST`   | `/api/v1/uploads/sign`                                  | Presign a direct upload (returns a `PUT` URL).        |  ✓   |
| `POST`   | `/api/v1/uploads/:uploadId/confirm`                     | Verify the upload landed and apply/return it.         |  ✓   |
| `POST`   | `/api/v1/conversations`                                 | Create a direct or group conversation.                |  ✓   |
| `GET`    | `/api/v1/conversations`                                 | List the caller's conversations (with `unreadCount`). |  ✓   |
| `PATCH`  | `/api/v1/conversations/:id`                             | Rename a group.                                       |  ✓   |
| `DELETE` | `/api/v1/conversations/:id/avatar`                      | Remove a group icon.                                  |  ✓   |
| `POST`   | `/api/v1/conversations/:id/participants`                | Invite users to a group.                              |  ✓   |
| `GET`    | `/api/v1/conversations/:id/presence`                    | Online/last-seen for participants.                    |  ✓   |
| `GET`    | `/api/v1/conversations/:id/messages`                    | List messages (keyset pagination).                    |  ✓   |
| `GET`    | `/api/v1/conversations/:id/media`                       | Media, links and documents shared in a conversation.  |  ✓   |
| `POST`   | `/api/v1/conversations/:id/messages`                    | Send a message (JSON; attachments come from uploads). |  ✓   |
| `PATCH`  | `/api/v1/conversations/:id/messages/:messageId`         | Edit your own text message (within 15 minutes).       |  ✓   |
| `GET`    | `/api/v1/conversations/:id/messages/:messageId/info`    | Delivery/read info for your own message (sender).     |  ✓   |
| `POST`   | `/api/v1/conversations/:id/messages/:messageId/forward` | Forward a message to chats and/or users.              |  ✓   |
| `GET`    | `/api/v1/messages/search?q=&limit=&cursor=`             | Search messages across your conversations.            |  ✓   |

Avatars and group icons use the same [direct uploads](#direct-uploads) flow (`scope: 'avatar'` / `scope: 'group-icon'`) followed by the matching `confirm`.

### Socket.IO

Connect to the same origin; the server reads the `access_token` cookie during the handshake. Events are delivered to **per-user rooms** (`user:<id>`), never conversation rooms.

`message:send`, `message:edit` and `message:forward` are **acknowledged**: the ack resolves to `{ ok: true, ... }` (e.g. `{ ok, message, clientTempId }`, `{ ok, message }`, `{ ok, messages, conversations? }`) or `{ ok: false, error }` — including when the per-user socket throttles reject the event (see [Rate limiting](#rate-limiting)). The sender never receives their own `message:new` / `message:edited`; they get the result from the ack.

**Client → server**

| Event             | Payload                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `message:send`    | `{ conversationId, content?, clientTempId?, type?, attachments?, replyToId?, replyPrivately? }` |
| `message:edit`    | `{ conversationId, messageId, content }`                                                        |
| `message:forward` | `{ conversationId, messageId, conversationIds?, userIds? }`                                     |
| `typing:start`    | `{ conversationId }`                                                                            |
| `typing:stop`     | `{ conversationId }`                                                                            |
| `recording:start` | `{ conversationId }`                                                                            |
| `recording:stop`  | `{ conversationId }`                                                                            |
| `message:read`    | `{ conversationId }`                                                                            |

**Server → client**

| Event                  | Payload                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `message:new`          | `MessageDto`                                                    |
| `message:edited`       | `MessageDto`                                                    |
| `conversation:new`     | `ConversationDto`                                               |
| `conversation:updated` | `ConversationDto`                                               |
| `typing:update`        | `{ conversationId, userId, isTyping }`                          |
| `recording:update`     | `{ conversationId, userId, isRecording }`                       |
| `message:status`       | `{ conversationId, userId, status: 'delivered' \| 'read', at }` |
| `presence:update`      | `{ userId, status: 'online' \| 'offline', lastSeenAt }`         |

See [API_EXAMPLES.md](./API_EXAMPLES.md) for full request/response examples.

## Project structure

```
src/
├── app.ts                 # Express app: CORS, JSON, cookies, routers
├── server.ts              # http.Server + Socket.IO wiring
├── index.ts               # Entrypoint: connect DB, start server + job worker, shutdown
├── config/                # env parsing (Zod) and MongoDB connection
├── models/                # Mongoose schemas (User, Conversation, Message, Upload, Job)
├── routes/                # Route definitions mounted under /api/v1
├── controllers/           # HTTP layer (Zod parsing, cookies, responses)
├── services/              # Business logic, DB access, uploads, storage, job queue, mail
├── middleware/            # Auth, error handling, rate limiting
├── sockets/               # Socket.IO server, handlers, emitters, presence
├── types/                 # Shared DTOs and type augmentations
└── utils/                 # Tokens, cursors, password policy, search helpers, …
```

## Scripts

| Script              | Description                     |
| ------------------- | ------------------------------- |
| `pnpm dev`          | Start in watch mode with `tsx`. |
| `pnpm build`        | Compile TypeScript to `dist/`.  |
| `pnpm start`        | Run the compiled server.        |
| `pnpm typecheck`    | Type-check without emitting.    |
| `pnpm lint`         | Run ESLint.                     |
| `pnpm format`       | Format with Prettier.           |
| `pnpm format:check` | Check formatting.               |
| `pnpm test`         | Run the Vitest suite.           |

## Testing

```bash
# Whole suite
pnpm test

# A single file
pnpm test src/utils/token.test.ts
```

Tests are unit-focused (schemas, pure helpers, middleware, services) and do not require a database or network access: Socket.IO emission and email delivery are no-ops under `NODE_ENV=test`, and the job queue automatically runs on an in-memory store (`resetJobQueue()` / `drainJobQueue()` control it).

## Deployment notes

- Set `NODE_ENV=production`, real secrets, `CLIENT_ORIGIN` to the frontend origin, and `TRUST_PROXY` when running behind a reverse proxy.
- All uploads go directly to Cloudflare R2: set the `R2_*` variables (the env schema requires them), and give the bucket a **CORS policy** that allows the frontend origin to `PUT` objects with the `Content-Type` header — browsers upload straight to R2, bypassing this API.
- To send real email, set `RESEND_API_KEY` and an `EMAIL_FROM` address on a domain verified with Resend.
- **Background jobs are durable:** the `jobs` collection persists across restarts and failed jobs are retried with backoff. The worker timer itself is per-process — run a single instance, or tune the stale-lock reclaim for multiple instances.
- **Other in-memory state:** presence, Socket.IO rate limiting and notification deduplication are per-process. This is fine for a single instance; a multi-instance deployment would need a shared store (e.g. Redis).

## Documentation

- [`AGENTS.md`](./AGENTS.md) — architecture, conventions and implementation notes.
- [`API_EXAMPLES.md`](./API_EXAMPLES.md) — request/response examples for every endpoint (including the direct-upload flow).
- [`requests.http`](./requests.http) — ready-to-run HTTP requests (VS Code REST Client / JetBrains).

## License

No license file is included in this repository. All rights are reserved by the author unless a license is added.
