// Connection to the Videoclaw desktop app (0.2.x).
//
// Videoclaw runs a local server that its window talks to over a WebSocket
// (Effect RPC, JSON). The window learns the server's port and secret from
// `window.videoclaw.server()`. We read that through the DevTools port, then
// open our own WebSocket to the same server and call the same methods the
// app's UI calls, so auth, billing, budgets and approvals stay in Videoclaw.
import { spawn, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const PORT = Number(process.env.VIDEOCLAW_CDP_PORT ?? 9339);
const APP = process.env.VIDEOCLAW_APP ?? "/Applications/Videoclaw.app";
export const DATA_DIR = join(homedir(), "Library", "Application Support", "videoclaw-app", "data");
export const WORKSPACE = join(DATA_DIR, "workspace");
const DB = join(DATA_DIR, "videoclaw.sqlite");
// Set VIDEOCLAW_AUTO_LAUNCH=0 to never start or restart Videoclaw automatically.
const AUTO_LAUNCH = process.env.VIDEOCLAW_AUTO_LAUNCH !== "0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── DevTools: only used to read the server address ─────────────────────────

async function findPage() {
  let targets;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    targets = await res.json();
  } catch {
    throw new Error(
      `Videoclaw isn't reachable on DevTools port ${PORT}. Run \`vc launch --restart\` ` +
        `(it restarts Videoclaw with --remote-debugging-port=${PORT}).`,
    );
  }
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  if (!page) throw new Error("Videoclaw is running but its main window isn't open yet.");
  return page;
}

/** Evaluate an expression in the Videoclaw window and return its JSON value. */
async function evaluate(expression) {
  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("DevTools connection failed.")), { once: true });
    });
    const reply = new Promise((resolve) =>
      ws.addEventListener("message", (m) => {
        const data = JSON.parse(m.data);
        if (data.id === 1) resolve(data);
      }),
    );
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
    const data = await reply;
    if (data.error) throw new Error(data.error.message);
    const { result, exceptionDetails } = data.result;
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  } finally {
    ws.close();
  }
}

async function serverAddress() {
  if (AUTO_LAUNCH) await ensureApp();
  for (let i = 0; i < 20; i++) {
    const address = await evaluate(
      "window.videoclaw && typeof window.videoclaw.server === 'function' ? window.videoclaw.server() : null",
    ).catch(() => null);
    if (address?.port && address?.secret) return address;
    await sleep(500);
  }
  throw new Error(
    "Videoclaw is open, but it doesn't offer the server bridge this plugin uses. " +
      "This plugin needs Videoclaw 0.2 or newer; update Videoclaw or this plugin.",
  );
}

// ── app lifecycle ──────────────────────────────────────────────────────────

export async function isReachable() {
  try {
    await findPage();
    return true;
  } catch {
    return false;
  }
}

export function isRunning() {
  try {
    execFileSync("pgrep", ["-f", `${APP}/Contents/MacOS/`]);
    return true;
  } catch {
    return false;
  }
}

