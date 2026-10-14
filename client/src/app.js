import { APP_NAME, WORKER_URL, activeWsBaseUrl, resolveWorkerUrl } from "../config.js";
import { api, getToken, setToken, ApiError } from "./api.js";
import { createStore, sortConversations, upsertConversation, mergeUsers, upsertMessage, findConversation } from "./store.js";
import { RealtimeSocket, ConnectionState } from "./realtime.js";
import { MediaManager } from "./media.js";
import { template, qs, clear } from "./ui/dom.js";
import { toast } from "./ui/overlays.js";
import { renderOnboarding } from "./ui/onboarding.js";
import { createSidebar, notifyConnection } from "./ui/sidebar.js";
import { createChatView } from "./ui/chat.js";
import { openNewChat, openPeople } from "./ui/people.js";
import { openSettings } from "./ui/settings.js";

/**
 * lcc-chat client bootstrap.
 *
 * One app-level object owns: the store, both WebSockets (the per-user
 * notification hub and the active room), the media manager and the views.
 */
class App {
  constructor() {
    this.state = createStore({
      me: null,
      conversations: [],
      users: new Map(),
      presence: new Set(),
      messages: {}, // conversationId -> { messages, hasMore, cursor, loading }
      readReceipts: {}, // conversationId -> { userId, messageIds, readAt }
      activeConversationId: null,
      connection: ConnectionState.CLOSED,
      callParticipants: [],
    });

    this.media = new MediaManager(this);
    this.mediaConfig = null;
    this.roomSocket = null;
    this.hubSocket = null;
    this.pendingTypingStop = null;
    this.lastTypingSentAt = 0;
    this.revalidating = false;
  }

  /* --------------------------------------------------------- lifecycle */

  async boot() {
    const root = qs("#app");

    // Find a Worker that actually answers: the configured one, or the local
    // `pnpm dev` instance when the configured one is unreachable.
    const { usedFallback } = await resolveWorkerUrl();
    if (usedFallback) {
      toast(`Using the local Worker — ${WORKER_URL} is not answering.`, { kind: "warn", timeout: 6000 });
    }

    // The token alone is not enough: verify it (and pick up a 401 immediately).
    if (getToken()) {
      try {
        const { user } = await api.me();
        this.start(user);
        return;
      } catch (error) {
        if (!(error instanceof ApiError) || !error.isAuthError) {
          toast("Cannot reach the lcc-chat Worker yet.", { kind: "error" });
        }
        setToken(null);
      }
    }

    root.dataset.state = "onboarding";
    renderOnboarding(this);
  }

