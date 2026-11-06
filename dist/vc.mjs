#!/usr/bin/env node
import{createRequire as __cr}from'module';const require=__cr(import.meta.url);

// bin/vc.mjs
import { parseArgs } from "node:util";

// src/videoclaw.mjs
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var PORT = Number(process.env.VIDEOCLAW_CDP_PORT ?? 9339);
var APP = process.env.VIDEOCLAW_APP ?? "/Applications/Videoclaw.app";
var USER_DATA = join(homedir(), "Library", "Application Support", "Videoclaw");
var AUTO_LAUNCH = process.env.VIDEOCLAW_AUTO_LAUNCH !== "0";
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
var Cdp = class _Cdp {
  static async connect() {
    if (AUTO_LAUNCH) await ensureApp();
    const page = await findPage();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("DevTools connection failed.")), { once: true });
    });
    return new _Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = /* @__PURE__ */ new Map();
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
      returnByValue: true
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }
  close() {
    this.ws.close();
  }
};
async function withApp(fn, arg) {
  const cdp = await Cdp.connect();
  try {
    return await cdp.call(fn, arg);
  } finally {
    cdp.close();
  }
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
function runningSessions() {
  try {
    const registry = JSON.parse(readFileSync(join(USER_DATA, "sessions.json"), "utf8"));
    return (registry.sessions ?? []).filter((s) => s.status === "running");
  } catch {
    return [];
  }
}
async function ensureApp() {
  if (await isReachable()) return;
  if (isRunning()) {
    const busy = runningSessions();
    if (busy.length) {
      throw new Error(
        `Videoclaw is open without its DevTools port and is busy (${busy.map((s) => s.title).join(", ")}). It will be reconnected automatically once that job finishes; try again then, or run \`vc launch --restart\` to interrupt it.`
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
    for (let i = 0; i < 120 && isRunning(); i++) await new Promise((r) => setTimeout(r, 250));
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
      await new Promise((r) => setTimeout(r, 1500));
      return { status: "launched", port: PORT };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Videoclaw started but the DevTools port never came up.");
}
function listClients() {
  return withApp(() => window.videoclaw.listClients());
}
async function listSessions() {
  const sessions = await withApp(() => window.videoclaw.listSessions());
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    title: s.title,
    clientId: s.clientId,
    status: s.status,
    jobId: s.jobId,
    permissionMode: s.permissionMode,
    totalCostUsd: s.totalCostUsd,
    createdAt: s.createdAt && new Date(s.createdAt).toISOString()
  }));
}
function createSession({ clientId } = {}) {
  return withApp((req) => window.videoclaw.createSession(req), clientId ? { clientId } : {});
}
function history(sessionId) {
  return withApp((id) => window.videoclaw.getHistory(id), sessionId);
}
async function transcript(sessionId) {
  const raw = await history(sessionId);
  const events = Array.isArray(raw) ? raw : raw?.events ?? [];
  return toTranscript(events);
}
function toTranscript(events) {
  const out = [];
  for (const e of events) {
    if (e.kind === "user_text") out.push({ role: "user", text: e.text });
    else if (e.kind === "assistant_text") {
      const last = out.at(-1);
      if (last?.role === "assistant" && e.messageId && last.messageId === e.messageId) {
        last.text = e.text.startsWith(last.text) || e.text.length >= last.text.length ? e.text : last.text + e.text;
      } else out.push({ role: "assistant", text: e.text, messageId: e.messageId });
    } else if (e.kind === "tool_start") out.push({ role: "tool", text: e.toolName ?? "tool" });
    else if (e.kind === "error") out.push({ role: "error", text: e.message ?? e.text ?? JSON.stringify(e) });
  }
  return out;
}
async function send(sessionId, text, { wait = true, timeoutMs = 15 * 6e4 } = {}) {
  const cdp = await Cdp.connect();
  try {
    return await cdp.call(
      async ({ sessionId: sessionId2, text: text2, wait: wait2, timeoutMs: timeoutMs2, clientTurnId }) => {
        const vc = window.videoclaw;
        const events = [];
        const asks = [];
        let done;
        const finished = new Promise((r) => done = r);
        const offEvent = vc.onSessionEvent((payload) => {
          if (payload?.sessionId !== sessionId2) return;
          events.push(payload.event);
          if (payload.event?.kind === "result") done("result");
        });
        const offAsk = vc.onPermissionRequest((req) => {
          if (req?.sessionId === sessionId2) asks.push(req);
        });
        try {
          const receipt = await vc.sendMessage(sessionId2, { text: text2, attachmentIds: [], clientTurnId });
          if (!wait2) return { receipt };
          const timer = new Promise((r) => setTimeout(() => r("timeout"), timeoutMs2));
          const outcome = await Promise.race([finished, timer]);
          return { receipt, outcome, events, asks };
        } finally {
          if (typeof offEvent === "function") offEvent();
          if (typeof offAsk === "function") offAsk();
        }
      },
      { sessionId, text, wait, timeoutMs, clientTurnId: randomUUID() }
    );
  } finally {
    cdp.close();
  }
}
function summarizeTurn(turn) {
  if (!turn.events) return { sent: true, receipt: turn.receipt };
  const transcript2 = toTranscript(turn.events).filter((m) => m.role !== "user");
  const result = turn.events.findLast((e) => e.kind === "result");
  return {
    outcome: turn.outcome,
    reply: transcript2.filter((m) => m.role === "assistant").map((m) => m.text).join("\n\n"),
    tools: transcript2.filter((m) => m.role === "tool").map((m) => m.text),
    errors: transcript2.filter((m) => m.role === "error").map((m) => m.text),
    approvalsRequested: turn.asks.map((a) => ({ kind: a.kind, requestId: a.requestId, title: a.title ?? a.toolName })),
    costUsd: result?.totalCostUsd
  };
}
function interrupt(sessionId) {
  return withApp((id) => window.videoclaw.interrupt(id, "user"), sessionId);
}
function rename(sessionId, title) {
  return withApp(({ id, title: title2 }) => window.videoclaw.renameSession(id, title2), { id: sessionId, title });
}
async function getJob(sessionId) {
  const snap = await withApp((id) => window.videoclaw.getJobSnapshot(id), sessionId);
  if (!snap?.jobId) return { jobId: null, note: "This session hasn't started a job yet." };
  const file = (f) => ({ path: f.path, kind: f.kind ?? "video", sizeMb: +(f.sizeBytes / 1e6).toFixed(1), modified: new Date(f.mtimeMs).toISOString() });
  return {
    jobId: snap.jobId,
    jobPath: snap.jobPath,
    renders: (snap.renders ?? []).map(file),
    assets: (snap.assets ?? []).map(file)
  };
}
async function getTaste(clientId) {
  const res = await withApp(async ({ clientId: clientId2 }) => {
    const sessions = await window.videoclaw.listSessions();
    return window.videoclaw.listTaste(clientId2, sessions[0]?.cwd);
  }, { clientId });
  return {
    clientId,
    layers: (res?.scopes ?? []).map((s) => ({
      scope: s.scope,
      label: s.label,
      file: s.file,
      applied: Boolean(s.exists && s.cards.length),
      cards: s.cards
    })),
    pendingProposals: res?.proposals ?? []
  };
}
function pendingApprovals(sessionId) {
  return withApp(async (sessionId2) => {
    const vc = window.videoclaw;
    const seen = [];
    const offs = [
      vc.onPermissionRequest((r) => seen.push({ type: "permission", ...r })),
      vc.onInputRequest?.((r) => seen.push({ type: "input", ...r }))
    ];
    await vc.replayPendingInteractions();
    await new Promise((r) => setTimeout(r, 400));
    for (const off of offs) if (typeof off === "function") off();
    const unique = new Map(seen.filter((r) => r.sessionId === sessionId2).map((r) => [r.requestId, r]));
    return [...unique.values()].map((r) => ({
      type: r.type,
      kind: r.kind,
      requestId: r.requestId,
      title: r.title ?? r.toolName ?? r.question ?? r.message
    }));
  }, sessionId);
}
async function sessionStatus(sessionId) {
  const s = (await listSessions()).find((x) => x.sessionId === sessionId);
  if (!s) throw new Error(`No Videoclaw session ${sessionId}.`);
  return s.status;
}
async function checkProgress(sessionId, { waitMs = 4 * 6e4, pollMs = 5e3 } = {}) {
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
    status,
    // running | idle | error
    done: status !== "running",
    lastRequest: msgs[lastUser]?.text,
    reply: turn.filter((m) => m.role === "assistant").map((m) => m.text).join("\n\n") || null,
    toolsUsedThisTurn: turn.filter((m) => m.role === "tool").length,
    errors: turn.filter((m) => m.role === "error").map((m) => m.text),
    waitingOnUser: approvals,
    renders: job.renders ?? [],
    jobPath: job.jobPath ?? null
  };
}

