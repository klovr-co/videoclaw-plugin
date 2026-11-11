#!/usr/bin/env node
import{createRequire as __cr}from'module';const require=__cr(import.meta.url);

// bin/vc.mjs
import { parseArgs } from "node:util";

// src/videoclaw.mjs
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join as join2 } from "node:path";

// src/connect.mjs
import { spawn, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
var PORT = Number(process.env.VIDEOCLAW_CDP_PORT ?? 9339);
var APP = process.env.VIDEOCLAW_APP ?? "/Applications/Videoclaw.app";
var DATA_DIR = join(homedir(), "Library", "Application Support", "videoclaw-app", "data");
var WORKSPACE = join(DATA_DIR, "workspace");
var DB = join(DATA_DIR, "videoclaw.sqlite");
var AUTO_LAUNCH = process.env.VIDEOCLAW_AUTO_LAUNCH !== "0";
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findPage() {
  let targets;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    targets = await res.json();
  } catch {
    throw new Error(
      `Videoclaw isn't reachable on DevTools port ${PORT}. Run \`vc launch --restart\` (it restarts Videoclaw with --remote-debugging-port=${PORT}).`
    );
  }
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  if (!page) throw new Error("Videoclaw is running but its main window isn't open yet.");
  return page;
}
async function evaluate(expression) {
  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("DevTools connection failed.")), { once: true });
    });
    const reply = new Promise(
      (resolve) => ws.addEventListener("message", (m) => {
        const data2 = JSON.parse(m.data);
        if (data2.id === 1) resolve(data2);
      })
    );
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true }
      })
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
      "window.videoclaw && typeof window.videoclaw.server === 'function' ? window.videoclaw.server() : null"
    ).catch(() => null);
    if (address?.port && address?.secret) return address;
    await sleep(500);
  }
  throw new Error(
    "Videoclaw is open, but it doesn't offer the server bridge this plugin uses. This plugin needs Videoclaw 0.2 or newer; update Videoclaw or this plugin."
  );
}
async function isReachable() {
  try {
    await findPage();
    return true;
  } catch {
    return false;
  }
}
function isRunning() {
  try {
    execFileSync("pgrep", ["-f", `${APP}/Contents/MacOS/`]);
    return true;
  } catch {
    return false;
  }
}
function busyVideos() {
  try {
    const out = execFileSync(
      "sqlite3",
      [
        "-readonly",
        DB,
        "select v.title from turns t join videos v on v.id = t.video_id where t.status <> 'ended'"
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
async function ensureApp() {
  if (await isReachable()) return;
  if (isRunning()) {
    const busy = busyVideos();
    if (busy.length) {
      throw new Error(
        `Videoclaw is open without its DevTools port and is busy (${busy.join(", ")}). It reconnects automatically once that job finishes; try again then, or run \`vc launch --restart\` to interrupt it.`
      );
    }
  }
  await launch({ restart: true });
}
async function launch({ restart = false } = {}) {
  if (await isReachable()) return { status: "already-reachable", port: PORT };
  if (isRunning()) {
    if (!restart) {
      throw new Error(
        "Videoclaw is already running without the DevTools port. Re-run with --restart to quit and relaunch it (running turns are interrupted)."
      );
    }
    execFileSync("osascript", ["-e", 'tell application "Videoclaw" to quit']);
    for (let i = 0; i < 120 && isRunning(); i++) await sleep(250);
    if (isRunning()) throw new Error("Videoclaw didn't quit; close it and try again.");
  }
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  spawn("open", ["-a", APP, "--args", `--remote-debugging-port=${PORT}`, "--remote-debugging-address=127.0.0.1"], {
    detached: true,
    stdio: "ignore",
    env
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
var VideoclawError = class extends Error {
  constructor(message, tag, detail) {
    super(message);
    this.tag = tag;
    this.detail = detail;
  }
};
var FRIENDLY = {
  TurnInProgress: "Videoclaw is still working on this video.",
  VideoNotFound: "No Videoclaw video has that id. Use videoclaw_list_sessions.",
  ProjectNotFound: "No Videoclaw project has that id. Use videoclaw_list_clients.",
  VersionNotFound: "This video has no version with that number.",
  QuestionNotOpen: "That question is no longer open.",
  AskNotOpen: "That request is no longer open.",
  NoLiveTurn: "Nothing is running on this video.",
  UpdateRequired: "Videoclaw needs an update before it can do this.",
  ServerStopping: "Videoclaw is shutting down. Try again in a moment.",
  StoreUnavailable: "Videoclaw couldn't read or save its data. Try again."
};
function failure(cause = []) {
  const fail = cause.find((c) => c._tag === "Fail");
  if (fail) {
    const err = fail.error ?? {};
    const tag = err._tag ?? "Error";
    const extra = Object.entries(err).filter(([k]) => k !== "_tag").map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");
    return new VideoclawError(`${FRIENDLY[tag] ?? tag}${extra ? ` (${tag}; ${extra})` : ""}`, tag, err);
  }
  const die = cause.find((c) => c._tag === "Die");
  if (die) return new VideoclawError(`Videoclaw rejected the request: ${String(die.defect)}`, "Defect", die.defect);
  if (cause.some((c) => c._tag === "Interrupt")) return new VideoclawError("Videoclaw interrupted the request.", "Interrupt");
  return new VideoclawError(`Videoclaw failed: ${JSON.stringify(cause)}`, "Unknown", cause);
}
var Rpc = class {
  constructor() {
    this.ws = null;
    this.opening = null;
    this.nextId = 1;
    this.handlers = /* @__PURE__ */ new Map();
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
          once: true
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
      }, 1e4);
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
  async request(tag, payload, onChunk = () => {
  }) {
    const ws = await this.open();
    const id = String(this.nextId++);
    let settle;
    const done = new Promise((resolve, reject) => {
      settle = (err, value) => err ? reject(err) : resolve(value);
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
  async watch(tag, payload, onValue, { timeoutMs = 1e4 } = {}) {
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
  async first(tag, payload, { timeoutMs = 1e4 } = {}) {
    let value;
    let got = false;
    await this.watch(tag, payload, (v) => (value = v, got = true), { timeoutMs });
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
};
var rpc = new Rpc();

// src/videoclaw.mjs
var close = () => rpc.close();
var NEEDS_USER = /* @__PURE__ */ new Set(["question", "money", "fileRequest", "rights", "voiceover"]);
var usd = (micro) => micro == null ? null : Math.round(micro / 1e4) / 100;
var jobDir = (jobId) => join2(WORKSPACE, "jobs", jobId);
var opt = (o) => o?._tag === "Some" ? o.value : o?._tag === "None" ? null : o ?? null;
function localPath(media) {
  const m = /^\/(media|assets)\/([^/]+)\/(.+)$/.exec(media ?? "");
  if (!m) return null;
  return m[1] === "media" ? join2(jobDir(m[2]), "renders", m[3]) : join2(jobDir(m[2]), m[3]);
}
var catalog = () => rpc.first("watchCatalog", null);
var slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
async function resolveProject(ref, cat) {
  cat ??= await catalog();
  const want = String(ref ?? "").trim();
  const p = cat.projects.find((x) => x.id === want) ?? cat.projects.find((x) => x.name.toLowerCase() === want.toLowerCase()) ?? cat.projects.find((x) => slug(x.name) === slug(want));
  if (!p) {
    throw new VideoclawError(
      `No Videoclaw project matches "${ref}". Projects: ${cat.projects.map((x) => x.name).join(", ")}.`,
      "ProjectNotFound"
    );
  }
  return p;
}
async function listClients() {
  const cat = await catalog();
  return cat.projects.map((p) => ({
    clientId: p.id,
    name: p.name,
    videos: cat.videos.filter((v) => v.projectId === p.id).length
  }));
}
var videoRow = (v, projects) => ({
  sessionId: v.id,
  title: v.title,
  client: projects.find((p) => p.id === v.projectId)?.name,
  clientId: v.projectId,
  status: v.mark,
  // needsYou | working | done | idle
  model: v.model,
  mode: v.mode
});
async function listSessions({ clientId } = {}) {
  const cat = await catalog();
  let videos = cat.videos;
  if (clientId) {
    const p = await resolveProject(clientId, cat);
    videos = videos.filter((v) => v.projectId === p.id);
  }
  return videos.map((v) => videoRow(v, cat.projects));
}
async function createSession({ clientId, title } = {}) {
  const cat = await catalog();
  const project = clientId ? await resolveProject(clientId, cat) : cat.projects.find((p) => p.name === "Personal") ?? cat.projects[0];
  const video = await rpc.call("createVideo", {
    projectId: project.id,
    title: title?.trim() || "New video",
    videoId: randomUUID()
  });
  return videoRow(video, cat.projects);
}
var renameSession = (sessionId, title) => rpc.call("renameVideo", { videoId: sessionId, title });
async function uploadFiles(sessionId, paths, requestId) {
  const landed = [];
  for (const path of paths ?? []) {
    if (!isAbsolute(path)) throw new VideoclawError(`Use an absolute path: ${path}`, "BadPath");
    const { size } = await stat(path);
    let ticket;
    try {
      ticket = await rpc.call("intakeTicket", {
        videoId: sessionId,
        name: basename(path),
        size,
        ...requestId ? { requestId } : {}
      });
    } catch (err) {
      if (err.tag === "TakeLanded") {
        landed.push(err.detail.path);
        continue;
      }
      throw err;
    }
    const res = await fetch(ticket.url, { method: "POST", body: await readFile(path) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.refused) {
      throw new VideoclawError(`Videoclaw refused ${basename(path)} (${out.refused ?? res.status}).`, "IntakeRefused");
    }
    landed.push(out.path);
  }
  return landed;
}
var withFiles = (text, paths) => {
  if (!paths.length) return text;
  const list = ["Files I added to this video:", ...paths.map((p) => `- ${p}`), "Use these files as source material where relevant."].join("\n");
  const body = String(text ?? "").trim();
  return body ? `${body}

${list}` : list;
};
async function send(sessionId, message, { files } = {}) {
  const attached = await uploadFiles(sessionId, files);
  const text = withFiles(message, attached);
  const clientTurnId = randomUUID();
  try {
    const receipt = await rpc.call("send", { videoId: sessionId, clientTurnId, text });
    return { sent: true, queued: false, turnId: receipt.turnId, attached };
  } catch (err) {
    if (err.tag !== "TurnInProgress") throw err;
    await rpc.call("queueMessage", { videoId: sessionId, clientTurnId, text, steer: false });
    return { sent: true, queued: true, attached };
  }
}
var interrupt = (sessionId) => rpc.call("stop", { videoId: sessionId });
var VideoState = class {
  constructor() {
    this.snap = null;
    this.assets = null;
  }
  apply(ev) {
    const s = this.snap;
    switch (ev._tag) {
      case "VideoSnapshot":
        this.snap = { ...ev, items: [...ev.items], live: [...ev.live], turns: [...ev.turns] };
        break;
      case "AssetsChanged":
        this.assets = ev.assets;
        break;
      case "ItemCommitted":
        if (!s) break;
        s.live = s.live.filter((x) => x.id !== ev.item.id);
        s.items = s.items.filter((x) => x.id !== ev.item.id).concat(ev.item);
        break;
      case "LiveChanged":
        if (!s) break;
        s.live = s.live.filter((x) => x.id !== ev.live.id).concat(ev.live);
        break;
      case "ItemDelta": {
        if (!s) break;
        let item = s.live.find((x) => x.id === ev.itemId);
        if (!item) {
          item = { id: ev.itemId, kind: "agentMessage", turnId: ev.turnId, text: "" };
          s.live.push(item);
        }
        item.text = (item.text ?? "").slice(0, ev.offset) + ev.text;
        break;
      }
      case "TurnChanged":
        if (!s) break;
        s.turns = s.turns.filter((t) => t.id !== ev.turn.id).concat(ev.turn);
        s.retry = ev.retry;
        break;
      case "OutputChanged":
        if (s) s.output = ev.output;
        break;
      case "QueueChanged":
        if (s) s.queue = ev.queue;
        break;
      case "VideoChanged":
        if (s) s.video = ev.video;
        break;
    }
  }
  get turn() {
    return this.snap?.turns.at(-1);
  }
  get running() {
    const tag = this.turn?.status?._tag;
    return tag === "Starting" || tag === "Running";
  }
  get waiting() {
    return (this.snap?.live ?? []).filter((x) => NEEDS_USER.has(x.kind));
  }
};
async function readVideo(sessionId, { assets = false, waitMs = 0, until } = {}) {
  const state = new VideoState();
  await rpc.watch(
    "watchVideo",
    { videoId: sessionId },
    (ev) => {
      state.apply(ev);
      if (!state.snap) return false;
      if (assets && !state.assets) return false;
      if (until) return until(state);
      return true;
    },
    { timeoutMs: Math.max(waitMs, 8e3) }
  );
  if (!state.snap) throw new VideoclawError("Videoclaw didn't send this video's state in time.", "Timeout");
  return state;
}
function describeWaiting(item) {
  const base = { itemId: item.id };
  switch (item.kind) {
    case "question": {
      const permission = item.questions.some((q) => q.permission);
      return {
        ...base,
        kind: permission ? "permission" : "question",
        answerable: !permission,
        ...permission ? { note: "A permission request. The user answers it in the Videoclaw window." } : {},
        questions: item.questions.map((q) => ({
          id: q.id,
          header: q.header,
          question: q.question,
          multiSelect: q.multiSelect,
          options: q.options.map((o) => o.description ? `${o.label} (${o.description})` : o.label),
          ...q.permission ? { permission: q.permission.detail } : {}
        }))
      };
    }
    case "money":
      return {
        ...base,
        kind: "spend",
        answerable: false,
        line: item.line,
        maximumUsd: usd(item.maximumMicroUsd),
        note: "A spend approval. The user approves or denies it in the Videoclaw window."
      };
    case "fileRequest":
      return { ...base, kind: "files", answerable: true, description: item.description, accept: item.accept };
    case "rights":
      return { ...base, kind: "rights", answerable: true, purpose: item.purpose, subject: item.subject };
    case "voiceover":
      return { ...base, kind: "voiceover", answerable: true, script: item.script, direction: item.direction };
    default:
      return { ...base, kind: item.kind };
  }
}
function versionsOf(state) {
  const jobId = state.snap.video.jobId;
  const final = state.snap.output.final;
  return state.snap.output.versions.map((v) => ({
    version: v.n,
    final: v.n === final,
    path: localPath(v.media) ?? join2(jobDir(jobId), "renders", basename(v.media))
  }));
}
function summarize(state) {
  const { snap } = state;
  const turn = state.turn;
  const inTurn = (x) => turn && x.turnId === turn.id;
  const all = [...snap.items, ...snap.live];
  const messages = all.filter((x) => x.kind === "agentMessage" && inTurn(x)).map((x) => x.text);
  const status = turn?.status;
  const versions = versionsOf(state);
  return {
    sessionId: snap.video.id,
    title: snap.video.title,
    status: state.running ? "running" : status?.outcome === "failed" ? "error" : "idle",
    done: !state.running || state.waiting.length > 0,
    lastRequest: [...snap.items].reverse().find((x) => x.kind === "userMessage")?.text,
    reply: messages.join("\n\n") || null,
    toolsUsedThisTurn: all.filter((x) => x.kind === "tool" && inTurn(x)).map((x) => x.title),
    notices: all.filter((x) => x.kind === "notice" && inTurn(x)).map((x) => x.text),
    errors: status?.error ? [`${status.error.code}: ${status.error.detail}`] : [],
    outcome: status?.outcome ?? null,
    costUsd: usd(turn?.costMicroUsd),
    waitingOnUser: state.waiting.map(describeWaiting),
    queued: snap.queue.map((q) => q.text),
    latestVersion: versions.at(-1) ?? null,
    finalVersion: versions.find((v) => v.final) ?? null,
    jobPath: jobDir(snap.video.jobId)
  };
}
async function checkProgress(sessionId, { waitMs = 4 * 6e4 } = {}) {
  const state = await readVideo(sessionId, {
    waitMs,
    until: (s) => !s.running || s.waiting.length > 0
  });
  return summarize(state);
}
async function history(sessionId, { limit = 40, tools = false } = {}) {
  const state = await readVideo(sessionId);
  const keep = (x) => x.kind === "userMessage" || x.kind === "agentMessage" || x.kind === "notice" || tools && x.kind === "tool";
  return state.snap.items.filter(keep).slice(-limit).map((x) => ({
    role: x.kind === "userMessage" ? "user" : x.kind === "agentMessage" ? "assistant" : x.kind,
    text: x.text ?? x.title
  }));
}
async function getJob(sessionId, { all = false } = {}) {
  const state = await readVideo(sessionId, { assets: true });
  const assets = (state.assets ?? []).map((a) => ({ kind: a.kind, path: localPath(a.media), modified: a.modified }));
  assets.sort((a, b) => b.modified - a.modified);
  return {
    sessionId,
    title: state.snap.video.title,
    jobPath: jobDir(state.snap.video.jobId),
    versions: versionsOf(state),
    assets: all ? assets : assets.slice(0, 30),
    assetCount: assets.length
  };
}
async function pending(sessionId) {
  if (sessionId) {
    const state = await readVideo(sessionId);
    return state.waiting.map(describeWaiting);
  }
  const cat = await catalog();
  const out = [];
  for (const v of cat.videos.filter((x) => x.mark === "needsYou")) {
    const state = await readVideo(v.id);
    out.push({ sessionId: v.id, title: v.title, waiting: state.waiting.map(describeWaiting) });
  }
  return out;
}
async function approveVersion(sessionId, version) {
  const output = await rpc.call("markFinal", { videoId: sessionId, n: Number(version) });
  return { final: output.final, versions: output.versions.length };
}
async function shareCreate(sessionId, { version, title } = {}) {
  const state = await readVideo(sessionId);
  const out = state.snap.output;
  const n = Number(version ?? out.final ?? out.versions.at(-1)?.n);
  if (!n) throw new VideoclawError("This video has no versions to share yet.", "VersionNotFound");
  const share = await rpc.call("shareVersion", {
    videoId: sessionId,
    n,
    title: title?.trim() || `${state.snap.video.title} (V${n})`
  });
  return shareRow(share);
}
var shareRow = (s) => ({
  shareId: s.id,
  sessionId: s.videoId,
  version: s.n,
  title: s.title,
  url: s.url,
  status: s.state,
  // active | unresolved | expired | stopped
  createdAt: s.createdAt,
  expiresAt: s.expiresAt
});
async function shareList(sessionId) {
  const { shares } = await rpc.first("watchShares", null);
  return shares.filter((s) => !sessionId || s.videoId === sessionId).map(shareRow);
}
async function shareRevoke(shareId) {
  return shareRow(await rpc.call("stopSharing", { shareId }));
}
async function getSpend(sessionId) {
  const account = await rpc.first("watchMeter", null).catch(() => null);
  const out = { account };
  if (sessionId) {
    out.video = await rpc.first("watchSpending", { videoId: sessionId });
    out.videoTotal = await rpc.first("watchVideoTotal", { videoId: sessionId }).catch(() => null);
  }
  return out;
}
async function getTaste(clientId) {
  const projectId = clientId ? (await resolveProject(clientId)).id : void 0;
  const t = await rpc.first("watchTaste", projectId ? { projectId } : {});
  const layer = (l) => l && { ...l, proposals: l.proposals.map((x) => ({ ...x, quote: opt(x.quote) })) };
  return { defaults: t.defaults, project: layer(opt(t.project)), you: layer(t.you) };
}
async function listCharacters() {
  const chars = await rpc.first("watchCharacters", null);
  return chars.map((c) => ({
    slug: c.slug,
    name: c.name,
    state: c.state,
    isSelf: c.isSelf,
    photos: c.photos,
    sheet: opt(c.sheet) ? characterSheet(c) : null
  }));
}
var characterSheet = (c) => join2(WORKSPACE, "characters", c.state === "pending" ? join2("pending", c.slug) : c.slug, "sheet.png");

// bin/vc.mjs
var HELP = `vc \u2014 drive Videoclaw from the terminal

  vc launch [--restart]              start Videoclaw with the DevTools port open
  vc clients                         list projects
  vc sessions [--client <project>]   list videos
  vc new [--client <project>] [--title <t>] [message] [--file <path>]...
                                     create a video (and optionally send the brief)
  vc send <sessionId> <message> [--file <path>]...
  vc status <sessionId> [--wait <minutes>]   is the turn done? reply, what it waits on, versions
  vc history <sessionId> [--limit <n>] [--tools]
  vc job <sessionId> [--all]         versions and outputs as local paths
  vc pending [sessionId]             questions and requests waiting on you
  vc approve <sessionId> <version>   mark a version as final
  vc share <sessionId> [version]     upload a version, print its link
  vc shares [sessionId]              list share links
  vc unshare <shareId>               stop a share link
  vc spend [sessionId]               credit, and a video's budget and spend
  vc taste [project]                 taste rules that apply
  vc characters                      saved characters
  vc interrupt <sessionId>
  vc rename <sessionId> <title>

Project: its id or its name ("Hover"). Add --json for machine-readable output.
Spend and permission approvals stay in the Videoclaw window.
Port: VIDEOCLAW_CDP_PORT (default ${PORT}).`;
var { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    restart: { type: "boolean" },
    client: { type: "string" },
    title: { type: "string" },
    file: { type: "string", multiple: true },
    wait: { type: "string" },
    limit: { type: "string" },
    tools: { type: "boolean" },
    all: { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" }
  }
});
var [cmd, ...args] = positionals;
var print = (value, human) => {
  if (opts.json || !human) console.log(JSON.stringify(value, null, 2));
  else human(value);
};
var need = (value, usage) => {
  if (!value) {
    console.error(`usage: ${usage}`);
    process.exit(2);
  }
  return value;
};
var table = (rows, cols) => {
  for (const r of rows) console.log(cols.map((c) => String(r[c] ?? "")).join("  "));
};
var commands = {
  launch: async () => print(await launch({ restart: opts.restart })),
  clients: async () => print(await listClients(), (rows) => table(rows, ["clientId", "name", "videos"])),
  sessions: async () => print(
    await listSessions({ clientId: opts.client }),
    (rows) => table(rows, ["sessionId", "status", "client", "title"])
  ),
  new: async () => {
    const session = await createSession({ clientId: opts.client, title: opts.title });
    const message = args.join(" ");
    const sent = message ? await send(session.sessionId, message, { files: opts.file }) : null;
    print({ session, ...sent }, () => {
      console.log(session.sessionId);
      if (sent) console.log(`sent${sent.attached.length ? ` with ${sent.attached.length} file(s)` : ""}. check with: vc status ${session.sessionId} --wait 3`);
    });
  },
  send: async () => {
    const id = need(args[0], "vc send <sessionId> <message>");
    const message = need(args.slice(1).join(" "), "vc send <sessionId> <message>");
    const sent = await send(id, message, { files: opts.file });
    print(sent, (s) => console.log(s.queued ? "queued (Videoclaw is still working)." : "sent."));
  },
  status: async () => {
    const id = need(args[0], "vc status <sessionId> [--wait <minutes>]");
    const p = await checkProgress(id, { waitMs: Number(opts.wait ?? 0) * 6e4 });
    print(p, (p2) => {
      console.log(`${p2.title}: ${p2.status}${p2.done ? "" : " (still working)"}`);
      for (const t of p2.toolsUsedThisTurn) console.log(`  \xB7 ${t}`);
      if (p2.reply) console.log(`
${p2.reply}
`);
      for (const e of p2.errors) console.log(`error: ${e}`);
      for (const w of p2.waitingOnUser) console.log(`\u26A0 waiting on ${w.kind}${w.answerable ? "" : " (answer in the Videoclaw window)"}`);
      if (p2.latestVersion) console.log(`latest: V${p2.latestVersion.version} ${p2.latestVersion.path}`);
      if (p2.finalVersion) console.log(`final:  V${p2.finalVersion.version}`);
    });
  },
  history: async () => {
    const id = need(args[0], "vc history <sessionId>");
    const h = await history(id, { limit: Number(opts.limit ?? 20), tools: opts.tools });
    print(h, (rows) => rows.forEach((r) => console.log(`[${r.role}] ${r.text}
`)));
  },
  job: async () => {
    const id = need(args[0], "vc job <sessionId>");
    const j = await getJob(id, { all: opts.all });
    print(j, (j2) => {
      console.log(j2.jobPath);
      for (const v of j2.versions) console.log(`V${v.version}${v.final ? " (final)" : ""}  ${v.path}`);
      if (opts.all) for (const a of j2.assets) console.log(`${a.kind.padEnd(5)}  ${a.path}`);
    });
  },
  pending: async () => print(await pending(args[0])),
  approve: async () => {
    const id = need(args[0], "vc approve <sessionId> <version>");
    print(await approveVersion(id, need(args[1], "vc approve <sessionId> <version>")));
  },
  share: async () => {
    const id = need(args[0], "vc share <sessionId> [version]");
    const s = await shareCreate(id, { version: args[1] });
    print(s, (s2) => console.log(s2.url ?? `share ${s2.shareId} is ${s2.status}`));
  },
  shares: async () => print(await shareList(args[0]), (rows) => table(rows, ["shareId", "status", "version", "title", "url"])),
  unshare: async () => print(await shareRevoke(need(args[0], "vc unshare <shareId>"))),
  spend: async () => print(await getSpend(args[0])),
  taste: async () => print(await getTaste(args[0])),
  characters: async () => print(await listCharacters(), (rows) => table(rows, ["slug", "state", "name"])),
  interrupt: async () => {
    await interrupt(need(args[0], "vc interrupt <sessionId>"));
    console.log("interrupted.");
  },
  rename: async () => {
    const id = need(args[0], "vc rename <sessionId> <title>");
    print(await renameSession(id, need(args.slice(1).join(" "), "vc rename <sessionId> <title>")));
  }
};
if (opts.help || !cmd || !commands[cmd]) {
  console.log(HELP);
  process.exit(cmd && !opts.help ? 2 : 0);
}
try {
  await commands[cmd]();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
} finally {
  close();
}
