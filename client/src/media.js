import { el, qs, clear, template } from "./ui/dom.js";
import { toast } from "./ui/overlays.js";
import { APP_NAME } from "../config.js";

/**
 * Peer-to-peer audio, video and screen sharing for lcc-chat.
 *
 * Two paths, both WebRTC, both TURN-aware:
 *  - one-to-one calls use **PeerJS** for signalling (peer host, port and ICE
 *    servers come from the Worker, so nothing is hardcoded in the client);
 *  - group calls mesh directly over the room's WebSocket, using the
 *    `call.signal` relay, so no external signalling server is involved.
 *
 * Every connection state (connecting / connected / reconnecting / failed /
 * closed) is surfaced in the call bar, and all tracks are torn down on hang up.
 */

const ICE_CONFIG_KEY = "lcc-chat.ice";
const PEER_ID_PREFIX = "lcc-chat-";

/** PeerJS signalling id for an lcc-chat user id. */
export function peerIdFor(userId) {
  return `${PEER_ID_PREFIX}${userId}`;
}

export class MediaManager {
  constructor(app) {
    this.app = app;
    this.peer = null;
    this.peerId = null;
    this.peerCall = null; // { connection, stream } for 1:1 PeerJS calls
    this.mesh = new Map(); // userId -> RTCPeerConnection for group calls
    this.offeredTo = new Set(); // peers we already sent an offer to
    this.localStream = null;
    this.screenTrack = null;
    this.container = null;
    this.nodes = null;
    this.incomingCall = null;
    this.invitedBy = null;
    this.state = "idle"; // idle | calling | connected | reconnecting | failed | closed
    this.media = "audio"; // audio | video | screen
    this.overlay = null;
  }

  get config() {
    return this.app.mediaConfig ?? this.cachedConfig ?? { peer: { host: null, port: 443, path: "/", secure: true }, iceServers: [] };
  }

  get iceServers() {
    if (this.cachedConfig?.iceServers) return this.cachedConfig.iceServers;
    try {
      const cached = JSON.parse(localStorage.getItem(ICE_CONFIG_KEY) ?? "null");
      if (cached) return cached;
    } catch {
      /* ignore malformed cache */
    }
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }

  /** Remember the Worker-provided ICE config so calls work before /ready. */
  rememberConfig(mediaConfig) {
    this.cachedConfig = mediaConfig;
    try {
      localStorage.setItem(ICE_CONFIG_KEY, JSON.stringify(mediaConfig.iceServers ?? []));
    } catch {
      /* storage unavailable */
    }
  }

  /* ------------------------------------------------------------- public */

  isBusy() {
    return this.state !== "idle" && this.state !== "closed";
  }

  /** Start a call in the active conversation. */
  async start(kind) {
    const peers = this.app.callParticipants();
    if (peers.length === 0) {
      toast("Nobody else is in this conversation to call.", { kind: "warn" });
      return;
    }
    if (this.isBusy()) {
      toast("You are already in a call.", { kind: "warn" });
      return;
    }

    this.media = kind;
    try {
      this.localStream = kind === "video" ? await navigator.mediaDevices.getUserMedia({ audio: true, video: true }) : await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      toast(`Microphone/camera unavailable: ${error.message}`, { kind: "error", timeout: 6000 });
      return;
    }

    this.#mountOverlay();
    this.#setState("calling");

    const conversation = this.app.state.get().conversations.find((entry) => entry.id === this.app.state.get().activeConversationId);
    const isDirect = conversation?.type === "dm" && peers.length === 1;

    try {
      if (isDirect && window.Peer) await this.#startPeerCall(peers[0]);
      else await this.#startMeshCall();
    } catch (error) {
      this.#setState("failed");
      toast(`Call failed: ${error.message}`, { kind: "error", timeout: 6000 });
      this.end("error");
    }
  }