  start(me) {
    const root = qs("#app");
    root.dataset.state = "ready";
    root.replaceChildren(template("tpl-shell"));

    this.state.set({ me });
    this.sidebar = createSidebar(this);
    this.chat = createChatView(this);
    this.sidebar.render();

    // Desktop notifications are opt-in; ask only once the app is usable.
    if ("Notification" in window && Notification.permission === "default") {
      setTimeout(() => {
        if (Notification.permission === "default") Notification.requestPermission().catch(() => undefined);
      }, 4000);
    }

    this.#connectHub();
    this.refreshConversations().catch((error) => toast(error.message, { kind: "error" }));
    api
      .mediaConfig()
      .then((config) => {
        this.mediaConfig = config;
        this.media.rememberConfig(config);
        // Register with the signalling server so calls connect instantly.
        this.media.prewarm().catch(() => undefined);
      })
      .catch(() => undefined);

    window.addEventListener("online", () => this.#retrySockets());
    window.addEventListener("offline", () => toast("You are offline — lcc-chat will reconnect.", { kind: "warn" }));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.#retrySockets();
    });
  }

  /* ------------------------------------------------------------ sockets */

  #connectHub() {
    const token = getToken();
    if (!token) return;

    this.hubSocket = new RealtimeSocket({
      url: `${activeWsBaseUrl()}/ws/session?token=${encodeURIComponent(token)}`,
      ping: true,
      onState: (state) => {
        this.state.set({ connection: state });
        notifyConnection(state);
        this.sidebar.invalidate();
        this.sidebar.render();
      },
      onEvent: (event) => this.#onHubEvent(event),
    });
    this.hubSocket.open();
  }

  #retrySockets() {
    this.hubSocket?.retryNow();
    if (this.roomSocket && this.roomSocket.state !== ConnectionState.OPEN) this.roomSocket.retryNow();
  }

  #openRoom(conversationId) {
    if (this.roomSocket?.conversationId === conversationId) return;
    this.roomSocket?.close();
    if (!conversationId) {
      this.roomSocket = null;
      return;
    }

    const token = getToken();
    this.roomSocket = new RealtimeSocket({
      url: `${activeWsBaseUrl()}/ws?conversationId=${encodeURIComponent(conversationId)}&token=${encodeURIComponent(token ?? "")}`,
      ping: true,
      onState: (state) => {
        qs("#chat-panel")?.classList.toggle("chat__panel--offline", state !== ConnectionState.OPEN);
        this.#setConnectionHint();
        if (state === ConnectionState.FAILED) {
          toast("This conversation lost its connection. Retrying…", { kind: "error", timeout: 6000 });
          this.#revalidateSession();
        }
      },
      onEvent: (event) => this.#onRoomEvent(event),
    });
    this.roomSocket.conversationId = conversationId;
    this.roomSocket.open();
  }

  /* ------------------------------------------------------------- events */

  #onHubEvent(event) {
    switch (event.type) {
      case "message.new": {
        const state = this.state.get();
        const conversation = findConversation(state, event.message.conversationId);
        const isActive = state.activeConversationId === event.message.conversationId;
        if (!isActive) {
          this.state.set({
            conversations: upsertConversation(state, {
              ...(conversation ?? { id: event.message.conversationId, type: "dm", title: "New chat", participantIds: [event.message.senderId], createdAt: event.message.createdAt }),
              lastMessage: event.message,
              lastMessageAt: event.message.createdAt,
              unread: (conversation?.unread ?? 0) + 1,
            }),
          });
          this.#notify(event.message, conversation?.title ?? "lcc-chat");
        }
        this.sidebar.invalidate();
        this.sidebar.render();
        return;
      }
      case "message.updated": {
        const state = this.state.get();
        const thread = state.messages[event.message.conversationId];
        if (thread) {
          this.state.set({
            messages: {
              ...state.messages,
              [event.message.conversationId]: {
                ...thread,
                messages: upsertMessage(thread.messages, event.message),
              },
            },
          });
          this.chat?.render(this.state.get());
          if (state.activeConversationId === event.message.conversationId) {
            this.sidebar.invalidate();
            this.sidebar.render();
          }
        }
        return;
      }
      case "message.deleted": {
        const state = this.state.get();
        const thread = state.messages[event.conversationId];
        if (thread) {
          this.state.set({
            messages: {
              ...state.messages,
              [event.conversationId]: {
                ...thread,
                messages: upsertMessage(thread.messages, {
                  id: event.messageId,
                  conversationId: event.conversationId,
                  senderId: event.senderId,
                  content: "",
                  createdAt: thread.messages.find((m) => m.id === event.messageId)?.createdAt ?? new Date().toISOString(),
                  deletedAt: new Date().toISOString(),
                }),
              },
            },
          });
        }
        this.chat?.render(this.state.get());
        return;
      }
      case "message.read": {
        const state = this.state.get();
        const current = state.readReceipts[event.conversationId];
        if (!current || event.readAt >= current.readAt) {
          this.state.set({
            readReceipts: {
              ...state.readReceipts,
              [event.conversationId]: { userId: event.userId, messageIds: event.messageIds, readAt: event.readAt },
            },
          });
        }
        if (event.conversationId === state.activeConversationId) this.chat?.render(this.state.get());
        return;
      }
      case "presence.update": {
        const state = this.state.get();
        const presence = new Set(state.presence);
        if (event.online) presence.add(event.userId);
        else presence.delete(event.userId);
        this.state.set({ presence });
        this.sidebar.invalidate();
        this.sidebar.render();
        this.chat?.render(this.state.get());
        return;
      }
      case "conversation.created": {
        const state = this.state.get();
        if (state.conversations.some((entry) => entry.id === event.conversation.id)) return;
        this.state.set({ conversations: upsertConversation(state, event.conversation) });
        this.sidebar.invalidate();
        this.sidebar.render();
        toast(`Added you to “${event.conversation.title}”.`, {
          kind: "info",
          action: { label: "Open", onClick: () => this.selectConversation(event.conversation.id) },
        });
        return;
      }
      case "call.participants": {
        const participants = event.participants ?? [];
        this.state.set({ callParticipants: participants });
        qs("#leave-call")?.toggleAttribute("hidden", !participants.includes(this.state.get().me.id));
        // Self-healing: make sure we hold a connection to everyone in the call.
        this.media.syncRoster(participants);
        return;
      }
      case "call.signal": {
        // Signalling can arrive through the hub when the room is not open.
        this.#onCallSignal(event.from, event.payload);
        return;
      }
      default:
        return;
    }
  }

  #onRoomEvent(event) {
    const conversationId = this.state.get().activeConversationId;
    switch (event.type) {
      case "ready": {
        // Re-sync after a reconnect so nothing is missed while we were away.
        this.#flushQueued();
        this.#setConnectionHint();
        this.#refreshActiveThread().catch(() => undefined);
        return;
      }
      case "message.new": {
        const state = this.state.get();
        const thread = state.messages[conversationId];
        if (thread) {
          const pendingIndex = event.clientMessageId
            ? thread.messages.findIndex((message) => message.clientMessageId === event.clientMessageId)
            : -1;
          const reconciled = {
            ...event.message,
            status: "sent",
            clientMessageId: event.clientMessageId ?? (event.message.senderId === state.me.id ? "local" : undefined),
          };

          const messages = [...thread.messages];
          if (pendingIndex >= 0) messages[pendingIndex] = { ...messages[pendingIndex], ...reconciled };
          else messages.push(reconciled);

          this.state.set({
            messages: { ...state.messages, [conversationId]: { ...thread, messages: upsertMessage(messages, reconciled) } },
            conversations: upsertConversation(state, {
              id: conversationId,
              lastMessage: event.message,
              lastMessageAt: event.message.createdAt,
              unread: state.activeConversationId === conversationId ? 0 : (findConversation(state, conversationId)?.unread ?? 0) + 1,
            }),
          });
        }
        this.chat?.render(this.state.get());
        this.chat?.scrollToBottom(true);
        this.sidebar.invalidate();
        this.sidebar.render();
        return;
      }
      case "message.updated":
      case "message.deleted": {
        this.#onHubEvent(event);
        return;
      }
      case "typing.update": {
        if (event.userId === this.state.get().me.id) return;
        this.chat?.noteTyping(event.userId, event.typing);
        return;
      }
      case "message.read": {
        this.#onHubEvent(event);
        return;
      }
      case "call.signal": {
        this.#onCallSignal(event.from, event.payload);
        return;
      }
      case "call.participants": {
        const participants = event.participants ?? [];
        this.state.set({ callParticipants: participants });
        qs("#leave-call")?.toggleAttribute("hidden", !participants.includes(this.state.get().me.id));
        this.media.syncRoster(participants);
        return;
      }
      case "error": {
        if (event.code === "RATE_LIMITED") toast(event.message, { kind: "warn" });
        else if (event.code === "UNAUTHORIZED" || event.code === "FORBIDDEN") {
          toast(`${event.message} Reloading…`, { kind: "error" });
          setTimeout(() => location.reload(), 1500);
        }
        return;
      }
      default:
        return;
    }
  }

  #onCallSignal(fromUserId, payload) {
    const state = this.state.get();
    const conversation = state.conversations.find((entry) => entry.id === state.activeConversationId);
    const isMesh = conversation?.type !== "dm";
    const inCall = this.media.isBusy();

    // Everyone is told when somebody joins a call.
    if (payload?.kind === "state" && payload.media) {
      const participants = [...new Set([...state.callParticipants, fromUserId])];
      this.state.set({ callParticipants: participants });
      qs("#leave-call")?.toggleAttribute("hidden", !participants.includes(state.me.id));
    }

    if (payload?.kind === "bye") {
      this.media.handleSignal(fromUserId, payload);
      return;
    }

    if (payload?.kind === "state") {
      // Relay-based calls (groups, and one-to-one when PeerJS is unreachable)
      // negotiate as soon as both sides are in the room. A live PeerJS call
      // carries its own signalling, so nothing to do there.
      if (inCall && (isMesh || this.media.usesRelay)) this.media.handleSignal(fromUserId, payload);
      else if (!inCall) {
        this.media.invitedBy = fromUserId; // connect straight away when they join
        toast(`${this.userName(fromUserId)} started a ${payload.media} call.`, {
          kind: "info",
          timeout: 15_000,
          action: { label: "Join", onClick: () => this.startCall(payload.media) },
        });
      }
      return;
    }

    // offer / answer / ice only matter while we are already in the call.
    if (!inCall) return;
    this.media.handleSignal(fromUserId, payload);
  }

  /* -------------------------------------------------------- conversation */

  async refreshConversations() {
    const { conversations, users } = await api.conversations();
    this.state.set({
      conversations: sortConversations(conversations ?? []),
      users: mergeUsers(this.state.get(), users),
    });
    this.sidebar.invalidate();
    this.sidebar.render();

    const active = this.state.get().activeConversationId;
    if (active) this.chat?.render(this.state.get());
    return conversations;
  }

  async selectConversation(conversationId) {
    if (conversationId === this.state.get().activeConversationId) return;

    this.chat?.setConversation(null);
    this.state.set({ activeConversationId: conversationId, messages: {}, callParticipants: [] });
    this.#openRoom(conversationId);
    this.sidebar.invalidate();
    this.sidebar.render();
    document.body.classList.toggle("chat-open", Boolean(conversationId));

    if (!conversationId) return;

    const conversation = findConversation(this.state.get(), conversationId);
    this.chat?.setConversation(conversation);
    await this.#loadThread(conversationId, { reset: true });
  }

  async selectConversationByUser(userId) {
    try {
      const { conversation } = await api.createDm(userId);
      const state = this.state.get();
      this.state.set({ conversations: upsertConversation(state, conversation) });
      this.sidebar.invalidate();
      this.sidebar.render();
      await this.selectConversation(conversation.id);
    } catch (error) {
      toast(error.message, { kind: "error" });
    }
  }

  async #loadThread(conversationId, { reset = false, before } = {}) {
    const state = this.state.get();
    const existing = state.messages[conversationId];
    if (existing?.loading && !reset) return;

    const query = { before, limit: 50 };
    const pending = { messages: [], hasMore: false, cursor: null, loading: true };
    if (!reset && existing) {
      this.state.set({ messages: { ...state.messages, [conversationId]: { ...existing, loading: true } } });
    } else {
      this.state.set({ messages: { ...state.messages, [conversationId]: { ...pending, messages: existing?.messages ?? [] } } });
    }

    try {
      const data = await api.messages(conversationId, query);
      const current = this.state.get().messages[conversationId] ?? pending;

      // Dedupe by id: a reconnect may refetch messages we already hold.
      const byId = new Map();
      for (const message of current.messages) byId.set(message.id, message);
      for (const message of data.messages) byId.set(message.id, { ...byId.get(message.id), ...message });
      const merged = [...byId.values()].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

      this.state.set({
        messages: {
          ...this.state.get().messages,
          [conversationId]: { messages: merged, hasMore: data.hasMore, cursor: data.cursor, loading: false },
        },
        users: mergeUsers(this.state.get(), data.users),
      });
      this.chat?.render(this.state.get());
      this.markRead(merged.filter((message) => message.senderId !== this.state.get().me.id).map((message) => message.id));
    } catch (error) {
      this.state.set({
        messages: { ...this.state.get().messages, [conversationId]: { ...pending, messages: existing?.messages ?? [], loading: false } },
      });
      if (error.code !== "NETWORK_ERROR") toast(error.message, { kind: "error" });
    }
  }

  async #refreshActiveThread() {
    const conversationId = this.state.get().activeConversationId;
    if (!conversationId) return;
    const thread = this.state.get().messages[conversationId];
    await this.#loadThread(conversationId, { reset: true });
    // Keep the scroll position stable across a reconnect.
    if (thread) qs("#message-list")?.scrollIntoView?.();
  }

  async loadOlderMessages() {
    const conversationId = this.state.get().activeConversationId;
    const thread = this.state.get().messages[conversationId];
    if (!conversationId || !thread?.cursor || thread.loading) return;

    const container = qs("#messages");
    const previousHeight = container.scrollHeight;

    await this.#loadThread(conversationId, { before: thread.cursor });
    const next = this.state.get().messages[conversationId];
    if (next) {
      const container2 = qs("#messages");
      const added = next.messages.length - thread.messages.length;
      if (added > 0) container2.scrollTop = container2.scrollHeight - previousHeight;
    }
  }

  /* ------------------------------------------------------------ sending */

  sendMessage(content) {
    const conversationId = this.state.get().activeConversationId;
    if (!conversationId) return false;

    const clientMessageId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const optimistic = {
      id: clientMessageId,
      conversationId,
      senderId: this.state.get().me.id,
      content,
      createdAt: new Date().toISOString(),
      status: this.roomSocket?.isConnected ? "pending" : "queued",
      clientMessageId,
    };

    const state = this.state.get();
    const thread = state.messages[conversationId] ?? { messages: [], hasMore: false, cursor: null };
    this.state.set({
      messages: { ...state.messages, [conversationId]: { ...thread, messages: [...thread.messages, optimistic] } },
    });
    this.chat?.render(this.state.get());
    this.chat?.scrollToBottom(true);

    if (!this.roomSocket?.isConnected) {
      // Not connected (or half-open): keep the message, start reconnecting and
      // flush it as soon as the socket is back.
      this.roomSocket?.forceReconnect("sending while offline");
      this.#setConnectionHint();
      return true;
    }

    this.#sendOptimistic(optimistic);
    return true;
  }

  /** Put a queued/pending message on the wire. */
  #sendOptimistic(message) {
    const sent = this.roomSocket?.send({
      type: "message.send",
      conversationId: message.conversationId,
      content: message.content,
      clientMessageId: message.clientMessageId,
    });
    if (!sent) {
      this.#patchMessage(message.conversationId, message.id, { status: "queued" });
      this.chat?.render(this.state.get());
    }
  }

  /** Re-send everything that was queued while the socket was down. */
  #flushQueued() {
    const state = this.state.get();
    for (const [conversationId, thread] of Object.entries(state.messages)) {
      for (const message of thread.messages) {
        if (message.status === "queued" && message.senderId === state.me.id) {
          this.#sendOptimistic({ ...message, conversationId });
        }
      }
    }
  }

  /** Show one banner instead of a toast per attempt. */
  #setConnectionHint() {
    const banner = qs("#chat-banner");
    if (!banner) return;
    const connected = this.roomSocket?.isConnected === true;
    const pending = Object.values(this.state.get().messages).flatMap((thread) => thread.messages).filter(
      (message) => message.status === "queued" || message.status === "pending",
    ).length;

    if (connected && pending === 0) {
      banner.hidden = true;
      banner.textContent = "";
      return;
    }

    banner.hidden = false;
    banner.classList.toggle("chat__banner--error", this.roomSocket?.state === ConnectionState.FAILED);
    banner.textContent = connected
      ? "Connected — sending…"
      : `Reconnecting… ${pending > 0 ? `${pending} message${pending > 1 ? "s" : ""} waiting to send.` : "your messages will send automatically."}`;
  }

  /** Exposed so the chat view can render the same banner. */
  connectionHint() {
    this.#setConnectionHint();
  }

  /** Edit is optimistic: the bubble updates immediately, then reconciles. */
  editMessage(messageId, content) {
    const conversationId = this.state.get().activeConversationId;
    if (!conversationId) return;
    if (!this.roomSocket?.send({ type: "message.edit", conversationId, messageId, content })) {
      toast("Not connected — your edit was not sent.", { kind: "error" });
      this.#refreshActiveThread().catch(() => undefined);
      return;
    }
    this.#patchMessage(conversationId, messageId, {
      content,
      editedAt: new Date().toISOString(),
      status: "sent",
    });
    this.chat?.render(this.state.get());
  }

  deleteMessage(messageId) {
    const conversationId = this.state.get().activeConversationId;
    if (!conversationId) return;
    if (!this.roomSocket?.send({ type: "message.delete", conversationId, messageId })) {
      toast("Not connected — try again in a moment.", { kind: "error" });
    }
  }

  markRead(messageIds) {
    const conversationId = this.state.get().activeConversationId;
    if (!conversationId || messageIds.length === 0) return;

    const state = this.state.get();
    const conversation = findConversation(state, conversationId);
    if (conversation) {
      this.state.set({ conversations: upsertConversation(state, { ...conversation, unread: 0 }) });
      this.sidebar.invalidate();
      this.sidebar.render();
    }
    this.roomSocket?.send({ type: "message.read", conversationId, messageIds: messageIds.slice(-200) });
  }

  notifyTyping() {
    const now = Date.now();
    if (now - this.lastTypingSentAt < 1800) return;
    this.lastTypingSentAt = now;
    this.roomSocket?.send({ type: "typing.start", conversationId: this.state.get().activeConversationId });
    clearTimeout(this.pendingTypingStop);
    this.pendingTypingStop = setTimeout(() => this.notifyTypingStopped(), 4000);
  }

  notifyTypingStopped() {
    clearTimeout(this.pendingTypingStop);
    this.lastTypingSentAt = 0;
    this.roomSocket?.send({ type: "typing.stop", conversationId: this.state.get().activeConversationId });
  }

  #patchMessage(conversationId, messageId, patch) {
    const state = this.state.get();
    const thread = state.messages[conversationId];
    if (!thread) return;
    this.state.set({
      messages: {
        ...state.messages,
        [conversationId]: {
          ...thread,
          messages: thread.messages.map((message) => (message.id === messageId ? { ...message, ...patch } : message)),
        },
      },
    });
  }

  /* -------------------------------------------------------------- calls */

  callParticipants() {
    const state = this.state.get();
    const conversation = state.conversations.find((entry) => entry.id === state.activeConversationId);
    if (!conversation) return state.callParticipants;
    return conversation.participantIds.filter((id) => id !== state.me.id);
  }

  startCall(kind) {
    return this.media.start(kind === "screen" ? "video" : kind);
  }

  endCall(reason) {
    this.media.end(reason);
  }

  onCallState(state) {
    const inCall = state !== "idle" && state !== "closed";
    qs("#leave-call")?.toggleAttribute("hidden", !inCall);
    document.body.classList.toggle("in-call", inCall);
    if (state === "connected") this.notifyCallParticipants("state");
  }

  /** An incoming PeerJS call is ringing: offer Answer / ignore. */
  onIncomingCall(peerId, media) {
    const name = this.userName(String(peerId ?? "").replace("lcc-chat-", ""));
    toast(`${name} is calling you (${media}).`, {
      kind: "info",
      timeout: 40_000,
      action: { label: "Answer", onClick: () => this.media.answerIncoming() },
    });
  }

  onMissedCall(peerId) {
    const name = this.userName(String(peerId ?? "").replace("lcc-chat-", ""));
    toast(`Missed call from ${name}.`, { kind: "warn", timeout: 5000 });
  }

  onCallEnded(reason) {
    const inCall = false;
    qs("#leave-call")?.toggleAttribute("hidden", inCall);
    document.body.classList.toggle("in-call", inCall);
    if (reason === "remote") toast("Call ended.", { kind: "info", timeout: 2500 });
  }

  sendCallSignal(to, payload) {
    if (!to) return;
    this.roomSocket?.send({ type: "call.signal", conversationId: this.state.get().activeConversationId, to, payload });
  }

  notifyCallParticipants(kind) {
    for (const userId of this.callParticipants()) {
      this.sendCallSignal(userId, { kind: "state", media: this.media.media, state: "connected" });
    }
  }

  userName(userId) {
    const state = this.state.get();
    return state.users.get(userId)?.displayName ?? state.me?.displayName ?? "Someone";
  }

  /* ---------------------------------------------------------- utilities */

  #notify(message, title) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return;
    try {
      const notification = new Notification(`${title} · ${APP_NAME}`, { body: message.content.slice(0, 180), tag: message.id });
      notification.addEventListener("click", () => {
        window.focus();
        this.selectConversation(message.conversationId);
        notification.close();
      });
    } catch {
      /* notifications are best-effort */
    }
  }

  /**
   * A dead socket often means the session itself is gone (restarted Worker with
   * a new secret, cleared storage). Check once and restart cleanly instead of
   * retrying forever.
   */
  #revalidateSession() {
    if (this.revalidating) return;
    this.revalidating = true;
    api
      .me()
      .then(() => {
        this.revalidating = false;
      })
      .catch((error) => {
        this.revalidating = false;
        if (error?.status === 401) {
          toast("Your session expired — pick a name to start a new one.", { kind: "warn", timeout: 6000 });
          setToken(null);
          setTimeout(() => location.reload(), 1200);
        }
      });
  }

  updateMe(user) {
    const state = this.state.get();
    this.state.set({ me: user, users: new Map(state.users).set(user.id, user) });
    this.sidebar.invalidate();
    this.sidebar.render();
    this.chat?.render(this.state.get());
  }

  openNewChat() {
    openNewChat(this);
  }

  openPeople() {
    openPeople(this);
  }

  openSettings() {
    openSettings(this);
  }
}

/* ------------------------------------------------------------- start-up */

const app = new App();
window.lccChat = app; // handy for debugging from the console
clear(qs("#boot"));
app.boot().catch((error) => {
  console.error("[lcc-chat] boot failed", error);
  toast(`Could not reach the ${APP_NAME} Worker at ${WORKER_URL}.`, { kind: "error", timeout: 8000 });
});

export { App };