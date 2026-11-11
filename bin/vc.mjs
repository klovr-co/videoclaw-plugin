#!/usr/bin/env node
import { parseArgs } from "node:util";
import * as vc from "../src/videoclaw.mjs";

const HELP = `vc — drive Videoclaw from the terminal

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
Port: VIDEOCLAW_CDP_PORT (default ${vc.PORT}).`;

const { values: opts, positionals } = parseArgs({
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
    help: { type: "boolean", short: "h" },
  },
});
const [cmd, ...args] = positionals;

const print = (value, human) => {
  if (opts.json || !human) console.log(JSON.stringify(value, null, 2));
  else human(value);
};

const need = (value, usage) => {
  if (!value) {
    console.error(`usage: ${usage}`);
    process.exit(2);
  }
  return value;
};

const table = (rows, cols) => {
  for (const r of rows) console.log(cols.map((c) => String(r[c] ?? "")).join("  "));
};

const commands = {
  launch: async () => print(await vc.launch({ restart: opts.restart })),

  clients: async () => print(await vc.listClients(), (rows) => table(rows, ["clientId", "name", "videos"])),

  sessions: async () =>
    print(await vc.listSessions({ clientId: opts.client }), (rows) =>
      table(rows, ["sessionId", "status", "client", "title"]),
    ),

  new: async () => {
    const session = await vc.createSession({ clientId: opts.client, title: opts.title });
    const message = args.join(" ");
    const sent = message ? await vc.send(session.sessionId, message, { files: opts.file }) : null;
    print({ session, ...sent }, () => {
      console.log(session.sessionId);
      if (sent) console.log(`sent${sent.attached.length ? ` with ${sent.attached.length} file(s)` : ""}. check with: vc status ${session.sessionId} --wait 3`);
    });
  },

  send: async () => {
    const id = need(args[0], "vc send <sessionId> <message>");
    const message = need(args.slice(1).join(" "), "vc send <sessionId> <message>");
    const sent = await vc.send(id, message, { files: opts.file });
    print(sent, (s) => console.log(s.queued ? "queued (Videoclaw is still working)." : "sent."));
  },

  status: async () => {
    const id = need(args[0], "vc status <sessionId> [--wait <minutes>]");
    const p = await vc.checkProgress(id, { waitMs: Number(opts.wait ?? 0) * 60_000 });
    print(p, (p) => {
      console.log(`${p.title}: ${p.status}${p.done ? "" : " (still working)"}`);
      for (const t of p.toolsUsedThisTurn) console.log(`  · ${t}`);
      if (p.reply) console.log(`\n${p.reply}\n`);
      for (const e of p.errors) console.log(`error: ${e}`);
      for (const w of p.waitingOnUser) console.log(`⚠ waiting on ${w.kind}${w.answerable ? "" : " (answer in the Videoclaw window)"}`);
      if (p.latestVersion) console.log(`latest: V${p.latestVersion.version} ${p.latestVersion.path}`);
      if (p.finalVersion) console.log(`final:  V${p.finalVersion.version}`);
    });
  },

  history: async () => {
    const id = need(args[0], "vc history <sessionId>");
    const h = await vc.history(id, { limit: Number(opts.limit ?? 20), tools: opts.tools });
    print(h, (rows) => rows.forEach((r) => console.log(`[${r.role}] ${r.text}\n`)));
  },

  job: async () => {
    const id = need(args[0], "vc job <sessionId>");
    const j = await vc.getJob(id, { all: opts.all });
    print(j, (j) => {
      console.log(j.jobPath);
      for (const v of j.versions) console.log(`V${v.version}${v.final ? " (final)" : ""}  ${v.path}`);
      if (opts.all) for (const a of j.assets) console.log(`${a.kind.padEnd(5)}  ${a.path}`);
    });
  },

  pending: async () => print(await vc.pending(args[0])),

  approve: async () => {
    const id = need(args[0], "vc approve <sessionId> <version>");
    print(await vc.approveVersion(id, need(args[1], "vc approve <sessionId> <version>")));
  },

  share: async () => {
    const id = need(args[0], "vc share <sessionId> [version]");
    const s = await vc.shareCreate(id, { version: args[1] });
    print(s, (s) => console.log(s.url ?? `share ${s.shareId} is ${s.status}`));
  },

  shares: async () =>
    print(await vc.shareList(args[0]), (rows) => table(rows, ["shareId", "status", "version", "title", "url"])),

  unshare: async () => print(await vc.shareRevoke(need(args[0], "vc unshare <shareId>"))),

  spend: async () => print(await vc.getSpend(args[0])),

  taste: async () => print(await vc.getTaste(args[0])),

  characters: async () => print(await vc.listCharacters(), (rows) => table(rows, ["slug", "state", "name"])),

  interrupt: async () => {
    await vc.interrupt(need(args[0], "vc interrupt <sessionId>"));
    console.log("interrupted.");
  },

  rename: async () => {
    const id = need(args[0], "vc rename <sessionId> <title>");
    print(await vc.renameSession(id, need(args.slice(1).join(" "), "vc rename <sessionId> <title>")));
  },
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
  vc.close();
}
