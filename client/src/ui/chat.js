import { el, qs, clear, avatarNode, clockTime, dayLabel, debounce } from "./dom.js";
import { confirmDialog } from "./overlays.js";
import { otherMemberId } from "./sidebar.js";

const TYPING_IDLE_MS = 4000;
const EMOJI = ["👍", "🎉", "😂", "❤️", "🔥", "👀", "🙏", "✅", "🚀", "💡", "😎", "🥳"];

/** The conversation pane: history, composer, typing indicator and read state. */
export function createChatView(app) {
  const panel = qs("#chat-panel");
  const empty = qs("#chat-empty");
  const messages = qs("#messages");
  const list = qs("#message-list");
  const loadOlder = qs("#load-older");
  const typingBar = qs("#typing");
  const input = qs("#composer-input");
  const sendButton = qs("#composer-send");
  const emojiToggle = qs("#emoji-toggle");
  const avatarSlot = qs("#chat-avatar");
  const nameSlot = qs("#chat-name");
  const presenceSlot = qs("#chat-presence");

  qs("#chat-back").addEventListener("click", () => app.selectConversation(null));
  qs("#load-older").addEventListener("click", () => app.loadOlderMessages());
  qs("#open-people").addEventListener("click", () => app.openPeople());
  qs("#start-audio").addEventListener("click", () => app.startCall("audio"));
  qs("#start-video").addEventListener("click", () => app.startCall("video"));
  qs("#leave-call").addEventListener("click", () => app.endCall("local"));

  sendButton.addEventListener("click", () => submit());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
  input.addEventListener("input", () => {
    autosize();
    app.notifyTyping();
  });

  let emojiBar = null;
  emojiToggle.addEventListener("click", () => {
    if (emojiBar) {
      emojiBar.remove();
      emojiBar = null;
      return;
    }
    emojiBar = el(
      "div",
      { class: "emoji-bar" },
      EMOJI.map((emoji) =>
        el("button", {
          class: "emoji-bar__item",
          type: "button",
          text: emoji,
          onclick: () => {
            insertAtCursor(emoji);
            emojiBar?.remove();
            emojiBar = null;
            input.focus();
          },
        }),
      ),
    );
    qs(".composer").append(emojiBar);
  });

  messages.addEventListener("scroll", () => {
    if (messages.scrollTop < 120) app.loadOlderMessages();
  });

  let renderedKey = "";
  let typingUsers = new Map();
  let lastReadSentAt = 0;
  /** Message currently open in an inline editor; renders pause until it closes. */
  let editingMessageId = null;

  function submit() {
    const content = input.value.trim();
    if (content.length === 0) return;
    app.sendMessage(content);
    input.value = "";
    autosize();
    app.notifyTypingStopped();
  }

  function insertAtCursor(text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    input.focus();
    input.selectionStart = input.selectionEnd = start + text.length;
    autosize();
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
  }

  function renderHeader(state) {
    const conversation = state.conversations.find((entry) => entry.id === state.activeConversationId);
    if (!conversation) return;
    const me = state.me;
    const memberId = otherMemberId(conversation, me.id);
    const member = memberId ? state.users.get(memberId) : null;

    clear(avatarSlot);
    if (conversation.type === "dm") {
      avatarSlot.append(
        avatarNode({
          name: conversation.title,
          color: member?.color ?? "#475569",
          avatarUrl: member?.avatarUrl,
          size: "md",
          presence: memberId ? state.presence.has(memberId) : undefined,
        }),
      );
    } else {
      avatarSlot.append(
        el("div", { class: "avatar avatar--md avatar--group", text: conversation.title.slice(0, 2).toUpperCase() }),
      );
    }

    nameSlot.textContent = conversation.title;

    if (conversation.type === "dm") {
      presenceSlot.textContent = memberId
        ? state.presence.has(memberId)
          ? "online"
          : "offline"
        : "";
      presenceSlot.classList.toggle("chat__presence--online", memberId ? state.presence.has(memberId) : false);
    } else {
      const online = conversation.participantIds.filter((id) => id !== me.id && state.presence.has(id)).length;
      presenceSlot.textContent = `${conversation.participantIds.length} members · ${online} online`;
      presenceSlot.classList.remove("chat__presence--online");
    }
  }

  function renderMessages(state) {
    // Never yank an open editor away because a read receipt arrived.
    if (editingMessageId) return;
    const conversationId = state.activeConversationId;
    const thread = state.messages[conversationId];
    if (!thread) return;

    const conversation = state.conversations.find((entry) => entry.id === conversationId);
    const participants = conversation?.participantIds ?? [];
    const isGroup = conversation?.type === "group";

    const key = JSON.stringify([
      thread.messages.map((message) => [message.id, message.status, message.content, message.editedAt, Boolean(message.deletedAt)]),
      thread.hasMore,
      state.readReceipts[conversationId] ?? null,
    ]);
    const atBottom = isNearBottom();
    if (key === renderedKey) return;
    renderedKey = key;

    const wasEmpty = list.childElementCount === 0;
    clear(list);

    let lastDay = null;
    let lastSender = null;

    for (const message of thread.messages) {
      const day = new Date(message.createdAt).toDateString();
      if (day !== lastDay) {
        list.append(el("div", { class: "day-separator" }, [el("span", { text: dayLabel(message.createdAt) })]));
        lastDay = day;
        lastSender = null;
      }

      const mine = message.senderId === state.me.id;
      const readByOthers = (state.readReceipts[conversationId]?.messageIds ?? []).includes(message.id);
      const showAuthor = isGroup && !mine && message.senderId !== lastSender;
      if (message.senderId !== lastSender) lastSender = message.senderId;

      const bubble = el(
        "div",
        {
          class: `message${mine ? " message--mine" : ""}${
            message.status === "pending" ? " message--pending" : message.status === "failed" ? " message--failed" : ""
          }`,
          dataset: { messageId: message.id, conversationId },
        },
        [
          showAuthor
            ? el("span", {
                class: "message__author",
                text: state.users.get(message.senderId)?.displayName ?? "Unknown",
                style: `color:${state.users.get(message.senderId)?.color ?? "#94a3b8"}`,
              })
            : null,
          el("div", { class: "message__bubble" }, [
            el("p", { class: "message__text", text: message.deletedAt ? "This message was deleted." : message.content }),
            el("span", { class: "message__meta" }, [
              message.editedAt && !message.deletedAt ? el("span", { class: "message__edited", text: "edited" }) : null,
              message.status === "queued" ? el("span", { class: "message__edited", text: "queued" }) : null,
              el("time", { text: clockTime(message.createdAt) }),
              mine && !message.deletedAt ? receiptGlyph(message, readByOthers) : null,
            ]),
          ]),
          mine && !message.deletedAt ? messageActions(app, message) : null,
        ],
      );
      list.append(bubble);
    }

    loadOlder.hidden = !thread.hasMore;
    if (wasEmpty || atBottom) scrollToBottom();
    renderTyping(state);
    scheduleReadReceipt(state);
    app.connectionHint();
  }

  function receiptGlyph(message, readByOthers) {
    if (message.status === "queued") return el("span", { class: "message__receipt", text: "🕓" });
    if (message.status === "pending") return el("span", { class: "message__receipt", text: "🕓" });
    if (message.status === "failed") return el("span", { class: "message__receipt", text: "⚠" });
    return el("span", {
      class: `message__receipt${readByOthers ? " message__receipt--read" : ""}`,
      text: readByOthers ? "✓✓" : "✓",
      title: readByOthers ? "Read" : "Sent",
    });
  }

  function messageActions(appRef, message) {
    return el("div", { class: "message__actions" }, [
      el("button", {
        class: "icon-button icon-button--sm",
        type: "button",
        title: "Edit",
        "aria-label": "Edit message",
        text: "✎",
        onclick: () => startEditing(appRef, message),
      }),
      el("button", {
        class: "icon-button icon-button--sm",
        type: "button",
        title: "Delete",
        "aria-label": "Delete message",
        text: "🗑",
        onclick: async () => {
          const confirmed = await confirmDialog({
            title: "Delete message?",
            message: "This removes the message for everyone in the conversation.",
            confirmLabel: "Delete",
          });
          if (confirmed) appRef.deleteMessage(message.id);
        },
      }),
    ]);
  }

  function startEditing(appRef, message) {
    const node = qs(`.message[data-message-id="${message.id}"] .message__bubble`, list);
    if (!node || qs("textarea", node)) return;
    editingMessageId = message.id;

    const editor = el("textarea", { class: "message__editor", rows: "2" });
    editor.value = message.content;

    const finish = (save) => {
      const value = editor.value.trim();
      editingMessageId = null;
      // `editMessage` re-renders optimistically; cancelling just re-renders.
      if (save && value && value !== message.content) appRef.editMessage(message.id, value);
      else render(appRef.state.get());
    };

    editor.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        finish(true);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    editor.addEventListener("blur", () => finish(false));

    const original = node.querySelector(".message__text");
    original.replaceWith(editor);
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  function renderTyping(state) {
    const conversationId = state.activeConversationId;
    const names = [...typingUsers.entries()]
      .filter(([userId, at]) => Date.now() - at < TYPING_IDLE_MS)
      .map(([userId]) => state.users.get(userId)?.displayName?.split(/\s+/)[0] ?? "Someone");

    typingBar.hidden = names.length === 0;
    typingBar.textContent =
      names.length === 0 ? "" : names.length === 1 ? `${names[0]} is typing…` : `${names.length} people are typing…`;
    void conversationId;
  }

  /** Tell the server which messages are on screen. */
  function scheduleReadReceipt(state) {
    const conversationId = state.activeConversationId;
    const thread = state.messages[conversationId];
    if (!thread || document.visibilityState !== "visible") return;
    if (Date.now() - lastReadSentAt < 800) return;

    const unread = thread.messages.filter(
      (message) => message.senderId !== state.me.id && !message.deletedAt && message.status !== "pending",
    );
    if (unread.length === 0) return;

    lastReadSentAt = Date.now();
    app.markRead(unread.map((message) => message.id));
  }

  const typingTick = setInterval(() => {
    if (typingUsers.size > 0) renderTyping(app.state.get());
  }, 1000);

  function noteTyping(userId, typing) {
    if (typing) typingUsers.set(userId, Date.now());
    else typingUsers.delete(userId);
    renderTyping(app.state.get());
  }

  function isNearBottom() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 140;
  }

  function scrollToBottom(smooth = false) {
    messages.scrollTo({ top: messages.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }

  function setConversation(conversation) {
    renderedKey = "";
    typingUsers = new Map();
    editingMessageId = null;
    const visible = Boolean(conversation);
    panel.hidden = !visible;
    empty.hidden = visible;
    if (!visible) return;
    renderHeader(app.state.get());
    clear(list);
    messages.scrollTop = messages.scrollHeight;
    input.focus({ preventScroll: true });
  }

  function render(state) {
    if (!state.activeConversationId) return;
    renderHeader(state);
    renderMessages(state);
  }

  const focusComposer = debounce(() => input.focus(), 50);

  return {
    render,
    setConversation,
    noteTyping,
    focusComposer,
    scrollToBottom,
    isNearBottom,
    hasActiveConversation: () => Boolean(app.state.get().activeConversationId),
    get participants() {
      const state = app.state.get();
      const conversation = state.conversations.find((entry) => entry.id === state.activeConversationId);
      return conversation ? conversation.participantIds.filter((id) => id !== state.me.id) : [];
    },
  };
}