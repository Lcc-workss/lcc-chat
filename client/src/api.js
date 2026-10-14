import { activeWorkerUrl } from "../config.js";

/**
 * Tiny REST client for the lcc-chat Worker.
 *
 * Every request goes through `WORKER_URL` (see /client/config.js) and carries
 * the session token from `session.js`. Errors are surfaced as `ApiError` so
 * the UI can tell "you are offline" apart from "that chat is not yours".
 */

const TOKEN_KEY = "lcc-chat.token";

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the session simply does not persist across reloads */
  }
}

async function request(path, { method = "GET", body, auth = true, signal } = {}) {
  const token = auth ? getToken() : null;
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${activeWorkerUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new ApiError(0, "NETWORK_ERROR", "Cannot reach the lcc-chat Worker. Check your connection.");
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const error = data?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? "UNKNOWN",
      error.message ?? `Request failed (${response.status}).`,
      error.details,
    );
  }
  return data;
}

export const api = {
  health: () => request("/health", { auth: false }),

  /** No sign-up: a display name is the only thing a new visitor provides. */
  createSession: (displayName) => request("/api/session", { method: "POST", body: { displayName }, auth: false }),

  me: () => request("/api/me"),
  updateMe: (patch) => request("/api/me", { method: "PATCH", body: patch }),

  conversations: () => request("/api/conversations"),
  conversation: (conversationId) => request(`/api/conversations/${encodeURIComponent(conversationId)}`),
  messages: (conversationId, { before, limit = 50, signal } = {}) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set("before", String(before));
    return request(`/api/conversations/${encodeURIComponent(conversationId)}/messages?${query}`, { signal });
  },
  markRead: (conversationId, messageIds) =>
    request(`/api/conversations/${encodeURIComponent(conversationId)}/read`, { method: "POST", body: { messageIds } }),

  createDm: (userId) => request("/api/conversations/dm", { method: "POST", body: { userId } }),
  createGroup: (participantIds, title) =>
    request("/api/conversations/group", { method: "POST", body: { participantIds, title } }),

  searchUsers: (query) => request(`/api/users?q=${encodeURIComponent(query ?? "")}`),
  presence: () => request("/api/presence"),
  mediaConfig: () => request("/api/media/config"),
};