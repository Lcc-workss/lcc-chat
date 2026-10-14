/** Minimal DOM helpers. Everything user-supplied is inserted as text, never HTML. */

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of [children].flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

/** Clone a `<template>` from index.html (all of its top-level nodes). */
export function template(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing template #${id}`);
  return node.content.cloneNode(true);
}

export function initials(name = "?") {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts.at(-1)[0]).toUpperCase();
}

/**
 * Build an avatar element. Images only ever load from the profile's own URL;
 * anything missing falls back to coloured initials.
 */
export function avatarNode({ name = "", color = "#6366f1", avatarUrl, size = "md", presence, title }) {
  const node = el("div", { class: `avatar avatar--${size}`, title: title ?? name });
  if (avatarUrl) {
    const image = el("img", { src: avatarUrl, alt: "", loading: "lazy" });
    image.addEventListener("error", () => {
      image.remove();
      node.append(el("span", { text: initials(name) }));
      node.style.background = color;
    });
    node.append(image);
  } else {
    node.append(el("span", { text: initials(name) }));
    node.style.background = color;
  }
  if (presence) node.classList.add("avatar--online");
  return node;
}

/** "now", "3m", "2h", "Tue", "12 Mar" — compact enough for a chat list. */
export function shortTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604_800) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function dayLabel(iso) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}

export function clockTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function previewOf(conversation, users, myId) {
  const last = conversation.lastMessage;
  if (!last) return "No messages yet";
  if (last.deletedAt) return "Message deleted";
  const prefix = last.senderId === myId ? "You: " : conversation.type === "group" ? `${firstName(users, last.senderId)}: ` : "";
  const body = last.content.replace(/\s+/g, " ").trim();
  return `${prefix}${body.length > 48 ? `${body.slice(0, 48)}…` : body}`;
}

function firstName(users, userId) {
  return users.get(userId)?.displayName?.split(/\s+/)[0] ?? "Someone";
}

export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}