  end(reason = "local") {
    // Leaving locally: tell everyone so their overlays close too.
    if (reason === "local" && (this.mesh.size > 0 || this.peerCall)) {
      const targets = new Set([...this.mesh.keys(), ...this.app.callParticipants()]);
      for (const userId of targets) this.app.sendCallSignal(userId, { kind: "bye" });
    }

    this.incomingCall?.close();
    this.incomingCall = null;
    this.peerCall?.connection?.close();
    this.peerCall = null;
    for (const connection of this.mesh.values()) {
      try {
        connection.close();
      } catch {
        /* already closed */
      }
    }
    this.mesh.clear();
    this.offeredTo.clear();

    if (this.peer && !this.peer.destroyed) {
      try {
        this.peer.destroy();
      } catch {
        /* ignore */
      }
    }
    this.peer = null;
    this.peerId = null;

    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.localStream = null;
    this.screenTrack = null;

    this.#unmountOverlay();
    this.#setState(reason === "remote" ? "closed" : "idle");
    this.app.onCallEnded(reason);
  }

  /** Toggle a track and mirror it to every peer connection. */
  async toggleTrack(kind) {
    const stream = this.localStream;
    if (!stream) return;
    const tracks = kind === "mic" ? stream.getAudioTracks() : kind === "camera" ? stream.getVideoTracks() : [this.screenTrack].filter(Boolean);
    const enabled = tracks.some((track) => track.enabled);

    if (kind === "screen") {
      if (enabled) {
        this.#stopScreenShare();
        return;
      }
      await this.shareScreen();
      return;
    }

    for (const track of tracks) track.enabled = !enabled;
    this.#syncButtons();
  }

  /* ---------------------------------------------------------- 1:1 PeerJS */

  /**
   * Register with the signalling server ahead of time.
   *
   * PeerJS can only deliver a call to a peer that is already registered, so
   * every tab claims its deterministic id (`lcc-chat-<userId>`) as soon as the
   * app is ready. Calls then connect instantly.
   */
  async prewarm() {
    if (this.peer || !window.Peer) return;
    try {
      await this.#ensurePeer();
    } catch (error) {
      console.warn("[lcc-chat] peer prewarm failed", error);
    }
  }

  async #startPeerCall(remoteUserId) {
    this.#setState("connecting");
    // PeerJS addresses peers by their signalling id, which is derived from the
    // lcc-chat user id (`lcc-chat-<userId>`).
    const targetPeerId = peerIdFor(remoteUserId);

