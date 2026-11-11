// Videoclaw operations, on top of the app's own server methods (see connect.mjs).
//
// Words: Videoclaw 0.2 calls a client a "project" and a chat session a
// "video". The MCP keeps the old parameter names (clientId, sessionId) so
// existing prompts and bots keep working.
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { rpc, WORKSPACE, VideoclawError } from "./connect.mjs";

export { PORT, launch, busyVideos } from "./connect.mjs";
export const close = () => rpc.close();

const NEEDS_USER = new Set(["question", "money", "fileRequest", "rights", "voiceover"]);
const usd = (micro) => (micro == null ? null : Math.round(micro / 10_000) / 100);
const jobDir = (jobId) => join(WORKSPACE, "jobs", jobId);
/** Unwrap an Effect Option (`{ _tag: "Some", value }` / `{ _tag: "None" }`). */
const opt = (o) => (o?._tag === "Some" ? o.value : o?._tag === "None" ? null : o ?? null);

/** Local path for a `/media/<job>/<file>` or `/assets/<job>/<path>` URL. */
export function localPath(media) {
  const m = /^\/(media|assets)\/([^/]+)\/(.+)$/.exec(media ?? "");
  if (!m) return null;
  return m[1] === "media" ? join(jobDir(m[2]), "renders", m[3]) : join(jobDir(m[2]), m[3]);
}

// ── projects (clients) and videos (sessions) ───────────────────────────────

export const catalog = () => rpc.first("watchCatalog", null);

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Find a project by id, name or slug ("hover-tag" matches "Hover Tag"). */
export async function resolveProject(ref, cat) {
  cat ??= await catalog();
  const want = String(ref ?? "").trim();
  const p =
    cat.projects.find((x) => x.id === want) ??
    cat.projects.find((x) => x.name.toLowerCase() === want.toLowerCase()) ??
    cat.projects.find((x) => slug(x.name) === slug(want));
  if (!p) {
    throw new VideoclawError(
      `No Videoclaw project matches "${ref}". Projects: ${cat.projects.map((x) => x.name).join(", ")}.`,
      "ProjectNotFound",
    );
  }
  return p;
}

export async function listClients() {
  const cat = await catalog();
  return cat.projects.map((p) => ({
    clientId: p.id,
    name: p.name,
    videos: cat.videos.filter((v) => v.projectId === p.id).length,
  }));
}

const videoRow = (v, projects) => ({
  sessionId: v.id,
  title: v.title,
  client: projects.find((p) => p.id === v.projectId)?.name,
  clientId: v.projectId,
  status: v.mark, // needsYou | working | done | idle
  model: v.model,
  mode: v.mode,
});

export async function listSessions({ clientId } = {}) {
  const cat = await catalog();
  let videos = cat.videos;
  if (clientId) {
    const p = await resolveProject(clientId, cat);
    videos = videos.filter((v) => v.projectId === p.id);
  }
  return videos.map((v) => videoRow(v, cat.projects));
}

export async function createSession({ clientId, title } = {}) {
  const cat = await catalog();
  const project = clientId
    ? await resolveProject(clientId, cat)
    : cat.projects.find((p) => p.name === "Personal") ?? cat.projects[0];
  const video = await rpc.call("createVideo", {
    projectId: project.id,
    title: title?.trim() || "New video",
    videoId: randomUUID(),
  });
  return videoRow(video, cat.projects);
}

export const renameSession = (sessionId, title) => rpc.call("renameVideo", { videoId: sessionId, title });

export async function setAgentSettings(sessionId, changes) {
  const cat = await catalog();
  const v = cat.videos.find((x) => x.id === sessionId);
  if (!v) throw new VideoclawError(`No Videoclaw video has id ${sessionId}.`, "VideoNotFound");
  const next = {
    model: changes.model ?? v.model,
    effort: changes.effort === undefined ? v.effort : changes.effort,
    mode: changes.mode ?? v.mode,
    fast: changes.fast ?? v.fast,
  };
  const updated = await rpc.call("setAgentSettings", { videoId: sessionId, ...next });
  return videoRow(updated, cat.projects);
}

export async function createClient(name) {
  return rpc.call("createProject", { name, projectId: randomUUID() });
}

export async function renameClient(clientId, name) {
  const p = await resolveProject(clientId);
  return rpc.call("renameProject", { projectId: p.id, name });
}

// ── files ──────────────────────────────────────────────────────────────────

