// Drives the running Videoclaw desktop app through Chrome DevTools Protocol.
// Every call evaluates code in the app's renderer, using the same
// `window.videoclaw` bridge the app's own UI uses — so sessions, approvals,
// budgets and billing all stay inside the app.
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PORT = Number(process.env.VIDEOCLAW_CDP_PORT ?? 9339);
const APP = process.env.VIDEOCLAW_APP ?? "/Applications/Videoclaw.app";
const USER_DATA = join(homedir(), "Library", "Application Support", "Videoclaw");
// Set VIDEOCLAW_AUTO_LAUNCH=0 to never start or restart Videoclaw automatically.
const AUTO_LAUNCH = process.env.VIDEOCLAW_AUTO_LAUNCH !== "0";

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

class Cdp {
  static async connect() {
    if (AUTO_LAUNCH) await ensureApp();
    const page = await findPage();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("DevTools connection failed.")), { once: true });
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (msg) => {
      const data = JSON.parse(msg.data);
      const waiter = data.id && this.pending.get(data.id);
      if (!waiter) return;
      this.pending.delete(data.id);
      data.error ? waiter.reject(new Error(data.error.message)) : waiter.resolve(data.result);
    });
  }

  send(method, params) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Evaluate `fn(arg)` in the renderer and return its (awaited) JSON result. */
  async call(fn, arg) {
    const expression = `(${fn.toString()})(${JSON.stringify(arg ?? null)})`;
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }

  close() {
    this.ws.close();
  }
}

