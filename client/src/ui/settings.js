import { el, avatarNode } from "./dom.js";
import { openModal, confirmDialog, toast } from "./overlays.js";
import { api, setToken } from "../api.js";
import { activeWorkerUrl, WORKER_URL, APP_NAME } from "../../config.js";
import { ConnectionState } from "../realtime.js";

/** Profile, connection info and the "start over" (new session) action. */
export function openSettings(app) {
  const me = app.state.get().me;
  const media = app.mediaConfig;

  openModal({
    title: "You",
    subtitle: `${APP_NAME} never asks for a sign-up.`,
    render(body, { close }) {
      const nameInput = el("input", { class: "input", type: "text", maxlength: "32", value: me.displayName });
      const avatarInput = el("input", {
        class: "input",
        type: "url",
        placeholder: "https://… (optional avatar image URL)",
        value: me.avatarUrl ?? "",
      });

      const save = el("button", {
        class: "button button--primary",
        type: "button",
        text: "Save changes",
        onclick: async () => {
          const patch = {};
          if (nameInput.value.trim() && nameInput.value.trim() !== me.displayName) {
            patch.displayName = nameInput.value.trim();
          }
          if (avatarInput.value.trim() !== (me.avatarUrl ?? "")) patch.avatarUrl = avatarInput.value.trim();
          if (Object.keys(patch).length === 0) {
            close();
            return;
          }
          save.disabled = true;
          try {
            const { user } = await api.updateMe(patch);
            app.updateMe(user);
            toast("Profile updated.", { kind: "success", timeout: 2000 });
            close();
          } catch (error) {
            toast(error.message ?? "Could not save.", { kind: "error" });
          } finally {
            save.disabled = false;
          }
        },
      });

      const notifications = el("input", { type: "checkbox" });
      notifications.checked = Notification?.permission === "granted";
      notifications.addEventListener("change", async () => {
        if (!("Notification" in window)) {
          notifications.checked = false;
          toast("This browser cannot show notifications.", { kind: "warn" });
          return;
        }
        const permission = notifications.checked ? await Notification.requestPermission() : "denied";
        notifications.checked = permission === "granted";
      });

      const connectionLabel = {
        [ConnectionState.CONNECTING]: "connecting",
        [ConnectionState.OPEN]: "connected",
        [ConnectionState.RECONNECTING]: "reconnecting",
        [ConnectionState.CLOSED]: "closed",
        [ConnectionState.FAILED]: "failed",
      }[app.state.get().connection] ?? "unknown";

      body.append(
        el("div", { class: "settings__identity" }, [
          avatarNode({ name: me.displayName, color: me.color, avatarUrl: me.avatarUrl, size: "xl" }),
          el("div", {}, [
            el("strong", { text: me.displayName }),
            el("div", { class: "muted", text: `@${me.username} · id ${me.id}` }),
          ]),
        ]),
        el("label", { class: "field" }, [el("span", { text: "Display name" }), nameInput]),
        el("label", { class: "field" }, [el("span", { text: "Avatar URL" }), avatarInput]),
        el("label", { class: "field field--row" }, [
          el("span", { text: "Desktop notifications for messages in other chats" }),
          notifications,
        ]),
        el("div", { class: "settings__facts" }, [
          fact("Worker", activeWorkerUrl() === WORKER_URL ? activeWorkerUrl() : `${activeWorkerUrl()} (fallback)`),
          fact("Signalling", media?.peer?.host ? `PeerServer ${media.peer.host}` : "PeerJS Cloud (dev)"),
          fact("ICE servers", `${media?.iceServers?.length ?? 0} configured (${media?.iceServers?.some((server) => server.username) ? "TURN included" : "STUN only"})`),
          fact("Connection", connectionLabel),
          fact("Session created", new Date(me.createdAt).toLocaleString()),
        ]),
        el("div", { class: "modal__actions modal__actions--split" }, [
          el("button", {
            class: "button button--danger",
            type: "button",
            text: "Start a new session",
            onclick: async () => {
              const confirmed = await confirmDialog({
                title: "Forget this session?",
                message:
                  "Your browser token is cleared and you will be asked for a name again. Your messages stay in their conversations.",
                confirmLabel: "Forget me",
              });
              if (confirmed) {
                setToken(null);
                location.reload();
              }
            },
          }),
          save,
        ]),
      );
    },
  });
}

function fact(label, value) {
  return el("div", { class: "fact" }, [
    el("span", { class: "fact__label", text: label }),
    el("span", { class: "fact__value", text: String(value) }),
  ]);
}