/** Titles of videos with a turn in progress. Read from the app's database, so it works with the port closed. */
export function busyVideos() {
  try {
    const out = execFileSync(
      "sqlite3",
      [
        "-readonly",
        DB,
        "select v.title from turns t join videos v on v.id = t.video_id where t.status <> 'ended'",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Make sure Videoclaw is reachable: start it if it's closed, and restart it
 * with the port if it was opened without one (after an update or a Dock
 * launch), but never while a video is mid-turn.
 */
async function ensureApp() {
  if (await isReachable()) return;
  if (isRunning()) {
    const busy = busyVideos();
    if (busy.length) {
      throw new Error(
        `Videoclaw is open without its DevTools port and is busy (${busy.join(", ")}). ` +
          "It reconnects automatically once that job finishes; try again then, or run " +
          "`vc launch --restart` to interrupt it.",
      );
    }
  }
  await launch({ restart: true });
}

/** Start (or restart) Videoclaw with the DevTools port open on 127.0.0.1. */
export async function launch({ restart = false } = {}) {
  if (await isReachable()) return { status: "already-reachable", port: PORT };
  if (isRunning()) {
    if (!restart) {
      throw new Error(
        "Videoclaw is already running without the DevTools port. Re-run with --restart " +
          "to quit and relaunch it (running turns are interrupted).",
      );
    }
    execFileSync("osascript", ["-e", 'tell application "Videoclaw" to quit']);
    for (let i = 0; i < 120 && isRunning(); i++) await sleep(250);
    if (isRunning()) throw new Error("Videoclaw didn't quit; close it and try again.");
  }
  // `open` forwards our environment. Inside another Electron app (VS Code, T3,
  // Claude Desktop) ELECTRON_RUN_AS_NODE would make Videoclaw exit at once.
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  spawn("open", ["-a", APP, "--args", `--remote-debugging-port=${PORT}`, "--remote-debugging-address=127.0.0.1"], {
    detached: true,
    stdio: "ignore",
    env,
  }).unref();
  for (let i = 0; i < 120; i++) {
    if (await isReachable()) {
      await sleep(1500);
      return { status: "launched", port: PORT };
    }
    await sleep(500);
  }
  throw new Error("Videoclaw started but the DevTools port never came up.");
}

// ── RPC client ─────────────────────────────────────────────────────────────

export class VideoclawError extends Error {
  constructor(message, tag, detail) {
    super(message);
    this.tag = tag;
    this.detail = detail;
  }
}

const FRIENDLY = {
  TurnInProgress: "Videoclaw is still working on this video.",
  VideoNotFound: "No Videoclaw video has that id. Use videoclaw_list_sessions.",
  ProjectNotFound: "No Videoclaw project has that id. Use videoclaw_list_clients.",
  VersionNotFound: "This video has no version with that number.",
  QuestionNotOpen: "That question is no longer open.",
  AskNotOpen: "That request is no longer open.",
  NoLiveTurn: "Nothing is running on this video.",
  UpdateRequired: "Videoclaw needs an update before it can do this.",
  ServerStopping: "Videoclaw is shutting down. Try again in a moment.",
  StoreUnavailable: "Videoclaw couldn't read or save its data. Try again.",
};

function failure(cause = []) {
  const fail = cause.find((c) => c._tag === "Fail");
  if (fail) {
    const err = fail.error ?? {};
    const tag = err._tag ?? "Error";
    const extra = Object.entries(err)
      .filter(([k]) => k !== "_tag")
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(", ");
    return new VideoclawError(`${FRIENDLY[tag] ?? tag}${extra ? ` (${tag}; ${extra})` : ""}`, tag, err);
  }
  const die = cause.find((c) => c._tag === "Die");
  if (die) return new VideoclawError(`Videoclaw rejected the request: ${String(die.defect)}`, "Defect", die.defect);
  if (cause.some((c) => c._tag === "Interrupt")) return new VideoclawError("Videoclaw interrupted the request.", "Interrupt");
  return new VideoclawError(`Videoclaw failed: ${JSON.stringify(cause)}`, "Unknown", cause);
}

class Rpc {
  constructor() {
    this.ws = null;
    this.opening = null;
    this.nextId = 1;
    this.handlers = new Map();
  }

  async open() {
    if (this.ws?.readyState === WebSocket.OPEN) return this.ws;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const { port, secret } = await serverAddress();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["videoclaw", `videoclaw.secret.${secret}`]);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", () => reject(new Error("Couldn't connect to the Videoclaw server.")), {
          once: true,
        });
      });
      ws.addEventListener("message", (m) => this.onMessage(m.data));
      ws.addEventListener("close", () => {
        if (this.ws === ws) this.ws = null;
        clearInterval(this.pinger);
        for (const h of this.handlers.values()) h.onExit(new VideoclawError("Lost the connection to Videoclaw.", "Closed"));
        this.handlers.clear();
      });
      this.pinger = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('{"_tag":"Ping"}');
      }, 10_000);
      this.pinger.unref?.();
      this.ws = ws;
      return ws;
    })();
    try {
      return await this.opening;
    } finally {
      this.opening = null;
    }
  }

  onMessage(raw) {
    for (const msg of [].concat(JSON.parse(String(raw)))) {
      if (msg._tag === "Ping") {
        this.ws?.send('{"_tag":"Pong"}');
        continue;
      }
      const h = this.handlers.get(msg.requestId);
      if (!h) continue;
      if (msg._tag === "Chunk") {
        this.ws?.send(JSON.stringify({ _tag: "Ack", requestId: msg.requestId }));
        for (const v of msg.values ?? []) h.onChunk(v);
      } else if (msg._tag === "Exit") {
        this.handlers.delete(msg.requestId);
        if (msg.exit?._tag === "Success") h.onExit(null, msg.exit.value);
        else h.onExit(failure(msg.exit?.cause));
      } else if (msg._tag === "Defect") {
        this.handlers.delete(msg.requestId);
        h.onExit(new VideoclawError(`Videoclaw error: ${JSON.stringify(msg.defect)}`, "Defect"));
      }
    }
  }

  async request(tag, payload, onChunk = () => {}) {
    const ws = await this.open();
    const id = String(this.nextId++);
    let settle;
    const done = new Promise((resolve, reject) => {
      settle = (err, value) => (err ? reject(err) : resolve(value));
    });
    this.handlers.set(id, { onChunk, onExit: settle });
    ws.send(JSON.stringify({ _tag: "Request", id, tag, payload: payload ?? null, headers: [] }));
    const cancel = () => {
      if (!this.handlers.has(id)) return;
      this.handlers.delete(id);
      settle(null);
      this.ws?.send(JSON.stringify({ _tag: "Interrupt", requestId: id, interruptors: [] }));
    };
    return { done, cancel };
  }

  /** Call a method and return its result. */
  async call(tag, payload) {
    const { done } = await this.request(tag, payload);
    return done;
  }

  /**
   * Read a stream. `onValue` gets each value and returns true to stop.
   * Resolves when it stops, the stream ends, or `timeoutMs` passes.
   */
  async watch(tag, payload, onValue, { timeoutMs = 10_000 } = {}) {
    let req;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      req?.cancel();
    };
    req = await this.request(tag, payload, (v) => {
      if (!stopped && onValue(v)) stop();
    });
    const timer = setTimeout(stop, timeoutMs);
    try {
      await req.done;
    } finally {
      clearTimeout(timer);
      stopped = true;
    }
  }

  /** The first value of a stream (its snapshot). */
  async first(tag, payload, { timeoutMs = 10_000 } = {}) {
    let value;
    let got = false;
    await this.watch(tag, payload, (v) => ((value = v), (got = true)), { timeoutMs });
    if (!got) throw new VideoclawError(`Videoclaw didn't answer ${tag} in time.`, "Timeout");
    return value;
  }

  close() {
    clearInterval(this.pinger);
    this.ws?.close();
    this.ws = null;
  }

  /** Base URL of the Videoclaw server, for uploads. */
  async baseUrl() {
    const ws = await this.open();
    return ws.url.replace(/^ws/, "http").replace(/\/ws$/, "");
  }
}

export const rpc = new Rpc();