/** Upload local files into a video (or into an open file request). Returns where they landed. */
export async function uploadFiles(sessionId, paths, requestId) {
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
        ...(requestId ? { requestId } : {}),
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

// ── chat ───────────────────────────────────────────────────────────────────

/** The footer the app's composer adds to a message with files, so the agent reads them. */
const withFiles = (text, paths) => {
  if (!paths.length) return text;
  const list = ["Files I added to this video:", ...paths.map((p) => `- ${p}`), "Use these files as source material where relevant."].join("\n");
  const body = String(text ?? "").trim();
  return body ? `${body}\n\n${list}` : list;
};

/** Send a message. If a turn is running, it is queued and sent when the turn ends. */
export async function send(sessionId, message, { files } = {}) {
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

export const interrupt = (sessionId) => rpc.call("stop", { videoId: sessionId });

/** Live state of a video: the snapshot with later events applied. */
class VideoState {
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
}

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
    { timeoutMs: Math.max(waitMs, 8_000) },
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
        ...(permission ? { note: "A permission request. The user answers it in the Videoclaw window." } : {}),
        questions: item.questions.map((q) => ({
          id: q.id,
          header: q.header,
          question: q.question,
          multiSelect: q.multiSelect,
          options: q.options.map((o) => (o.description ? `${o.label} (${o.description})` : o.label)),
          ...(q.permission ? { permission: q.permission.detail } : {}),
        })),
      };
    }
    case "money":
      return {
        ...base,
        kind: "spend",
        answerable: false,
        line: item.line,
        maximumUsd: usd(item.maximumMicroUsd),
        note: "A spend approval. The user approves or denies it in the Videoclaw window.",
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
    path: localPath(v.media) ?? join(jobDir(jobId), "renders", basename(v.media)),
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
    jobPath: jobDir(snap.video.jobId),
  };
}

/**
 * Wait up to `waitMs` for the current turn to finish or to need the user,
 * then summarize. Returns early when nothing is running.
 */
export async function checkProgress(sessionId, { waitMs = 4 * 60_000 } = {}) {
  const state = await readVideo(sessionId, {
    waitMs,
    until: (s) => !s.running || s.waiting.length > 0,
  });
  return summarize(state);
}

export async function history(sessionId, { limit = 40, tools = false } = {}) {
  const state = await readVideo(sessionId);
  const keep = (x) =>
    x.kind === "userMessage" || x.kind === "agentMessage" || x.kind === "notice" || (tools && x.kind === "tool");
  return state.snap.items
    .filter(keep)
    .slice(-limit)
    .map((x) => ({
      role: x.kind === "userMessage" ? "user" : x.kind === "agentMessage" ? "assistant" : x.kind,
      text: x.text ?? x.title,
    }));
}

export async function getJob(sessionId, { all = false } = {}) {
  const state = await readVideo(sessionId, { assets: true });
  const assets = (state.assets ?? []).map((a) => ({ kind: a.kind, path: localPath(a.media), modified: a.modified }));
  assets.sort((a, b) => b.modified - a.modified);
  return {
    sessionId,
    title: state.snap.video.title,
    jobPath: jobDir(state.snap.video.jobId),
    versions: versionsOf(state),
    assets: all ? assets : assets.slice(0, 30),
    assetCount: assets.length,
  };
}

// ── questions and requests ─────────────────────────────────────────────────

