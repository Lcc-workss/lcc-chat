# CLAUDE.md

## Project overview

Build a real-time chat application with direct messages (DMs), group chat, presence, and peer-to-peer voice/video/screen sharing.

The app uses Cloudflare Workers as the backend, Cloudflare Durable Objects for real-time conversation state, Workers KV for lightweight profile/config data, and PeerJS/WebRTC for media connections.

The frontend must be fully static and communicate only with the Worker backend through HTTP and WebSockets.

## Core stack

- **Runtime:** Cloudflare Workers
- **Real-time chat:** Cloudflare Durable Objects with WebSockets
- **Conversation history:** Durable Object SQLite storage
- **Profiles, settings, cached data:** Workers KV
- **Video, audio, screen sharing:** PeerJS (WebRTC)
- **Peer signaling:** PeerJS Cloud for development; self-hosted PeerServer for production
- **NAT traversal:** TURN server required for production reliability
- **Frontend:** Static HTML/CSS/JavaScript or a static React/Vite build
- **Frontend hosting:** Cloudflare Pages, GitHub Pages, Netlify, or any static host
- **Package manager:** pnpm preferred unless otherwise specified

## Project structure

Use exactly two top-level folders:

```text
/client
/server
```

### /client

- Contains the static frontend.
- Use plain HTML, CSS, and JavaScript, or a static React/Vite build that outputs static files.
- Do not put backend logic, secrets, database access, or Cloudflare bindings in `/client`.
- The client communicates only with the Worker API through HTTP and WebSockets.
- Make the Worker URL configurable in one place.

Create `/client/config.js`:

```js
export const WORKER_URL = "[https://your-worker.your-subdomain.workers.dev](https://your-worker.your-subdomain.workers.dev)";
```

Use this constant for every API request and WebSocket connection:

```js
const apiBase = WORKER_URL;
const wsUrl = WORKER_URL.replace(/^http/, "ws");
```

Example API call:

```js
const res = await fetch(`${WORKER_URL}/api/conversations`, {
  method: "GET",
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
```

Example WebSocket connection:

```js
const ws = new WebSocket(
  `${wsUrl}/ws?conversationId=${conversationId}`
);
```

- Never hardcode the Worker URL elsewhere in `/client`.
- If using Vite, expose it through `VITE_WORKER_URL` and keep `config.js` as the single source of truth.
- The frontend must work when served as static files from Cloudflare Pages, GitHub Pages, Netlify, or any static host.

### /server

- Contains the Cloudflare Worker backend.
- Put Workers, Durable Objects, routes, authentication, chat logic, PeerJS configuration, and bindings here.
- Use `wrangler.toml` or `wrangler.jsonc` for Worker configuration.
- Store secrets in Cloudflare Worker secrets, never in `/client`.
- Expose:
  - REST endpoints for profiles, conversations, history, and setup
  - WebSocket endpoints for realtime chat and DMs
  - PeerJS/WebRTC signaling or configuration endpoints as needed

### Required boundaries

- `/client` must never import files from `/server`.
- `/server` must never depend on frontend build tooling.
- All cross-folder communication happens through the Worker HTTP/WebSocket API.
- The only environment-specific value in `/client` is the Worker URL.

## Architecture rules

### Chat and DMs

- Use **one Durable Object instance per conversation**.
- Key DM conversations deterministically using sorted user IDs:

  ```ts
  const [a, b] = [userA, userB].sort();
  const conversationId = `dm:${a}:${b}`;
  const roomId = env.CHAT_ROOM.idFromName(conversationId);
  ```

- Use a separate Durable Object instance for each group chat.
- Relay messages through the Durable Object WebSocket connection.
- Persist messages in the Durable Object’s SQLite database.
- Never use Workers KV for live message delivery; KV is eventually consistent and unsuitable for real-time chat.
- Use D1 only if cross-conversation search, analytics, or global querying becomes necessary.

### Durable Objects

- Authenticate users before accepting a WebSocket connection.
- Verify that the authenticated user is a participant of the conversation.
- Use WebSocket hibernation where possible to reduce duration usage.
- Maintain in-object state for:
  - Connected participants
  - Online/typing presence
  - Delivery and read receipts
  - Unread message counts
- Keep Durable Object handlers small and fast; avoid CPU-heavy work.

### Workers KV

Use KV only for slowly changing or read-heavy data, such as:

- `user:<userId>` profile data
- Display names and avatars
- Public channel metadata
- Feature flags
- Cached TURN/PeerJS configuration

Do not use KV for:

- Live chat messages
- Presence
- Typing indicators
- Read receipts
- Anything requiring immediate cross-user consistency

### PeerJS / WebRTC

