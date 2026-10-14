/**
 * lcc-chat — the only environment-specific value in the whole frontend.
 *
 * Point `WORKER_URL` at your deployed Worker and the rest of /client follows:
 * every REST call and both WebSockets are derived from it. Nothing else in
 * this folder may hardcode a backend URL, and no secret ever lives here.
 *
 *   local `pnpm dev` (server)  ->  http://127.0.0.1:8787
 *   deployed Worker            ->  https://lcc-chat.<your-subdomain>.workers.dev
 *   forwarded dev port         ->  https://<codespace>-8787.app.github.dev
 *
 * For one-off testing you can override the value without editing this file:
 *   http://localhost:5173/?worker=http://127.0.0.1:8787
 * The override is remembered in localStorage for that browser only.
 *
 * If the configured Worker cannot be reached (a forwarded/tunnelled port that
 * needs a sign-in, a Worker that is not running yet, …) the app falls back to
 * `FALLBACK_WORKER_URL` so local development always works. The fallback is
 * reported in the console and in the sidebar.
 */
const DEFAULT_WORKER_URL = "https://lcc-chattest.catboxfat.workers.dev/";

/** Where `pnpm dev` listens inside this machine. */
const FALLBACK_WORKER_URL = "https://lcc-chattest.catboxfat.workers.dev/";

const OVERRIDE_KEY = "lcc-chat.worker";
const ACTIVE_KEY = "lcc-chat.worker.active";
const PROBE_TIMEOUT_MS = 2500;

function normalize(url) {
  return String(url).trim().replace(/\/+$/, "");
}

function readOverride() {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get("worker");
    if (fromQuery) {
      localStorage.setItem(OVERRIDE_KEY, fromQuery);
      return fromQuery;
    }
    return localStorage.getItem(OVERRIDE_KEY);
  } catch {
    return null;
  }
}

/** The configured Worker — the single value you are expected to edit. */
export const WORKER_URL = normalize(readOverride() ?? DEFAULT_WORKER_URL);

/**
 * Remembered for this tab session only, so an unreachable Worker does not cost
 * a probe on every reload — but a fixed Worker is picked up again in the next
 * tab.
 */
function rememberActive(url) {
  try {
    sessionStorage.setItem(ACTIVE_KEY, url);
  } catch {
    /* private mode: probe again next time */
  }
}

/** The Worker the app is actually talking to right now. */
export function activeWorkerUrl() {
  try {
    return normalize(sessionStorage.getItem(ACTIVE_KEY) ?? WORKER_URL);
  } catch {
    return WORKER_URL;
  }
}

export function activeWsBaseUrl() {
  return activeWorkerUrl().replace(/^http/, "ws");
}

/** `https://…` -> `wss://…`, `http://…` -> `ws://…` (for the configured URL). */
export const WS_BASE_URL = WORKER_URL.replace(/^http/, "ws");

/** Short app name used in titles and notifications. */
export const APP_NAME = "lcc-chat";

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.service === "lcc-chat";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick the Worker to use: the configured one when it answers, otherwise the
 * local fallback. Never throws.
 */
export async function resolveWorkerUrl() {
  if (await probe(WORKER_URL)) {
    rememberActive(WORKER_URL);
    return { url: WORKER_URL, usedFallback: false };
  }

  if (normalize(FALLBACK_WORKER_URL) !== WORKER_URL && (await probe(FALLBACK_WORKER_URL))) {
    rememberActive(FALLBACK_WORKER_URL);
    console.warn(
      `[lcc-chat] ${WORKER_URL} is not answering — using the local Worker at ${FALLBACK_WORKER_URL}. ` +
        "Start it with `pnpm dev` in /server, or set the Worker URL in client/config.js.",
    );
    return { url: normalize(FALLBACK_WORKER_URL), usedFallback: true };
  }

  rememberActive(WORKER_URL);
  return { url: WORKER_URL, usedFallback: false };
}