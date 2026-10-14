# lcc-chat

Realtime chat with **no sign-up**: pick a display name and start talking.

Direct messages, group chats, presence, typing indicators, read receipts,
message history, and peer-to-peer audio / video / screen sharing.

```
lcc-chat
├── /client   static frontend (plain HTML/CSS/JS, no build step)
└── /server   Cloudflare Worker (Durable Objects + KV + WebSockets)
```

---

## What it does

| Feature | How it works |
| --- | --- |
| No sign-up | `POST /api/session` with a display name → HMAC-signed token in `localStorage`. No email, no password, no third-party identity. |
| Direct messages | Deterministic conversation ids (`dm:<sorted>:<sorted>`), one Durable Object per thread. |
| Group chats | One Durable Object per group, membership checked on every request and socket. |
| Live messaging | WebSockets relayed through the conversation's Durable Object, with WebSocket hibernation. |
| History | Durable Object SQLite (`messages` + `participants`), cursor pagination. |
| Presence & typing | Durable Object state + a global presence registry with heartbeats and a stale sweep. |
| Unread counts & read receipts | Per-user watermark in the room's SQLite, broadcast over the room socket. |
| Missed messages | A per-user "notification hub" socket delivers messages for chats that are not on screen. |
| 1:1 calls & screen share | PeerJS for signalling (host + ICE servers served by the Worker), WebRTC for media. |
| Group calls | WebRTC mesh signalled through lcc-chat's own `call.signal` relay. |
| Resilience | Exponential-backoff reconnects, optimistic sends with reconciliation, offline queueing state in the UI. |

---

## Quick start

Requirements: Node 20+ and pnpm. A Cloudflare account is only needed to deploy.
**No API keys, no secrets, no accounts, no sign-up.**

### 1. Worker (backend)

```bash
pnpm install
pnpm dev          # http://0.0.0.0:8787
```

`wrangler dev` emulates Durable Objects (with SQLite) and KV locally, so
everything works offline. It binds `0.0.0.0` so a forwarded/tunnelled port can
reach it.

### 2. Client (frontend)

Any static server works — there is no build step:

```bash
pnpm client       # http://0.0.0.0:5173
```

Open the printed address. `client/config.js` already points at the Worker, and
the app falls back to the local `127.0.0.1:8787` instance when the configured
Worker does not answer.

### 3. Tests

```bash
pnpm test              # 56 API + WebSocket assertions against the local Worker
pnpm test:browser      # 29 browser assertions (3 contexts, real WebRTC call)
```

`pnpm test:browser` also needs a Chromium build:
`npx playwright@1.49.1 install chromium`.

---

## Configuration

### `/client` — one environment-specific value

`client/config.js`:

```js
const DEFAULT_WORKER_URL = "http://127.0.0.1:8787";   // edit this
export const WORKER_URL  = …;                        // configured value
```

Every REST call and both WebSockets are derived from it. To point the same build
at a deployed Worker, change that one line — or override it per browser without
editing the file:

```
http://localhost:5173/?worker=https://lcc-chat.<subdomain>.workers.dev
```

On boot the app probes `WORKER_URL`. If it does not answer (a forwarded port
that still needs a sign-in, a Worker that is not running yet, …) it falls back
to the local `http://127.0.0.1:8787` instance for that tab and says so in the
console and the sidebar, so development never dead-ends.

WebRTC uses a single STUN server (`stun:stun.l.google.com:19302`, configured in
`server/wrangler.toml` as `STUN_URLS`) plus TURN once you add credentials.

### `/server` — Worker configuration

`server/wrangler.toml` holds the bindings (`CHAT_ROOM`, `USER_SESSION`,
`PRESENCE`, `PROFILES`) and tunables. **Nothing here is required to run
lcc-chat** — every value has a working default. For a real deployment:

```bash
pnpm kv:create      # PROFILES namespace -> paste the id into server/wrangler.toml
pnpm deploy
```

Optional upgrades, in order of impact:

```bash
wrangler secret put TOKEN_SECRET --config server/wrangler.toml   # sessions survive restarts
wrangler secret put TURN_URL --config server/wrangler.toml      # calls connect more reliably
wrangler secret put TURN_USERNAME --config server/wrangler.toml
wrangler secret put TURN_CREDENTIAL --config server/wrangler.toml
```

