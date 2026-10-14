/** Tiny observable state container — no framework, no dependencies. */

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();

  return {
    get() {
      return state;
    },
    set(patch) {
      const next = typeof patch === "function" ? patch(state) : { ...state, ...patch };
      if (next === state) return state;
      state = next;
      for (const listener of listeners) listener(state);
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
  };
}

/* --------------------------------------------------------- conversation */

export function sortConversations(conversations) {
  return [...conversations].sort((a, b) => {
    const left = a.lastMessageAt ?? a.createdAt ?? "";
    const right = b.lastMessageAt ?? b.createdAt ?? "";
    return right.localeCompare(left);
  });
}

export function findConversation(state, conversationId) {
  return state.conversations.find((conversation) => conversation.id === conversationId) ?? null;
}

export function upsertConversation(state, conversation) {
  const index = state.conversations.findIndex((entry) => entry.id === conversation.id);
  const conversations = [...state.conversations];
  if (index === -1) conversations.push(conversation);
  else conversations[index] = { ...conversations[index], ...conversation };
  return sortConversations(conversations);
}

export function upsertUser(state, user) {
  if (!user?.id || state.users.has(user.id)) return state.users;
  const users = new Map(state.users);
  users.set(user.id, user);
  return users;
}

export function mergeUsers(state, users) {
  if (!Array.isArray(users) || users.length === 0) return state.users;
  const next = new Map(state.users);
  for (const user of users) {
    if (user?.id) next.set(user.id, { ...next.get(user.id), ...user });
  }
  return next;
}

/* -------------------------------------------------------------- message */

/** Insert or replace a message, keeping the list ordered by creation time. */
export function upsertMessage(messages, message) {
  const index = messages.findIndex((entry) => entry.id === message.id);
  if (index === -1) return [...messages, message].sort(byCreatedAt);
  const next = [...messages];
  next[index] = { ...next[index], ...message };
  return next;
}

export function byCreatedAt(a, b) {
  return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
}

export function unreadTotal(conversations) {
  return conversations.reduce((total, conversation) => total + (conversation.unread ?? 0), 0);
}