# AGENTS.md

## Scope

- This directory is the **backend only** (REST API + Socket.IO). Do not add React/UI code here.
- The frontend lives in the sibling directory `../frontend` (separate app, not a workspace member of this folder).

## Stack

- Node.js + TypeScript (strict), Express 5, MongoDB via Mongoose, Socket.IO.
- Auth: JWT in **httpOnly cookies** (not localStorage / not Authorization header); access + refresh tokens.
- Package manager: **pnpm** (`pnpm-lock.yaml`). Never `npm`/`yarn`.

## Commands

- `pnpm dev` — tsx watch on `src/index.ts` (needs a reachable MongoDB).
- `pnpm build` — `tsc` to `dist/`; `pnpm start` — run `dist/index.js`.
- `pnpm typecheck` — `tsc --noEmit`. Run `pnpm lint` + `pnpm typecheck` before finishing.
- `pnpm test` — Vitest. Single file: `pnpm test src/utils/token.test.ts`.
- `pnpm format` / `pnpm format:check` — Prettier (lockfile ignored via `.prettierignore`).

## Environment

- Copy `.env.example` to `.env`. `src/config/env.ts` parses env with zod at startup and `process.exit(1)`s on missing/invalid values, so any entrypoint that imports it (including `app.ts`) requires env to be set.
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` must be ≥16 chars.
- `MONGODB_URI` may contain the literal `<db_password>` placeholder; `env.ts` replaces it with URL-encoded `MONGODB_PASSWORD` and exports `mongoUri`. Use `mongoUri` for connections, not `env.MONGODB_URI`.

## Structure

- `src/index.ts` — entrypoint: connect DB, then `createServer()` + `startServer()`.
- `src/server.ts` — creates the `http.Server`, attaches the Express app **and** Socket.IO to that same server. `src/app.ts` — Express/CORS/JSON/cookie/router wiring only.
- All REST routes are mounted under `API_PREFIX = '/api/v1'` (see `src/app.ts`). Version changes = new prefix, keep old prefixes working.
- Layers: `routes/` -> `controllers/` -> `models/`; cross-cutting in `middleware/`; Socket.IO in `sockets/`; helpers in `utils/`.
- Express 5 auto-forwards rejected async handlers to the error middleware: throw `HttpError(status, msg)` or a `ZodError` (from `schema.parse`) instead of calling `res.status(...)` manually for errors.

## Chat API

- `POST /api/v1/conversations` — create (direct = exactly 1 other participant, deduped by `directKey`; group) and `GET /api/v1/conversations` — list mine (most recent first).
- `POST /api/v1/conversations/:id/messages` — send; also emits Socket.IO `message:new` to all participants' `user:<id>` rooms via `getIO()` in `sockets/index.ts`.
- `GET /api/v1/conversations/:id/messages?cursor=&limit=` — **keyset pagination**, newest first: sort `{_id: -1}`, cursor is the base64url of the oldest loaded message id, filter `_id < cursor`. Used for infinite scroll of older messages. Response: `{ items, nextCursor, hasMore }`. See `src/controllers/message.controller.ts` and `src/utils/cursor.ts`.
- Message/Conversation routes require `requireAuth` and enforce conversation membership (return 404 for non-members).

## Gotchas

- **ESM + NodeNext**: `package.json` is `"type": "module"`. Every relative import must end in `.js` (e.g. `import { env } from './config/env.js'`) even though the source is `.ts`. `verbatimModuleSyntax` is on, so type-only imports must use `import type`.
- **TypeScript is pinned to `^6.0.3`** because `typescript-eslint` peer-caps at `<6.1.0`; do not bump to 7.x without checking lint still works.
- Socket.IO auth reads the same `access_token` cookie as the REST API (manual cookie parse in `sockets/index.ts`); do not add a separate token mechanism.
- Cookie auth requires CORS with `credentials: true` and an explicit origin — `*` will not work. Access cookie path is `/`; refresh cookie is scoped to `/api/auth`.
- `express-serve-static-core`'s `Request` extends the global `Express.Request` open interface — augment `declare global { namespace Express { interface Request } }` (see `src/types/express.d.ts`), not the module.
- Express 5 types route params as `string | string[]`; normalize with the `routeParam()` helper before using `req.params.x`.
- Mongoose 9 renamed the filter type to `QueryFilter<T>` (there is no `FilterQuery` export).
- `dist/` and `node_modules/` are build output; never commit them. pnpm only allows the `esbuild` build script (see `pnpm.onlyBuiltDependencies`).
