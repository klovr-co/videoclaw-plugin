#!/usr/bin/env node
import { parseArgs } from "node:util";
import * as vc from "../src/videoclaw.mjs";

const HELP = `vc — drive Videoclaw chat sessions from the terminal

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
Port: VIDEOCLAW_CDP_PORT (default ${vc.PORT}).`;

const { values: opts, positionals } = parseArgs({
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
    help: { type: "boolean", short: "h" },
  },
});
const [cmd, ...args] = positionals;

const print = (value, human) => {
  if (opts.json || !human) console.log(JSON.stringify(value, null, 2));
  else human(value);
};

const printTurn = (turn) =>
  print(turn, (t) => {
    if (t.sent) return console.log("sent.");
    for (const tool of t.tools) console.log(`  · ${tool}`);
    if (t.reply) console.log(`\n${t.reply}\n`);
    for (const err of t.errors) console.log(`error: ${err}`);
    for (const a of t.approvalsRequested) console.log(`⚠ waiting on ${a.kind} approval in the Videoclaw window`);
    if (t.outcome === "timeout") console.log("(still running — check back with `vc history`)");
  });

async function sendAndPrint(sessionId, text) {
  const turn = await vc.send(sessionId, text, {
    wait: !opts["no-wait"],
    timeoutMs: opts.timeout ? Number(opts.timeout) * 60_000 : undefined,
  });
  printTurn(vc.summarizeTurn(turn));
}

const need = (n, usage) => {
  if (args.length < n) throw new Error(`usage: ${usage}`);
};

try {
  switch (cmd) {
    case "launch":
      print(await vc.launch({ restart: opts.restart }), (r) =>
        console.log(`Videoclaw ${r.status} on 127.0.0.1:${r.port}`),
      );
      break;
    case "clients":
      print(await vc.listClients(), (cs) => cs.forEach((c) => console.log(`${c.clientId}\t${c.name}`)));
      break;
    case "sessions":
      print(await vc.listSessions(), (ss) =>
        ss.forEach((s) => console.log(`${s.sessionId}  ${(s.status ?? "").padEnd(8)} ${s.clientId ?? ""}\t${s.title ?? "(untitled)"}`)),
      );
      break;
    case "new": {
      const session = await vc.createSession({ clientId: opts.client });
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
      if (opts.raw) print(await vc.history(args[0]));
      else
        print(await vc.transcript(args[0]), (msgs) =>
          msgs.forEach((m) => console.log(m.role === "tool" ? `  · ${m.text}` : `\n[${m.role}]\n${m.text}`)),
        );
      break;
    case "status":
      need(1, "vc status <sessionId>");
      print(await vc.checkProgress(args[0], { waitMs: Number(opts.wait ?? 0) * 60_000 }), (p) => {
        console.log(`${p.status}${p.done ? "" : " (still working)"} · ${p.toolsUsedThisTurn} steps this turn`);
        if (p.reply) console.log(`\n${p.reply}\n`);
        for (const a of p.waitingOnUser) console.log(`⚠ waiting on ${a.kind ?? a.type}: ${a.title ?? a.requestId}`);
        for (const r of p.renders) console.log(`render: ${r.path}`);
      });
      break;
    case "job":
      need(1, "vc job <sessionId>");
      print(await vc.getJob(args[0]), (j) => {
        if (!j.jobId) return console.log(j.note);
        console.log(`${j.jobId}\n${j.jobPath}\n\nrenders:`);
        j.renders.forEach((f) => console.log(`  ${f.path}  (${f.sizeMb} MB, ${f.modified})`));
        if (!j.renders.length) console.log("  (none yet)");
        if (opts.all) {
          console.log("\noutputs:");
          j.assets.forEach((f) => console.log(`  [${f.kind}] ${f.path}`));
        } else if (j.assets.length) console.log(`\n${j.assets.length} other outputs (--all to list)`);
      });
      break;
    case "taste":
      need(1, "vc taste <clientId>");
      print(await vc.getTaste(args[0]), (t) => {
        for (const l of t.layers) console.log(`${l.applied ? "✓" : "✗"} ${l.label.padEnd(13)} ${l.file}${l.applied ? `  (${l.cards.length} sections)` : "  (not found)"}`);
        if (t.pendingProposals.length) console.log(`\n${t.pendingProposals.length} taste proposals waiting for review in the app`);
      });
      break;
    case "interrupt":
      need(1, "vc interrupt <sessionId>");
      await vc.interrupt(args[0]);
      console.log("interrupted.");
      break;
    case "rename":
      need(2, "vc rename <sessionId> <title>");
      await vc.rename(args[0], args.slice(1).join(" "));
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
