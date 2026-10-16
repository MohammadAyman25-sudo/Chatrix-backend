# Chatrix Backend

A real-time chat backend: REST API + Socket.IO, JWT cookie authentication, MongoDB persistence, media storage and email notifications.

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
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
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
- **Password security** — configurable policy (length, character classes) and a Have I Been Pwned k-anonymity check for breached passwords.
- **Direct & group conversations** — idempotent direct chats (deduplicated by a unique key), group name/icon management and member invitations. New members can read the full history.
- **Real-time messaging over Socket.IO** — send, edit (15-minute window), forward to chats or users, reply and _reply privately_ (auto-creates a DM with the quoted author).
- **Attachments** — images, video, audio (voice notes) and documents via multipart upload, with a pluggable storage layer (local disk or Cloudflare R2).
- **Message status** — `sent → delivered → read` tracking with per-user read receipts (respecting the reader's privacy setting).
- **Presence & ephemeral signals** — online/offline with last-seen timestamps, plus typing and recording indicators.
- **Unread counts** — each conversation reports how many messages the caller has not read.
- **Email notifications** — offline recipients get a short email preview, deduplicated per conversation; all mail is queued in the background with retries.
- **Rate limiting** — HTTP limiters per IP/user plus an in-memory fixed-window limiter for Socket.IO events.
- **Type-safe** — strict TypeScript, Zod validation at every boundary, and Vitest unit tests.

## Tech stack

| Layer          | Technology                                           |
| -------------- | ---------------------------------------------------- |
| Runtime        | Node.js ≥ 20 (ESM, `"type": "module"`)               |
| Language       | TypeScript 6 (strict, `verbatimModuleSyntax`)        |
| HTTP framework | Express 5                                            |
| Realtime       | Socket.IO 4                                          |
| Database       | MongoDB via Mongoose 9                               |
| Validation     | Zod 4                                                |
| Auth           | `jsonwebtoken`, `bcryptjs`, httpOnly cookies         |
| Media storage  | Local disk or Cloudflare R2 (AWS S3 SDK, path-style) |
| Email          | Resend (with a console fallback)                     |
| Tooling        | pnpm, ESLint, Prettier, tsx, Vitest                  |

## Architecture

The app is layered so HTTP concerns never leak into business logic:

```
Client ──HTTP──▶ routes ─▶ controllers ─▶ services ─▶ models (Mongoose)
   │                          (Zod parse,    (business
   │                           cookies,       logic + DB)
   └──WebSocket──▶ sockets ─▶ services
                   (handlers / emitters)
```

- **`routes/`** — path + middleware wiring under `API_PREFIX = /api/v1`.
- **`controllers/`** — HTTP only: parse input with Zod, call a service, set cookies/status, serialize the response.
- **`services/`** — all business logic and database access. Zod schemas are exported from here so REST controllers and Socket.IO handlers validate identically.
- **`models/`** — Mongoose schemas and types.
- **`middleware/`** — auth, error handling, rate limiting, uploads.
- **`sockets/`** — Socket.IO server, event handlers, emitters and the in-memory presence registry.
- **`utils/`** — cursors, tokens, password policy, the in-memory job queue and rate limiter.

`src/server.ts` attaches both the Express app and Socket.IO to the same `http.Server`. Emits target per-user rooms (`user:<id>`), never conversation rooms.

## Getting started

### Prerequisites

- **Node.js ≥ 20**
- **pnpm** (`corepack enable` is recommended)
- A reachable **MongoDB** instance (local or MongoDB Atlas)

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

At minimum you must set `MONGODB_URI`, `JWT_ACCESS_SECRET` (≥ 16 chars) and `JWT_REFRESH_SECRET` (≥ 16 chars). Environment variables are parsed with Zod at startup; the process exits with a readable error if anything is missing or invalid.

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
| `MEDIA_DISK`                   | `local`                           | `local` (writes to `./uploads`, served at `/uploads`) or `r2` (Cloudflare R2).                  |
| `R2_ACCESS_KEY_ID`             | —                                 | Required when `MEDIA_DISK=r2`.                                                                  |
| `R2_SECRET_ACCESS_KEY`         | —                                 | Required when `MEDIA_DISK=r2`.                                                                  |
| `R2_BUCKET`                    | —                                 | Required when `MEDIA_DISK=r2`.                                                                  |
| `R2_ENDPOINT`                  | —                                 | Required when `MEDIA_DISK=r2`.                                                                  |
| `R2_URL`                       | —                                 | Public base URL used to build file URLs. Required when `MEDIA_DISK=r2`.                         |
| `R2_REGION`                    | `auto`                            | R2 region.                                                                                      |

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
| `POST`   | `/api/v1/users/me/avatar`                               | Upload the caller's avatar (multipart `avatar`).      |  ✓   |
| `DELETE` | `/api/v1/users/me/avatar`                               | Remove the caller's avatar.                           |  ✓   |
| `GET`    | `/api/v1/users/search?q=&limit=`                        | Find people to chat with.                             |  ✓   |
| `GET`    | `/api/v1/users/:userId`                                 | Another user's public profile.                        |  ✓   |
| `POST`   | `/api/v1/conversations`                                 | Create a direct or group conversation.                |  ✓   |
| `GET`    | `/api/v1/conversations`                                 | List the caller's conversations (with `unreadCount`). |  ✓   |
| `PATCH`  | `/api/v1/conversations/:id`                             | Rename a group.                                       |  ✓   |
| `POST`   | `/api/v1/conversations/:id/avatar`                      | Set/replace a group icon (multipart `avatar`).        |  ✓   |
| `DELETE` | `/api/v1/conversations/:id/avatar`                      | Remove a group icon.                                  |  ✓   |
| `POST`   | `/api/v1/conversations/:id/participants`                | Invite users to a group.                              |  ✓   |
| `GET`    | `/api/v1/conversations/:id/presence`                    | Online/last-seen for participants.                    |  ✓   |
| `GET`    | `/api/v1/conversations/:id/messages`                    | List messages (keyset pagination).                    |  ✓   |
| `POST`   | `/api/v1/conversations/:id/messages`                    | Send a message (JSON or multipart `files`).           |  ✓   |
| `PATCH`  | `/api/v1/conversations/:id/messages/:messageId`         | Edit your own text message (within 15 minutes).       |  ✓   |
| `POST`   | `/api/v1/conversations/:id/messages/:messageId/forward` | Forward a message to chats and/or users.              |  ✓   |
| `POST`   | `/api/v1/conversations/:id/attachments`                 | Upload message media and get attachment metadata.     |  ✓   |

### Socket.IO

Connect to the same origin; the server reads the `access_token` cookie during the handshake. Events are delivered to per-user rooms.

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
├── index.ts               # Entrypoint: connect DB, start server, graceful shutdown
├── config/                # env parsing (Zod) and MongoDB connection
├── models/                # Mongoose schemas (User, Conversation, Message)
├── routes/                # Route definitions mounted under /api/v1
├── controllers/           # HTTP layer (Zod parsing, cookies, responses)
├── services/              # Business logic, DB access, mail queue, storage
├── middleware/            # Auth, error handling, rate limiting, uploads
├── sockets/               # Socket.IO server, handlers, emitters, presence
├── types/                 # Shared DTOs and type augmentations
└── utils/                 # Tokens, cursors, password policy, job queue, …
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

Tests are unit-focused (schemas, pure helpers, middleware) and do not require a database or network access. Socket.IO emission and email delivery are no-ops under `NODE_ENV=test`.

## Deployment notes

- Set `NODE_ENV=production`, real secrets, `CLIENT_ORIGIN` to the frontend origin, and `TRUST_PROXY` when running behind a reverse proxy.
- For object storage, set `MEDIA_DISK=r2` and the `R2_*` variables; otherwise uploads are written to `./uploads` and served from `/uploads`.
- To send real email, set `RESEND_API_KEY` and an `EMAIL_FROM` address on a domain verified with Resend.
- **In-memory state:** presence, Socket.IO rate limiting, the email queue and notification deduplication are per-process. This is fine for a single instance; a multi-instance deployment would need a shared store/broker (e.g. Redis).

## Documentation

- [`AGENTS.md`](./AGENTS.md) — architecture, conventions and implementation notes.
- [`API_EXAMPLES.md`](./API_EXAMPLES.md) — request/response examples for every endpoint.
- [`requests.http`](./requests.http) — ready-to-run HTTP requests (VS Code REST Client / JetBrains).

## License

No license file is included in this repository. All rights are reserved by the author unless a license is added.