    // The callee may still be registering: PeerJS reports `peer-unavailable`
    // immediately, so retry a few times before giving up.
    let lastError = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!this.isBusy()) return;
      const peer = this.peer && !this.peer.destroyed ? this.peer : await this.#ensurePeer();
      const outcome = await new Promise((resolve) => {
        let call;
        try {
          call = peer.call(targetPeerId, this.localStream, { metadata: { media: this.media } });
        } catch (error) {
          resolve({ error });
          return;
        }
        this.peerCall = { connection: call, stream: null, incoming: false };

        call.on("stream", (stream) => {
          this.peerCall.stream = stream;
          this.#attachRemote(this.app.userName(remoteUserId), stream, "peerjs");
          this.#setState("connected");
        });
        call.on("close", () => {
          if (this.isBusy()) this.end("remote");
        });
        call.on("error", (error) => {
          if (error?.type === "peer-unavailable") resolve({ error });
          else {
            console.warn("[lcc-chat] peer call error", error);
            this.#setState("failed");
            resolve({ error });
          }
        });

        // Tell the other side a call is ringing (also warms their hub).
        this.app.sendCallSignal(remoteUserId, { kind: "state", media: this.media, state: "connecting" });
        resolve({ call });
      });

      if (outcome.call) return;
      lastError = outcome.error;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    throw lastError ?? new Error("Could not reach that person.");
  }

  /** Answer a call that arrived while we were idle (ringing). */
  async answerIncoming() {
    const call = this.incomingCall;
    this.incomingCall = null;
    if (!call) return false;

    try {
      this.localStream =
        this.localStream ?? (await navigator.mediaDevices.getUserMedia({ audio: true, video: this.media === "video" }));
    } catch (error) {
      call.close();
      toast(`Could not answer: ${error.message}`, { kind: "error" });
      return false;
    }

    this.#mountOverlay();
    call.answer(this.localStream);
    this.peerCall = { connection: call, stream: null, incoming: true };
    call.on("stream", (stream) => {
      this.peerCall.stream = stream;
      this.#attachRemote(this.app.userName(call.peer), stream, "peerjs");
      this.#setState("connected");
    });
    call.on("close", () => this.isBusy() && this.end("remote"));
    this.#attachLocal();
    this.#setState("connecting");
    return true;
  }

  async #ensurePeer() {
    if (this.peer && !this.peer.destroyed) return this.peer;

    const Peer = window.Peer;
    if (!Peer) throw new Error("PeerJS did not load — reloading may help.");

    const config = this.config.peer ?? {};
    this.peerId = peerIdFor(this.app.state.get().me.id);

    const options = { config: { iceServers: this.iceServers }, debug: config.debug ?? 1 };
    if (config.host) {
      options.host = config.host;
      options.port = config.port;
      options.path = config.path;
      options.secure = config.secure;
    }

    const peer = new Peer(this.peerId, options);
    this.peer = peer;

    peer.on("open", () => {
      this.#setState(this.isBusy() ? "connected" : "idle");
    });
    peer.on("disconnected", () => {
      if (this.isBusy()) this.#setState("reconnecting");
    });
    peer.on("error", (error) => {
      console.warn("[lcc-chat] peer error", error?.type ?? error);
      if (error?.type === "peer-unavailable") {
        if (!this.isBusy()) return; // handled by the call retry loop
        toast("That person is not reachable right now.", { kind: "warn" });
        this.end("remote");
        return;
      }
      if (error?.type === "unavailable-id") {
        // Another tab of the same user already owns this id — retry shortly.
        setTimeout(() => {
          if (this.peer === peer && !peer.destroyed) peer.reconnect();
        }, 3000);
        return;
      }
      if (this.isBusy()) this.#setState("failed");
    });

    peer.on("call", (call) => {
      if (this.isBusy()) {
        call.close(); // already talking to someone else
        return;
      }
      this.incomingCall = call;
      this.media = call.metadata?.media ?? "audio";
      this.#mountOverlay();
      this.#setState("connecting");
      this.app.onIncomingCall(call.peer, this.media);

      setTimeout(() => {
        if (this.incomingCall === call) {
          call.close();
          this.end("remote");
          this.app.onMissedCall(call.peer);
        }
      }, 45_000);
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Signalling server did not respond.")), 12_000);
      const onOpen = () => {
        clearTimeout(timer);
        peer.off("error", onError);
        resolve(peer);
      };
      const onError = (error) => {
        clearTimeout(timer);
        peer.off("open", onOpen);
        reject(error);
      };
      peer.on("open", onOpen);
      peer.on("error", onError);
    });
  }

  /* ------------------------------------------------------- group mesh */

  async #startMeshCall() {
    // Announce ourselves to the whole room, but only open connections to peers
    // that are already in the call (the roster) — plus whoever invited us.
    const inCall = new Set(this.app.state.get().callParticipants ?? []);
    if (this.invitedBy) inCall.add(this.invitedBy);

    for (const userId of this.app.callParticipants()) {
      this.app.sendCallSignal(userId, { kind: "state", media: this.media, state: "connecting" });
      if (!inCall.has(userId)) continue;
      const peer = this.#ensurePeerConnection(userId);
      this.#offerIfDesignated(userId, peer);
    }

    this.invitedBy = null;
    this.#setState("connecting");
    this.#attachLocal();
  }

  /** Deterministic offerer: the lexicographically smaller id calls. */
  #shouldOffer(remoteUserId) {
    const me = this.app.state.get().me.id;
    return me < remoteUserId;
  }

  /**
   * Both sides create the connection; only the smaller id offers. This keeps
   * the mesh glare-free no matter who joins first.
   */
  #offerIfDesignated(remoteUserId, peer) {
    if (!this.#shouldOffer(remoteUserId)) return;
    if (this.offeredTo.has(remoteUserId)) return;
    this.offeredTo.add(remoteUserId);
    peer
      .createOffer()
      .then((offer) => peer.setLocalDescription(offer))
      .then(() => this.app.sendCallSignal(remoteUserId, { kind: "offer", sdp: peer.localDescription.sdp }))
      .catch((error) => console.warn("[lcc-chat] offer failed", error));
  }

  /**
   * The server tells us who is in the call. Connect to anybody we do not yet
   * have a connection for — this also repairs a missed `state` signal.
   */
  syncRoster(participantIds) {
    if (!this.isBusy() || this.peerCall) return;
    for (const userId of participantIds) {
      if (userId === this.app.state.get().me.id || this.mesh.has(userId)) continue;
      const peer = this.#ensurePeerConnection(userId);
      this.#offerIfDesignated(userId, peer);
    }
  }

  /** Handle a relayed signal from another participant. */
  async handleSignal(fromUserId, payload) {
    if (!this.isBusy()) return;

    if (payload.kind === "bye") {
      this.#removeRemote(fromUserId);
      this.mesh.get(fromUserId)?.close();
      this.mesh.delete(fromUserId);
      this.offeredTo.delete(fromUserId);
      if (this.mesh.size === 0 && !this.peerCall) this.end("remote");
      return;
    }

    if (payload.kind === "state") {
      // Somebody joined: make sure we hold a connection to them.
      const peer = this.#ensurePeerConnection(fromUserId);
      this.#offerIfDesignated(fromUserId, peer);
      return;
    }

    const peer = this.#ensurePeerConnection(fromUserId);

    if (payload.kind === "offer" && payload.sdp) {
      if (peer.signalingState !== "stable") return; // glare: keep the first offer
      this.offeredTo.delete(fromUserId);
      await peer.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      this.app.sendCallSignal(fromUserId, { kind: "answer", sdp: answer.sdp });
      return;
    }

    if (payload.kind === "answer" && payload.sdp) {
      if (peer.signalingState === "have-local-offer") await peer.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      return;
    }

    if (payload.kind === "ice" && payload.candidate) {
      try {
        await peer.addIceCandidate(payload.candidate);
      } catch {
        /* candidate arrived too late */
      }
    }
  }

  #ensurePeerConnection(userId) {
    const existing = this.mesh.get(userId);
    if (existing) return existing;

    const connection = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: "max-bundle" });
    this.mesh.set(userId, connection);

    for (const track of this.localStream?.getTracks() ?? []) connection.addTrack(track, this.localStream);

    connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.app.sendCallSignal(userId, { kind: "ice", candidate: event.candidate.toJSON() });
      }
    };
    connection.ontrack = (event) => {
      const [stream] = event.streams;
      this.#attachRemote(this.app.userName(userId), stream ?? new MediaStream([event.track]), "mesh", userId);
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "connected") this.#setState("connected");
      if (connection.connectionState === "failed") this.#setState("failed");
      if (connection.connectionState === "disconnected") this.#setState("reconnecting");
    };
    connection.onnegotiationneeded = () => this.#offerIfDesignated(userId, connection);

    return connection;
  }

  /* --------------------------------------------------------- screen share */

  async shareScreen() {
    if (!this.isBusy() || !navigator.mediaDevices?.getDisplayMedia) {
      toast("Screen sharing is not available in this browser.", { kind: "warn" });
      return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = display.getVideoTracks()[0];
      if (!track) return;
      this.screenTrack = track;

      // Replace the camera track on every connection with the screen track.
      const senderTrack = this.localStream?.getVideoTracks()[0] ?? null;
      for (const connection of this.mesh.values()) {
        const sender = connection.getSenders().find((item) => item.track && item.track.kind === "video");
        if (sender) await sender.replaceTrack(track);
      }
      if (this.peerCall?.connection) {
        // PeerJS 1:1: replaceTrack on the underlying sender.
        const call = this.peerCall.connection;
        const senders = call.peerConnection?.getSenders?.() ?? [];
        const sender = senders.find((item) => item.track && item.track.kind === "video");
        if (sender) await sender.replaceTrack(track);
        else await call.replaceTrack(track, display);
      }

      this.#attachRemote("Your screen", display, "screen");
      this.#setState("connected");
      this.#syncButtons();

      track.addEventListener("ended", () => this.#stopScreenShare());
      this.app.sendCallSignal(this.app.callParticipants()[0] ?? "", { kind: "state", media: "screen" });
    } catch (error) {
      if (error?.name !== "NotAllowedError") toast(`Screen share failed: ${error.message}`, { kind: "error" });
    }
  }

  async #stopScreenShare() {
    const track = this.screenTrack;
    if (!track) return;
    track.stop();
    this.screenTrack = null;

    const camera = this.localStream?.getVideoTracks()[0] ?? null;
    for (const connection of this.mesh.values()) {
      const sender = connection.getSenders().find((item) => item.track && item.track.kind === "video");
      if (sender) await sender.replaceTrack(camera);
    }
    if (this.peerCall?.connection) {
      const senders = this.peerCall.connection.peerConnection?.getSenders?.() ?? [];
      const sender = senders.find((item) => item.track && item.track.kind === "video");
      if (sender && camera) await sender.replaceTrack(camera);
    }
    this.#removeRemote("Your screen");
    this.#syncButtons();
  }

  /* --------------------------------------------------------------- view */

  #mountOverlay() {
    if (this.overlay) return;
    const shell = template("tpl-call");
    this.nodes = {
      stage: qs("#call-stage", shell),
      state: qs("#call-state", shell),
      title: qs("#call-title", shell),
      mic: qs("#call-mic", shell),
      cam: qs("#call-cam", shell),
      screen: qs("#call-screen", shell),
      hangup: qs("#call-hangup", shell),
    };
    this.nodes.title.textContent = this.#callTitle();
    this.nodes.mic.addEventListener("click", () => this.toggleTrack("mic"));
    this.nodes.cam.addEventListener("click", () => this.toggleTrack("camera"));
    this.nodes.screen.addEventListener("click", () => this.toggleTrack("screen"));
    this.nodes.hangup.addEventListener("click", () => this.end("local"));

    // Capture the element before appending: appending empties the fragment.
    const overlay = shell.firstElementChild ?? shell;
    document.body.append(shell);
    this.overlay = overlay;
    this.#attachLocal();
    this.#syncButtons();
  }

  #unmountOverlay() {
    this.overlay?.remove();
    this.overlay = null;
    this.nodes = null;
  }

  /** "Bob" for a one-to-one call, "Bob, Cara" for a group. */
  #callTitle() {
    const names = this.app.callParticipants().map((userId) => this.app.userName(userId));
    if (names.length === 0) return APP_NAME;
    return names.join(", ");
  }

  #attachLocal() {
    if (!this.nodes || !this.localStream) return;
    clear(this.nodes.stage);
    this.nodes.stage.append(videoNode("You", this.localStream, true));
  }

  #attachRemote(label, stream, kind, userId) {
    if (!this.nodes) return;
    const id = userId ?? kind;
    let node = this.nodes.stage.querySelector(`[data-remote="${CSS.escape(id)}"]`);
    if (!node) {
      node = el("div", { class: "call__tile", dataset: { remote: id } }, [
        el("span", { class: "call__tile-label", text: label }),
        el("video", { autoplay: true, playsinline: true }),
        el("div", { class: "call__tile-audio" }),
      ]);
      const audio = node.querySelector("video");
      audio.muted = true; // the visible <video> must stay muted; audio plays through the hidden one
      this.nodes.stage.append(node);
    }
    const video = node.querySelector("video");
    if (video.srcObject !== stream) video.srcObject = stream;
    video.style.display = stream.getVideoTracks().length > 0 ? "block" : "none";
    node.querySelector(".call__tile-label").textContent = label;

    if (stream.getAudioTracks().length > 0) {
      const audio = node.querySelector(".call__tile-audio");
      audio.srcObject = new MediaStream(stream.getAudioTracks());
      audio.play?.().catch(() => undefined);
    }
  }

  #removeRemote(id) {
    this.nodes?.stage.querySelector(`[data-remote="${CSS.escape(id)}"]`)?.remove();
  }

  #setState(state) {
    this.state = state;
    if (!this.nodes) return;
    this.nodes.state.textContent = state;
    this.nodes.state.dataset.state = state;
    this.app.onCallState(state);
    this.#syncButtons();
  }

  #syncButtons() {
    if (!this.nodes) return;
    const stream = this.localStream;
    const micOn = (stream?.getAudioTracks()[0]?.enabled ?? true) === true;
    const camOn = (stream?.getVideoTracks()[0]?.enabled ?? true) === true && Boolean(stream?.getVideoTracks()[0]);
    this.nodes.mic.classList.toggle("icon-button--off", !micOn);
    this.nodes.cam.classList.toggle("icon-button--off", !camOn || this.media !== "video");
    this.nodes.screen.classList.toggle("icon-button--off", !this.screenTrack);
    this.nodes.screen.title = this.screenTrack ? "Stop sharing" : "Share screen";
  }
}

function videoNode(label, stream, muted) {
  const video = el("video", { class: "call__video", autoplay: true, playsinline: true, muted: muted || undefined });
  video.srcObject = stream;
  return el("div", { class: "call__tile call__tile--self" }, [video, el("span", { class: "call__tile-label", text: label })]);
}