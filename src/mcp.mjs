#!/usr/bin/env node
// MCP server (stdio) exposing Videoclaw chat sessions as tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as vc from "./videoclaw.mjs";

const server = new McpServer({ name: "videoclaw", version: "0.1.0" });

const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const tool = (name, description, schema, run) =>
  server.tool(name, description, schema, async (args) => {
    try {
      return ok(await run(args));
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
  });

tool(
  "videoclaw_launch",
  "Start Videoclaw with its DevTools port open so the other tools can reach it. " +
    "restart=true quits and relaunches an already-running Videoclaw (interrupts running turns).",
  { restart: z.boolean().optional() },
  ({ restart }) => vc.launch({ restart }),
);

tool("videoclaw_list_clients", "List Videoclaw clients/projects (use clientId when creating a session).", {}, () =>
  vc.listClients(),
);

tool("videoclaw_list_sessions", "List Videoclaw chat sessions with status, client and title.", {}, () =>
  vc.listSessions(),
);

const NEXT_STEP =
  "Videoclaw turns can take many minutes. Call videoclaw_check_progress with this sessionId to wait for " +
  "and read the reply; if it is still running, tell the user it's in progress and check again later.";

tool(
  "videoclaw_create_session",
  "Create a new Videoclaw chat session, optionally under a client (the project; it decides which taste pack " +
    "and media library apply), and optionally send a first message. Returns immediately; use " +
    "videoclaw_check_progress to get the reply.",
  { clientId: z.string().optional(), message: z.string().optional() },
  async ({ clientId, message }) => {
    const session = await vc.createSession({ clientId });
    if (!message) return { session };
    await vc.send(session.sessionId, message, { wait: false });
    return { session, sent: true, next: NEXT_STEP };
  },
);

tool(
  "videoclaw_send_message",
  "Send a message to a Videoclaw session (a brief, a reply, or a go-ahead like 'build it'). Returns as soon " +
    "as Videoclaw accepts it; it does NOT wait for the reply. Then call videoclaw_check_progress.",
  { sessionId: z.string(), message: z.string() },
  async ({ sessionId, message }) => {
    await vc.send(sessionId, message, { wait: false });
    return { sessionId, sent: true, next: NEXT_STEP };
  },
);

tool(
  "videoclaw_check_progress",
  "Wait up to waitMinutes (default 4, max 5) for a Videoclaw session's current turn to finish, then return " +
    "its status (running/idle/error), the assistant's reply so far, anything waiting on the user (spend " +
    "approvals, questions — answered in the Videoclaw window, or by replying via send_message where the " +
    "agent asks in chat), and current renders. If done=false, the job is still working: report progress " +
    "and call again later rather than looping for a long time.",
  { sessionId: z.string(), waitMinutes: z.number().min(0).max(5).optional() },
  ({ sessionId, waitMinutes = 4 }) => vc.checkProgress(sessionId, { waitMs: waitMinutes * 60_000 }),
);

tool(
  "videoclaw_get_history",
  "Read a Videoclaw session's transcript (user, assistant, tool and error entries).",
  { sessionId: z.string() },
  ({ sessionId }) => vc.transcript(sessionId),
);

tool(
  "videoclaw_get_job",
  "Get the artifacts a session produced: its job folder, final renders (newest first) and other outputs " +
    "(stills, audio, approval sheets) as absolute local paths you can open or read.",
  { sessionId: z.string() },
  ({ sessionId }) => vc.getJob(sessionId),
);

tool(
  "videoclaw_get_taste",
  "Show the taste layers Videoclaw applies to a client/project: engine defaults, the user's global taste, " +
    "and the project pack, with whether each file exists and its contents.",
  { clientId: z.string() },
  ({ clientId }) => vc.getTaste(clientId),
);

tool("videoclaw_interrupt", "Stop the running turn in a Videoclaw session.", { sessionId: z.string() }, ({ sessionId }) =>
  vc.interrupt(sessionId).then(() => ({ interrupted: true })),
);

await server.connect(new StdioServerTransport());
