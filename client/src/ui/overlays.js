import { el, qs } from "./dom.js";

/** Tiny toast + modal helpers used across the UI. */

export function toast(message, { kind = "info", timeout = 4200, action } = {}) {
  const root = qs("#toast-root");
  if (!root) return;

  const node = el("div", { class: `toast toast--${kind}`, role: "status" }, [
    el("span", { class: "toast__text", text: message }),
    action ? el("button", { class: "toast__action", type: "button", text: action.label }) : null,
  ]);

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    node.classList.add("toast--leaving");
    setTimeout(() => node.remove(), 200);
  };

  if (action) {
    qs(".toast__action", node).addEventListener("click", () => {
      action.onClick?.();
      dismiss();
    });
  }
  node.addEventListener("click", (event) => {
    if (event.target.closest(".toast__action")) return;
    dismiss();
  });

  root.append(node);
  timer = setTimeout(dismiss, timeout);
}

/**
 * Modal dialog built from a builder function.
 * @returns {{ close: () => void, body: HTMLElement }}
 */
export function openModal({ title, subtitle, render, onClose, size = "md" }) {
  const root = qs("#modal-root");
  const previouslyFocused = document.activeElement;

  const body = el("div", { class: "modal__body" });
  const dialog = el(
    "div",
    { class: `modal modal--${size}`, role: "dialog", "aria-modal": "true", "aria-label": title },
    [
      el("header", { class: "modal__header" }, [
        el("div", {}, [
          el("h2", { class: "modal__title", text: title }),
          subtitle ? el("p", { class: "modal__subtitle", text: subtitle }) : null,
        ]),
        el("button", { class: "icon-button", type: "button", "aria-label": "Close", onclick: () => close() }, [
          icon("M6 6l12 12M18 6 6 18"),
        ]),
      ]),
      body,
    ],
  );

  const backdrop = el("div", { class: "modal-backdrop", onclick: (event) => event.target === backdrop && close() }, [dialog]);
  root.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add("modal-backdrop--visible"));

  const onKeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
  document.addEventListener("keydown", onKeydown);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown);
    backdrop.classList.remove("modal-backdrop--visible");
    setTimeout(() => backdrop.remove(), 160);
    onClose?.();
    previouslyFocused?.focus?.();
  }

  render?.(body, { close });
  qs("input, textarea, button", body)?.focus();
  return { close, body };
}

/** Inline SVG from a path spec (keeps index.html readable). */
export function icon(path, viewBox = "0 0 24 24") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = "";
  const node = document.createElementNS("http://www.w3.org/2000/svg", "path");
  node.setAttribute("d", path);
  svg.append(node);
  return svg;
}

export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = true }) {
  return new Promise((resolve) => {
    openModal({
      title,
      render(body, { close }) {
        body.append(
          el("p", { class: "muted", text: message }),
          el("div", { class: "modal__actions" }, [
            el("button", { class: "button", type: "button", text: "Cancel", onclick: () => close() }),
            el("button", {
              class: `button ${danger ? "button--danger" : "button--primary"}`,
              type: "button",
              text: confirmLabel,
              onclick: () => {
                resolve(true);
                close();
              },
            }),
          ]),
        );
      },
      onClose: () => resolve(false),
    });
  });
}