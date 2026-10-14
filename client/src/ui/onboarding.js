import { el, qs } from "./dom.js";
import { api, setToken } from "../api.js";
import { toast } from "./overlays.js";
import { APP_NAME } from "../../config.js";

/**
 * The one and only "registration" step in lcc-chat.
 *
 * No email, no password, no verification: pick a display name and the Worker
 * hands back a signed token that this browser keeps in localStorage.
 */
export function renderOnboarding(app) {
  const root = qs("#app");
  root.dataset.state = "onboarding";
  root.replaceChildren();

  const input = el("input", {
    class: "onboarding__input",
    id: "display-name",
    type: "text",
    maxlength: "32",
    placeholder: "e.g. Ada Lovelace",
    autocomplete: "nickname",
    required: true,
  });

  const error = el("p", { class: "onboarding__error", hidden: true });

  const submit = async (event) => {
    event?.preventDefault();
    const displayName = input.value.trim();
    if (displayName.length < 2) {
      error.hidden = false;
      error.textContent = "Pick a name with at least 2 characters.";
      input.focus();
      return;
    }

    button.disabled = true;
    button.textContent = "Joining…";
    error.hidden = true;
    try {
      const { token, user } = await api.createSession(displayName);
      setToken(token);
      toast(`Welcome to ${APP_NAME}, ${user.displayName}.`, { kind: "success" });
      app.start(user);
    } catch (problem) {
      button.disabled = false;
      button.textContent = "Start chatting";
      error.hidden = false;
      error.textContent = problem.message ?? "Could not start a session.";
    }
  };

  const button = el("button", { class: "button button--primary button--lg", type: "submit", text: "Start chatting" });

  const form = el("form", { class: "onboarding", onsubmit: submit }, [
    el("div", { class: "onboarding__mark", "aria-hidden": "true" }),
    el("h1", { class: "onboarding__title", text: APP_NAME }),
    el("p", { class: "onboarding__lead", text: "Realtime chat with no sign-up. Pick a name and you are in." }),
    el("div", { class: "onboarding__field" }, [input, button]),
    error,
    el(
      "ul",
      { class: "onboarding__points" },
      [
        "Direct messages and group chats",
        "Live typing, read receipts and presence",
        "Peer-to-peer audio, video and screen sharing",
      ].map((text) => el("li", { text })),
    ),
  ]);

  root.append(form);
  input.focus();

  // If a session already exists, go straight to the app.
  if (app.state.get().me) app.start(app.state.get().me);
}