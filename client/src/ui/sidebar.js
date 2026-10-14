import { el, qs, clear, avatarNode, shortTime, previewOf } from "./dom.js";
import { toast } from "./overlays.js";
import { unreadTotal } from "../store.js";
import { activeWorkerUrl } from "../../config.js";

/** Left rail: identity, filter and the conversation list. */
export function createSidebar(app) {
  const list = qs("#conversation-list");
  const filterInput = qs("#filter-conversations");
  const meButton = qs("#me-avatar");
  const meName = qs("#me-name");
  const status = qs("#connection-status");
  const workerPill = qs("#worker-pill");

  filterInput.addEventListener("input", () => render());
  qs("#new-chat").addEventListener("click", () => app.openNewChat());
  qs("#open-settings").addEventListener("click", () => app.openSettings());
  meButton.addEventListener("click", () => app.openSettings());

  let lastRenderedKey = "";

  function render() {
    const state = app.state.get();
    const { me, conversations, users, presence, activeConversationId } = state;
    if (!me) return;

    const onlineCount = presence.size;

    // Only rebuild the list when something visible actually changed.
    const key = JSON.stringify({
      c: conversations.map((conversation) => [
        conversation.id,
        conversation.title,
        conversation.unread ?? 0,
        conversation.lastMessageAt ?? "",
        conversation.lastMessage?.content ?? "",
        presence.has(otherMemberId(conversation, me.id)),
      ]),
      f: filterInput.value.toLowerCase(),
      a: activeConversationId,
      n: onlineCount,
    });
    if (key === lastRenderedKey) return;
    lastRenderedKey = key;

    meName.textContent = me.displayName;
    clear(meButton);
    meButton.append(avatarNode({ name: me.displayName, color: me.color, avatarUrl: me.avatarUrl, size: "lg" }));
    meButton.title = `${me.displayName} — click for settings`;

    const total = unreadTotal(conversations);
    status.textContent = total > 0 ? `${total} unread · ${onlineCount} online` : `${onlineCount} online`;
    status.classList.toggle("status--attention", total > 0);

    workerPill.textContent = `${workerLabel()} · ${state.connection}`;
    workerPill.classList.toggle("pill--online", state.connection === "connected");

    const needle = filterInput.value.trim().toLowerCase();
    const visible = conversations.filter(
      (conversation) =>
        needle.length === 0 ||
        conversation.title.toLowerCase().includes(needle) ||
        previewOf(conversation, users, me.id).toLowerCase().includes(needle),
    );

    clear(list);

    if (visible.length === 0) {
      list.append(
        el("div", { class: "conversation-list__empty" }, [
          el("p", { text: conversations.length === 0 ? "No conversations yet." : "Nothing matches that filter." }),
          el("button", {
            class: "button button--ghost",
            type: "button",
            text: "Start a new chat",
            onclick: () => app.openNewChat(),
          }),
        ]),
      );
      return;
    }

    for (const conversation of visible) {
      list.append(conversationRow(app, conversation, me, users, presence, conversation.id === activeConversationId));
    }
  }

  function conversationRow(app, conversation, me, users, presence, active) {
    const memberId = otherMemberId(conversation, me.id);
    const member = memberId ? users.get(memberId) : null;
    const online = memberId ? presence.has(memberId) : false;

    const unread = conversation.unread ?? 0;
    const row = el(
      "button",
      {
        class: `conversation${active ? " conversation--active" : ""}${unread > 0 ? " conversation--unread" : ""}`,
        type: "button",
        onclick: () => app.selectConversation(conversation.id),
      },
      [
        avatarNode({
          name: conversation.title,
          color: member?.color ?? "#475569",
          avatarUrl: conversation.type === "dm" ? member?.avatarUrl : undefined,
          size: "md",
          presence: conversation.type === "dm" ? online : undefined,
        }),
        el("span", { class: "conversation__body" }, [
          el("span", { class: "conversation__top" }, [
            el("span", { class: "conversation__title", text: conversation.title }),
            el("time", { class: "conversation__time", text: shortTime(conversation.lastMessageAt ?? conversation.createdAt) }),
          ]),
          el("span", { class: "conversation__preview", text: previewOf(conversation, users, me.id) }),
        ]),
        unread > 0 ? el("span", { class: "conversation__badge", text: unread > 99 ? "99+" : String(unread) }) : null,
        conversation.type === "group" ? el("span", { class: "conversation__tag", text: `${conversation.participantIds.length}` }) : null,
      ],
    );
    return row;
  }

  function invalidate() {
    lastRenderedKey = "";
  }

  return { render, invalidate };
}

/** Human label for the Worker host, shown in the sidebar footer. */
function workerLabel() {
  try {
    return new URL(activeWorkerUrl()).host;
  } catch {
    return "worker";
  }
}

export function otherMemberId(conversation, myId) {
  if (conversation.type !== "dm") return null;
  return conversation.participantIds.find((id) => id !== myId) ?? null;
}

export function notifyConnection(state) {
  const label = {
    connecting: "connecting…",
    connected: "connected",
    reconnecting: "reconnecting…",
    closed: "disconnected",
    failed: "connection lost",
  }[state] ?? state;

  const element = qs("#connection-status");
  if (element) {
    element.textContent = label;
    element.classList.toggle("status--warn", state !== "connected");
  }
  if (state === "failed") toast("Lost the connection to lcc-chat. Retrying…", { kind: "error", timeout: 6000 });
}