- PeerJS is used for peer-to-peer media: camera, microphone, and screen sharing.
- PeerJS signaling only helps peers discover each other; it does not relay media.
- Use PeerJS Cloud only for local development and prototypes.
- For production, self-host PeerServer and configure a TURN server.
- Always provide ICE servers, including TURN, to maximize connection success.
- Handle these connection states explicitly:
  - Connecting
  - Connected
  - Reconnecting
  - Failed
  - Closed
- Clean up media tracks and PeerJS connections when a call ends or the user leaves the room.

## Data model

### User

```ts
type User = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  createdAt: string;
};
```

### Conversation

```ts
type ConversationType = "dm" | "group";

type Conversation = {
  id: string;
  type: ConversationType;
  participantIds: string[];
  createdAt: string;
  lastMessageAt?: string;
};
```

### Message

```ts
type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
};
```

### WebSocket message envelope

Use a consistent client/server message format:

```ts
type ClientEvent =
  | { type: "message.send"; conversationId: string; content: string }
  | { type: "typing.start"; conversationId: string }
  | { type: "typing.stop"; conversationId: string }
  | { type: "message.read"; conversationId: string; messageIds: string[] };

type ServerEvent =
  | { type: "message.new"; message: Message }
  | { type: "presence.update"; userId: string; online: boolean }
  | { type: "typing.update"; conversationId: string; userId: string; typing: boolean }
  | { type: "message.read"; conversationId: string; userId: string; messageIds: string[] }
  | { type: "error"; code: string; message: string };
```

## API conventions

- Use REST endpoints for non-realtime operations:
  - Create user profile
  - Create DM or group conversation
  - Fetch conversation history
  - Fetch conversation list
  - Generate PeerJS configuration
- Use WebSockets for realtime operations:
  - Sending and receiving messages
  - Presence
  - Typing indicators
  - Read receipts
- Return structured JSON errors:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "You are not a participant in this conversation."
  }
}
```

## Security requirements

- Never trust client-supplied user IDs.
- Require authentication for every WebSocket connection and API request.
- Validate that users can only access conversations they belong to.
- Sanitize user-generated content before rendering.
- Rate-limit message sending and WebSocket connection attempts.
- Do not expose secrets, TURN credentials, or service bindings in frontend code.
- Use environment secrets for:
  - Auth keys
  - TURN credentials
  - PeerJS server configuration
  - Any third-party API keys

## Free-tier constraints

- Workers Free allows 100,000 requests/day.
- Durable Objects Free has hard usage caps; do not rely on overage billing.
- Prefer WebSocket hibernation to reduce Durable Object duration usage.
- Keep KV writes infrequent.
- PeerJS Cloud is not production-grade and may rate-limit or drop connections.
- TURN bandwidth can become expensive; use it only when direct peer connections fail.

## Development workflow

1. Create `/client` and `/server`.
2. Implement the Durable Object chat rooms and DM threads in `/server`.
3. Add authentication and participant authorization.
4. Build the static chat UI in `/client`.
5. Configure the Worker URL in `/client/config.js`.
6. Add optimistic message sending and reconciliation from server events.
7. Add PeerJS for one-to-one calls.
8. Add screen sharing.
9. Add group calls only after one-to-one calls are stable.
10. Replace PeerJS Cloud with self-hosted PeerServer before production.
11. Add TURN and connection-recovery handling before public testing.

## Code style

- Use TypeScript in `/server`.
- Use plain JavaScript or TypeScript in `/client`, depending on the chosen static setup.
- Keep `/client` deployable as static assets with no server-side runtime.
- Keep `/server` responsible for all authentication, authorization, persistence, and realtime coordination.
- Prefer small, focused modules:

```text
/client
  /assets
  /src
  config.js
  index.html

/server
  /src
    /durable-objects
    /routes
    /lib
  wrangler.toml
```

- Use explicit types for WebSocket events and API responses.
- Avoid `any`.
- Prefer server-side validation with Zod or a similar schema library.
- Write clear error messages that distinguish authentication, authorization, validation, and connection failures.

## Testing priorities

- Test DM creation and deterministic conversation IDs.
- Test that a user cannot join or read another user’s DM.
- Test WebSocket reconnect behavior.
- Test message persistence after Durable Object restarts.
- Test that `/client` works when the Worker URL is changed in `config.js`.
- Test PeerJS calls between two browser contexts.
- Test calls with TURN enabled.
- Test screen-share start, stop, and cleanup.

## Current priorities

- Create `/client` as a static frontend and `/server` as the Cloudflare Worker backend.
- Build DMs using one Durable Object per conversation.
- Implement live messaging with WebSockets.
- Add persistent message history.
- Add PeerJS audio/video calls.
- Add screen sharing.
- Add TURN configuration.
- Add group chats and group calls after DMs are stable.