TURN credentials are never compiled into `/client`; authenticated browsers fetch
them from `GET /api/media/config`.

---

## Deploying the frontend

`/client` is plain static files, so any static host works:

```bash
pnpm deploy                                  # 1. Worker
cd client && npx wrangler pages deploy .     # 2. Pages (or Netlify / GitHub Pages / nginx)
```

Set the Worker URL in `client/config.js` to the deployed Worker (or use the
`?worker=` override) before you ship the static files.

---

## Architecture

### Durable Objects

| Class | Instance | Responsibility |
| --- | --- | --- |
| `ChatRoom` | one per conversation | message history (SQLite), room WebSocket fan-out, typing, read receipts, unread counts, call roster |
| `UserSession` | one per user | notification hub socket: messages/presence/call signals for chats that are not open |
| `Presence` | one global | who is online, heartbeats, stale sweep, broadcast of `presence.update` |

WebSockets use the **hibernation API** (`serializeAttachment` + handler
methods), so idle rooms cost nothing while clients stay connected.

### Workers KV

Only slowly changing, read-heavy data lives in KV:

```
user:<userId>              -> profile
conversations:<userId>     -> conversation ids
handle:<username>          -> user id
directory                  -> recent user ids (search scans the newest 300)
```

Live messages, presence, typing and read receipts never touch KV — they are
eventually consistent and cannot deliver live events.

### Security

- Session tokens are HMAC-SHA256 signed; the user id always comes from the
  verified token, never from a request body.
- Durable Objects re-verify the token *and* membership before accepting a
  WebSocket or returning history.
- All input is validated with zod; text is stripped of control/zero-width
  characters and length-clamped server-side, and rendered as text nodes.
- Per-isolate rate limits on sessions, message sends, typing bursts, socket
  connections and call attempts.
- CORS is open on purpose (the client is a static file on any host) and safe
  because auth is a bearer token, never a cookie.

---

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/session` | start a session (no sign-up) |
| `GET`/`PATCH` | `/api/me` | read/update the caller's profile |
| `GET` | `/api/users?q=` | find people to talk to |
| `GET` | `/api/presence` | who is online |
| `GET` | `/api/media/config` | PeerJS signalling + ICE/TURN servers |
| `GET` | `/api/conversations` | conversation list with unread counts |
| `POST` | `/api/conversations/dm` | open (or re-open) a DM |
| `POST` | `/api/conversations/group` | create a group |
| `GET` | `/api/conversations/:id` | one conversation |
| `GET` | `/api/conversations/:id/messages` | history (`?before=<cursor>&limit=`) |
| `POST` | `/api/conversations/:id/read` | read receipts (REST fallback) |
| `GET` | `/ws?conversationId=…&token=…` | room socket |
| `GET` | `/ws/session?token=…` | notification hub socket |

WebSocket frames use one envelope for both directions:

```jsonc
// client -> server
{ "type": "message.send", "conversationId": "dm:…", "content": "hi", "clientMessageId": "c_1" }
{ "type": "typing.start" | "typing.stop" | "message.read" | "message.edit" | "message.delete" | "call.signal" }

// server -> client
{ "type": "message.new", "message": { … } }
{ "type": "presence.update" | "typing.update" | "message.read" | "call.signal" | "call.participants" }
{ "type": "conversation.created" | "message.updated" | "message.deleted" | "ready" | "pong" | "error" }
```

---

## Before going public

lcc-chat works out of the box; these are the optional hardening steps:

- [ ] Create the `PROFILES` KV namespace (`pnpm kv:create`) and put its id in
      `server/wrangler.toml`
- [ ] `wrangler secret put TOKEN_SECRET` so sessions survive Worker restarts
- [ ] Add TURN (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`) — direct P2P
      fails for many users without it
- [ ] Self-host PeerServer and set `PEER_HOST`/`PEER_PORT`/`PEER_PATH`/`PEER_SECURE`
      (PeerJS Cloud is free and fine for small groups, but rate-limits)
- [ ] Move user search to D1 once the KV directory outgrows its 5 000-entry cap
- [ ] Review `MESSAGES_PER_MINUTE`, `MAX_MESSAGE_LENGTH` and the Durable Object
      free-tier caps for your expected traffic