export async function pending(sessionId) {
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

async function liveItem(sessionId, itemId) {
  const state = await readVideo(sessionId);
  const item = state.snap.live.find((x) => x.id === itemId);
  if (!item) throw new VideoclawError("That request is no longer open. Use videoclaw_get_pending.", "AskNotOpen");
  return item;
}

/**
 * Answer a question card. `answers` maps a question (its id, header or text)
 * to an option label, or a list of labels for multi-select. Other text is
 * sent as a free-form answer.
 */
export async function answerQuestion(sessionId, itemId, answers) {
  const item = await liveItem(sessionId, itemId);
  if (item.kind !== "question") throw new VideoclawError("That request isn't a question.", "WrongKind");
  if (item.questions.some((q) => q.permission)) {
    throw new VideoclawError(
      "That is a permission request. Approve or deny it in the Videoclaw window.",
      "PermissionNotAnswerable",
    );
  }
  const byKey = (k) =>
    item.questions.find((q) => q.id === k) ??
    item.questions.find((q) => q.question === k) ??
    item.questions.find((q) => q.header && q.header === k) ??
    (item.questions.length === 1 ? item.questions[0] : undefined);
  const out = {};
  for (const [key, value] of Object.entries(answers)) {
    const q = byKey(key);
    if (!q) throw new VideoclawError(`No question matches "${key}".`, "UnknownQuestion");
    const list = [value].flat().map(String);
    out[q.id] = q.multiSelect ? list : list.join(", ");
  }
  await rpc.call("answer", { videoId: sessionId, itemId, answers: out });
  return { answered: Object.keys(out).length };
}

/** Answer a file, rights or voiceover request. Spend and permission requests stay in the app. */
export async function respondRequest(sessionId, itemId, { kind, paths, accepted }) {
  const item = await liveItem(sessionId, itemId);
  if (item.kind === "fileRequest") {
    if (kind === "cancel" || kind === "decline") {
      await rpc.call("respond", { videoId: sessionId, itemId, answer: "Decline" });
      return { declined: true };
    }
    if (!paths?.length) throw new VideoclawError("Give the file paths to send.", "NoFiles");
    const landed = await uploadFiles(sessionId, paths, itemId);
    await rpc.call("respond", { videoId: sessionId, itemId, answer: "Send" });
    return { sent: landed };
  }
  if (item.kind === "rights") {
    const yes = kind === "rights" && accepted === true;
    await rpc.call("respond", { videoId: sessionId, itemId, answer: yes ? "Confirm" : "Cancel" });
    return { confirmed: yes };
  }
  if (item.kind === "voiceover") {
    const keep = kind === "voiceover" && accepted !== false;
    await rpc.call("respond", { videoId: sessionId, itemId, answer: keep ? "Send" : "Decline" });
    return { kept: keep };
  }
  throw new VideoclawError(
    item.kind === "money"
      ? "That is a spend approval. The user approves it in the Videoclaw window."
      : `Can't answer a ${item.kind} request here.`,
    "NotAnswerable",
  );
}

// ── versions and sharing ───────────────────────────────────────────────────

export async function approveVersion(sessionId, version) {
  const output = await rpc.call("markFinal", { videoId: sessionId, n: Number(version) });
  return { final: output.final, versions: output.versions.length };
}

export async function shareCreate(sessionId, { version, title } = {}) {
  const state = await readVideo(sessionId);
  const out = state.snap.output;
  const n = Number(version ?? out.final ?? out.versions.at(-1)?.n);
  if (!n) throw new VideoclawError("This video has no versions to share yet.", "VersionNotFound");
  const share = await rpc.call("shareVersion", {
    videoId: sessionId,
    n,
    title: title?.trim() || `${state.snap.video.title} (V${n})`,
  });
  return shareRow(share);
}

const shareRow = (s) => ({
  shareId: s.id,
  sessionId: s.videoId,
  version: s.n,
  title: s.title,
  url: s.url,
  status: s.state, // active | unresolved | expired | stopped
  createdAt: s.createdAt,
  expiresAt: s.expiresAt,
});

export async function shareList(sessionId) {
  const { shares } = await rpc.first("watchShares", null);
  return shares.filter((s) => !sessionId || s.videoId === sessionId).map(shareRow);
}

export async function shareRevoke(shareId) {
  return shareRow(await rpc.call("stopSharing", { shareId }));
}

// ── money ──────────────────────────────────────────────────────────────────

export async function getSpend(sessionId) {
  const account = await rpc.first("watchMeter", null).catch(() => null);
  const out = { account };
  if (sessionId) {
    out.video = await rpc.first("watchSpending", { videoId: sessionId });
    out.videoTotal = await rpc.first("watchVideoTotal", { videoId: sessionId }).catch(() => null);
  }
  return out;
}

// ── taste ──────────────────────────────────────────────────────────────────

const tasteScope = async (clientId) =>
  clientId ? { _tag: "Project", projectId: (await resolveProject(clientId)).id } : { _tag: "You" };

export async function getTaste(clientId) {
  const projectId = clientId ? (await resolveProject(clientId)).id : undefined;
  const t = await rpc.first("watchTaste", projectId ? { projectId } : {});
  const layer = (l) => l && { ...l, proposals: l.proposals.map((x) => ({ ...x, quote: opt(x.quote) })) };
  return { defaults: t.defaults, project: layer(opt(t.project)), you: layer(t.you) };
}

export async function addTasteRule(clientId, text) {
  await rpc.call("saveCommitment", { scope: await tasteScope(clientId), text });
  return { saved: text, scope: clientId ? "project" : "you" };
}

export async function decideTasteProposal(clientId, signal, decision) {
  await rpc.call("decideProposal", { scope: await tasteScope(clientId), signal, decision });
  return { decided: decision };
}

// ── characters ─────────────────────────────────────────────────────────────

export async function listCharacters() {
  const chars = await rpc.first("watchCharacters", null);
  return chars.map((c) => ({
    slug: c.slug,
    name: c.name,
    state: c.state,
    isSelf: c.isSelf,
    photos: c.photos,
    sheet: opt(c.sheet) ? characterSheet(c) : null,
  }));
}

const characterSheet = (c) =>
  join(WORKSPACE, "characters", c.state === "pending" ? join("pending", c.slug) : c.slug, "sheet.png");

async function character(slug) {
  const chars = await rpc.first("watchCharacters", null);
  const c = chars.find((x) => x.slug === slug || x.name.toLowerCase() === String(slug).toLowerCase());
  if (!c) throw new VideoclawError(`No character matches "${slug}".`, "CharacterNotFound");
  return c;
}

export async function approveCharacter(slug) {
  const c = await character(slug);
  const sheet = opt(c.sheet);
  if (!sheet) throw new VideoclawError("That character has no sheet to approve yet.", "NoSheet");
  await rpc.call("approveCharacter", { slug: c.slug, sheet: sheet.sha256 });
  return { approved: c.name };
}

export async function deleteCharacter(slug) {
  const c = await character(slug);
  await rpc.call(c.state === "pending" ? "discardCharacter" : "deleteCharacter", { slug: c.slug });
  return { deleted: c.name };
}
