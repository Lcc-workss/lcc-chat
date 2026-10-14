import { el, qs, clear, avatarNode, debounce } from "./dom.js";
import { openModal, toast } from "./overlays.js";
import { api } from "../api.js";

/**
 * Start a new conversation: search people, open a DM, or spin up a group.
 * People come from the Worker's KV-backed directory.
 */
export function openNewChat(app) {
  openModal({
    title: "New chat",
    subtitle: "Search for someone by name. No sign-up needed for them either.",
    size: "md",
    render(body, { close }) {
      const results = el("div", { class: "people-list" });
      const selected = new Map();

      const search = el("input", {
        class: "input",
        type: "search",
        placeholder: "Search by name or handle…",
        autocomplete: "off",
        "aria-label": "Search people",
      });

      const groupTitle = el("input", {
        class: "input input--ghost",
        type: "text",
        maxlength: "48",
        placeholder: "Group name (optional)",
        hidden: true,
      });

      const selectedRow = el("div", { class: "people-selected" });
      const startButton = el("button", {
        class: "button button--primary",
        type: "button",
        text: "Start chat",
        disabled: true,
        onclick: async () => {
          const ids = [...selected.keys()];
          startButton.disabled = true;
          try {
            const conversation =
              ids.length === 1 ? await startDm(app, ids[0]) : await startGroup(app, ids, groupTitle.value.trim());
            if (conversation) {
              close();
              app.selectConversation(conversation.id);
            }
          } catch (error) {
            toast(error.message ?? "Could not create the conversation.", { kind: "error" });
          } finally {
            startButton.disabled = false;
          }
        },
      });

      const renderSelected = () => {
        clear(selectedRow);
        for (const user of selected.values()) {
          selectedRow.append(
            el("button", {
              class: "chip",
              type: "button",
              title: `Remove ${user.displayName}`,
              onclick: () => {
                selected.delete(user.id);
                search.value = "";
                renderSelected();
                runSearch(search.value);
              },
            }, [
              avatarNode({ name: user.displayName, color: user.color, avatarUrl: user.avatarUrl, size: "xs" }),
              el("span", { text: user.displayName }),
              el("span", { class: "chip__x", text: "×" }),
            ]),
          );
        }
        groupTitle.hidden = selected.size < 2;
        startButton.textContent = selected.size === 0 ? "Pick someone" : selected.size === 1 ? "Start chat" : `Start group (${selected.size})`;
        startButton.disabled = selected.size === 0;
      };

      const runSearch = debounce(async (query) => {
        clear(results);
        try {
          const { users } = await api.searchUsers(query ?? "");
          app.state.set({ users: mergeInto(app.state.get().users, users) });

          if (users.length === 0) {
            results.append(el("p", { class: "muted", text: "Nobody found. Share the link so they can join lcc-chat." }));
            return;
          }
          for (const user of users) {
            const picked = selected.has(user.id);
            results.append(
              el(
                "button",
                {
                  class: `person${picked ? " person--selected" : ""}`,
                  type: "button",
                  onclick: () => {
                    if (selected.has(user.id)) selected.delete(user.id);
                    else selected.set(user.id, user);
                    renderSelected();
                    runSearch(search.value);
                  },
                },
                [
                  avatarNode({ name: user.displayName, color: user.color, avatarUrl: user.avatarUrl, size: "md" }),
                  el("span", { class: "person__body" }, [
                    el("strong", { text: user.displayName }),
                    el("span", { class: "person__handle", text: `@${user.username}` }),
                  ]),
                  app.state.get().presence.has(user.id) ? el("span", { class: "pill pill--online", text: "online" }) : null,
                ],
              ),
            );
          }
        } catch (error) {
          results.append(el("p", { class: "muted", text: error.message ?? "Search failed." }));
        }
      }, 220);

      search.addEventListener("input", () => runSearch(search.value));
      groupTitle.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          startButton.click();
        }
      });

      body.append(
        search,
        selectedRow,
        groupTitle,
        results,
        el("div", { class: "modal__actions" }, [
          el("button", { class: "button", type: "button", text: "Cancel", onclick: () => close() }),
          startButton,
        ]),
      );

      renderSelected();
      runSearch("");
    },
  });
}

function mergeInto(current, users) {
  const next = new Map(current);
  for (const user of users ?? []) if (user?.id) next.set(user.id, { ...next.get(user.id), ...user });
  return next;
}

async function startDm(app, userId) {
  const { conversation } = await api.createDm(userId);
  const state = app.state.get();
  app.state.set({ conversations: upsert([...state.conversations], conversation) });
  toast("Conversation ready.", { kind: "success", timeout: 2000 });
  return conversation;
}

async function startGroup(app, participantIds, title) {
  const { conversation } = await api.createGroup(participantIds, title || undefined);
  const state = app.state.get();
  app.state.set({ conversations: upsert([...state.conversations], conversation) });
  return conversation;
}

function upsert(conversations, conversation) {
  const rest = conversations.filter((entry) => entry.id !== conversation.id);
  return [conversation, ...rest].sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
}

/** People sheet for the open conversation. */
export function openPeople(app) {
  const state = app.state.get();
  const conversation = state.conversations.find((entry) => entry.id === state.activeConversationId);
  if (!conversation) return;

  openModal({
    title: conversation.type === "group" ? conversation.title : "Chat details",
    subtitle:
      conversation.type === "group"
        ? `${conversation.participantIds.length} members`
        : "You are on a no-sign-up session — no personal data beyond what you typed here.",
    render(body) {
      for (const userId of conversation.participantIds) {
        const user = userId === state.me.id ? state.me : state.users.get(userId);
        if (!user) continue;
        body.append(
          el("div", { class: "person person--static" }, [
            avatarNode({
              name: user.displayName,
              color: user.color,
              avatarUrl: user.avatarUrl,
              size: "md",
              presence: state.presence.has(user.id),
            }),
            el("span", { class: "person__body" }, [
              el("strong", { text: userId === state.me.id ? `${user.displayName} (you)` : user.displayName }),
              el("span", { class: "person__handle", text: `@${user.username}` }),
            ]),
            el("button", {
              class: "button button--ghost button--sm",
              type: "button",
              text: "Message",
              disabled: userId === state.me.id,
              onclick: () => {
                qs(".modal-backdrop")?.remove();
                app.selectConversationByUser(user.id);
              },
            }),
          ]),
        );
      }
      body.append(el("p", { class: "muted", text: `Conversation id: ${conversation.id}` }));
    },
  });
}