async function withApp(fn, arg) {
  const cdp = await Cdp.connect();
  try {
    return await cdp.call(fn, arg);
  } finally {
    cdp.close();
  }
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

/** Sessions the app's registry says are mid-turn (readable even when the port is closed). */
function runningSessions() {
  try {
    const registry = JSON.parse(readFileSync(join(USER_DATA, "sessions.json"), "utf8"));
    return (registry.sessions ?? []).filter((s) => s.status === "running");
  } catch {
    return [];
  }
}

/**
 * Make sure Videoclaw is reachable before any command: start it if it's closed,
 * and restart it with the port if it was opened without one (after an update or
 * a Dock launch) — but never while a session is mid-turn.
 */
async function ensureApp() {
  if (await isReachable()) return;
  if (isRunning()) {
    const busy = runningSessions();
    if (busy.length) {
      throw new Error(
        `Videoclaw is open without its DevTools port and is busy (${busy.map((s) => s.title).join(", ")}). ` +
          "It will be reconnected automatically once that job finishes; try again then, or run " +
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
    for (let i = 0; i < 120 && isRunning(); i++) await new Promise((r) => setTimeout(r, 250));
    if (isRunning()) throw new Error("Videoclaw didn't quit; close it and try again.");
  }
  // `open` forwards our environment; if we're running inside another Electron
  // app (VS Code, T3…) ELECTRON_RUN_AS_NODE would make Videoclaw start as plain
  // Node and exit immediately.
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  spawn("open", ["-a", APP, "--args", `--remote-debugging-port=${PORT}`, "--remote-debugging-address=127.0.0.1"], {
    detached: true,
    stdio: "ignore",
    env,
  }).unref();
  for (let i = 0; i < 120; i++) {
    if (await isReachable()) {
      // Give the renderer a moment to finish wiring window.videoclaw.
      await new Promise((r) => setTimeout(r, 1500));
      return { status: "launched", port: PORT };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Videoclaw started but the DevTools port never came up.");
}

// ── sessions ───────────────────────────────────────────────────────────────

export function listClients() {
  return withApp(() => window.videoclaw.listClients());
}

export async function listSessions() {
  const sessions = await withApp(() => window.videoclaw.listSessions());
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    title: s.title,
    clientId: s.clientId,
    status: s.status,
    jobId: s.jobId,
    permissionMode: s.permissionMode,
    totalCostUsd: s.totalCostUsd,
    createdAt: s.createdAt && new Date(s.createdAt).toISOString(),
  }));
}

export function createSession({ clientId } = {}) {
  return withApp((req) => window.videoclaw.createSession(req), clientId ? { clientId } : {});
}

/** Raw history events for a session, as the app's chat view receives them. */
export function history(sessionId) {
  return withApp((id) => window.videoclaw.getHistory(id), sessionId);
}

/** History reduced to a readable transcript of user/assistant turns. */
export async function transcript(sessionId) {
  const raw = await history(sessionId);
  const events = Array.isArray(raw) ? raw : (raw?.events ?? []);
  return toTranscript(events);
}

export function toTranscript(events) {
  const out = [];
  for (const e of events) {
    if (e.kind === "user_text") out.push({ role: "user", text: e.text });
    else if (e.kind === "assistant_text") {
      const last = out.at(-1);
      // Streamed chunks of one message share a messageId; keep the latest/longest.
      if (last?.role === "assistant" && e.messageId && last.messageId === e.messageId) {
        last.text = e.text.startsWith(last.text) || e.text.length >= last.text.length ? e.text : last.text + e.text;
      } else out.push({ role: "assistant", text: e.text, messageId: e.messageId });
    } else if (e.kind === "tool_start") out.push({ role: "tool", text: e.toolName ?? "tool" });
    else if (e.kind === "error") out.push({ role: "error", text: e.message ?? e.text ?? JSON.stringify(e) });
  }
  return out;
}

/**
 * Send a message. With `wait`, resolves once the turn finishes (a `result`
 * event) with the assistant's reply, any tools used, and any approval prompts
 * that appeared — approvals must be answered in the Videoclaw window.
 */
export async function send(sessionId, text, { wait = true, timeoutMs = 15 * 60_000 } = {}) {
  const cdp = await Cdp.connect();
  try {
    return await cdp.call(
      async ({ sessionId, text, wait, timeoutMs, clientTurnId }) => {
        const vc = window.videoclaw;
        const events = [];
        const asks = [];
        let done;
        const finished = new Promise((r) => (done = r));
        const offEvent = vc.onSessionEvent((payload) => {
          if (payload?.sessionId !== sessionId) return;
          events.push(payload.event);
          if (payload.event?.kind === "result") done("result");
        });
        const offAsk = vc.onPermissionRequest((req) => {
          if (req?.sessionId === sessionId) asks.push(req);
        });
        try {
          const receipt = await vc.sendMessage(sessionId, { text, attachmentIds: [], clientTurnId });
          if (!wait) return { receipt };
          const timer = new Promise((r) => setTimeout(() => r("timeout"), timeoutMs));
          const outcome = await Promise.race([finished, timer]);
          return { receipt, outcome, events, asks };
        } finally {
          if (typeof offEvent === "function") offEvent();
          if (typeof offAsk === "function") offAsk();
        }
      },
      { sessionId, text, wait, timeoutMs, clientTurnId: randomUUID() },
    );
  } finally {
    cdp.close();
  }
}

export function summarizeTurn(turn) {
  if (!turn.events) return { sent: true, receipt: turn.receipt };
  const transcript = toTranscript(turn.events).filter((m) => m.role !== "user");
  const result = turn.events.findLast((e) => e.kind === "result");
  return {
    outcome: turn.outcome,
    reply: transcript.filter((m) => m.role === "assistant").map((m) => m.text).join("\n\n"),
    tools: transcript.filter((m) => m.role === "tool").map((m) => m.text),
    errors: transcript.filter((m) => m.role === "error").map((m) => m.text),
    approvalsRequested: turn.asks.map((a) => ({ kind: a.kind, requestId: a.requestId, title: a.title ?? a.toolName })),
    costUsd: result?.totalCostUsd,
  };
}

export function interrupt(sessionId) {
  return withApp((id) => window.videoclaw.interrupt(id, "user"), sessionId);
}

export function rename(sessionId, title) {
  return withApp(({ id, title }) => window.videoclaw.renameSession(id, title), { id: sessionId, title });
}

// ── artifacts & taste ──────────────────────────────────────────────────────

/** The job folder behind a session: final renders (newest first) and other outputs. */
export async function getJob(sessionId) {
  const snap = await withApp((id) => window.videoclaw.getJobSnapshot(id), sessionId);
  if (!snap?.jobId) return { jobId: null, note: "This session hasn't started a job yet." };
  const file = (f) => ({ path: f.path, kind: f.kind ?? "video", sizeMb: +(f.sizeBytes / 1e6).toFixed(1), modified: new Date(f.mtimeMs).toISOString() });
  return {
    jobId: snap.jobId,
    jobPath: snap.jobPath,
    renders: (snap.renders ?? []).map(file),
    assets: (snap.assets ?? []).map(file),
  };
}

/** The taste layers the app applies for a client: defaults, your global taste, and the project pack. */
export async function getTaste(clientId) {
  const res = await withApp(async ({ clientId }) => {
    const sessions = await window.videoclaw.listSessions();
    return window.videoclaw.listTaste(clientId, sessions[0]?.cwd);
  }, { clientId });
  return {
    clientId,
    layers: (res?.scopes ?? []).map((s) => ({
      scope: s.scope,
      label: s.label,
      file: s.file,
      applied: Boolean(s.exists && s.cards.length),
      cards: s.cards,
    })),
    pendingProposals: res?.proposals ?? [],
  };
}

// ── long-running turns ─────────────────────────────────────────────────────

/** Approvals/questions the app is waiting on for this session (answered in the Videoclaw window). */
export function pendingApprovals(sessionId) {
  return withApp(async (sessionId) => {
    const vc = window.videoclaw;
    const seen = [];
    const offs = [
      vc.onPermissionRequest((r) => seen.push({ type: "permission", ...r })),
      vc.onInputRequest?.((r) => seen.push({ type: "input", ...r })),
    ];
    await vc.replayPendingInteractions();
    await new Promise((r) => setTimeout(r, 400));
    for (const off of offs) if (typeof off === "function") off();
    const unique = new Map(seen.filter((r) => r.sessionId === sessionId).map((r) => [r.requestId, r]));
    return [...unique.values()].map((r) => ({
      type: r.type,
      kind: r.kind,
      requestId: r.requestId,
      title: r.title ?? r.toolName ?? r.question ?? r.message,
    }));
  }, sessionId);
}

async function sessionStatus(sessionId) {
  const s = (await listSessions()).find((x) => x.sessionId === sessionId);
  if (!s) throw new Error(`No Videoclaw session ${sessionId}.`);
  return s.status;
}

/**
 * Wait (bounded) for the session's current turn to finish, then report where it
 * stands. Safe to call repeatedly: a still-running turn just returns progress.
 */
export async function checkProgress(sessionId, { waitMs = 4 * 60_000, pollMs = 5_000 } = {}) {
  const deadline = Date.now() + waitMs;
  let status = await sessionStatus(sessionId);
  while (status === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(pollMs, deadline - Date.now())));
    status = await sessionStatus(sessionId);
  }
  const msgs = await transcript(sessionId);
  const lastUser = msgs.findLastIndex((m) => m.role === "user");
  const turn = msgs.slice(lastUser + 1);
  const [approvals, job] = await Promise.all([pendingApprovals(sessionId), getJob(sessionId)]);
  return {
    status, // running | idle | error
    done: status !== "running",
    lastRequest: msgs[lastUser]?.text,
    reply: turn.filter((m) => m.role === "assistant").map((m) => m.text).join("\n\n") || null,
    toolsUsedThisTurn: turn.filter((m) => m.role === "tool").length,
    errors: turn.filter((m) => m.role === "error").map((m) => m.text),
    waitingOnUser: approvals,
    renders: job.renders ?? [],
    jobPath: job.jobPath ?? null,
  };
}