// bin/vc.mjs
var HELP = `vc \u2014 drive Videoclaw chat sessions from the terminal

  vc launch [--restart]          start Videoclaw with the DevTools port open
  vc clients                     list clients/projects
  vc sessions                    list sessions
  vc new [--client <id>] [message]   create a session (and optionally send a first message)
  vc send <sessionId> <message> [--no-wait] [--timeout <minutes>]
  vc status <sessionId> [--wait <minutes>]   is the turn done? latest reply, approvals, renders
  vc history <sessionId> [--raw]
  vc job <sessionId> [--all]     the session's job folder: final renders (+ every output with --all)
  vc taste <clientId>            which taste layers the app applies for that project
  vc interrupt <sessionId>
  vc rename <sessionId> <title>

Add --json to any command for machine-readable output.
Spend/permission approvals still appear in the Videoclaw window.
Port: VIDEOCLAW_CDP_PORT (default ${PORT}).`;
var { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    restart: { type: "boolean" },
    client: { type: "string" },
    "no-wait": { type: "boolean" },
    timeout: { type: "string" },
    wait: { type: "string" },
    raw: { type: "boolean" },
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
var printTurn = (turn) => print(turn, (t) => {
  if (t.sent) return console.log("sent.");
  for (const tool of t.tools) console.log(`  \xB7 ${tool}`);
  if (t.reply) console.log(`
${t.reply}
`);
  for (const err of t.errors) console.log(`error: ${err}`);
  for (const a of t.approvalsRequested) console.log(`\u26A0 waiting on ${a.kind} approval in the Videoclaw window`);
  if (t.outcome === "timeout") console.log("(still running \u2014 check back with `vc history`)");
});
async function sendAndPrint(sessionId, text) {
  const turn = await send(sessionId, text, {
    wait: !opts["no-wait"],
    timeoutMs: opts.timeout ? Number(opts.timeout) * 6e4 : void 0
  });
  printTurn(summarizeTurn(turn));
}
var need = (n, usage) => {
  if (args.length < n) throw new Error(`usage: ${usage}`);
};
try {
  switch (cmd) {
    case "launch":
      print(
        await launch({ restart: opts.restart }),
        (r) => console.log(`Videoclaw ${r.status} on 127.0.0.1:${r.port}`)
      );
      break;
    case "clients":
      print(await listClients(), (cs) => cs.forEach((c) => console.log(`${c.clientId}	${c.name}`)));
      break;
    case "sessions":
      print(
        await listSessions(),
        (ss) => ss.forEach((s) => console.log(`${s.sessionId}  ${(s.status ?? "").padEnd(8)} ${s.clientId ?? ""}	${s.title ?? "(untitled)"}`))
      );
      break;
    case "new": {
      const session = await createSession({ clientId: opts.client });
      print(session, (s) => console.log(`created ${s.sessionId}`));
      if (args.length) await sendAndPrint(session.sessionId, args.join(" "));
      break;
    }
    case "send":
      need(2, "vc send <sessionId> <message>");
      await sendAndPrint(args[0], args.slice(1).join(" "));
      break;
    case "history":
      need(1, "vc history <sessionId>");
      if (opts.raw) print(await history(args[0]));
      else
        print(
          await transcript(args[0]),
          (msgs) => msgs.forEach((m) => console.log(m.role === "tool" ? `  \xB7 ${m.text}` : `
[${m.role}]
${m.text}`))
        );
      break;
    case "status":
      need(1, "vc status <sessionId>");
      print(await checkProgress(args[0], { waitMs: Number(opts.wait ?? 0) * 6e4 }), (p) => {
        console.log(`${p.status}${p.done ? "" : " (still working)"} \xB7 ${p.toolsUsedThisTurn} steps this turn`);
        if (p.reply) console.log(`
${p.reply}
`);
        for (const a of p.waitingOnUser) console.log(`\u26A0 waiting on ${a.kind ?? a.type}: ${a.title ?? a.requestId}`);
        for (const r of p.renders) console.log(`render: ${r.path}`);
      });
      break;
    case "job":
      need(1, "vc job <sessionId>");
      print(await getJob(args[0]), (j) => {
        if (!j.jobId) return console.log(j.note);
        console.log(`${j.jobId}
${j.jobPath}

renders:`);
        j.renders.forEach((f) => console.log(`  ${f.path}  (${f.sizeMb} MB, ${f.modified})`));
        if (!j.renders.length) console.log("  (none yet)");
        if (opts.all) {
          console.log("\noutputs:");
          j.assets.forEach((f) => console.log(`  [${f.kind}] ${f.path}`));
        } else if (j.assets.length) console.log(`
${j.assets.length} other outputs (--all to list)`);
      });
      break;
    case "taste":
      need(1, "vc taste <clientId>");
      print(await getTaste(args[0]), (t) => {
        for (const l of t.layers) console.log(`${l.applied ? "\u2713" : "\u2717"} ${l.label.padEnd(13)} ${l.file}${l.applied ? `  (${l.cards.length} sections)` : "  (not found)"}`);
        if (t.pendingProposals.length) console.log(`
${t.pendingProposals.length} taste proposals waiting for review in the app`);
      });
      break;
    case "interrupt":
      need(1, "vc interrupt <sessionId>");
      await interrupt(args[0]);
      console.log("interrupted.");
      break;
    case "rename":
      need(2, "vc rename <sessionId> <title>");
      await rename(args[0], args.slice(1).join(" "));
      console.log("renamed.");
      break;
    default:
      console.log(HELP);
      process.exit(cmd && !opts.help ? 1 : 0);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
