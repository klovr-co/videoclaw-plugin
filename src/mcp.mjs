#!/usr/bin/env node
// MCP server (stdio) exposing Videoclaw as tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as vc from "./videoclaw.mjs";

const server = new McpServer({ name: "videoclaw", version: "0.4.0" });

const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value ?? { done: true }, null, 2) }] });
const tool = (name, description, schema, run) =>
  server.tool(name, description, schema, async (args) => {
    try {
      return ok(await run(args));
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
  });

const sessionId = z.string().describe("Videoclaw video id (sessionId from videoclaw_list_sessions)");
const clientId = z
  .string()
  .describe("Videoclaw project: its id, or its name such as \"Hover\" (see videoclaw_list_clients)");
const files = z
  .array(z.string())
  .optional()
  .describe("Absolute paths of local files to attach (footage, stills, audio, briefs)");

const NEXT_STEP =
  "Videoclaw turns can take many minutes. Call videoclaw_check_progress with this sessionId to wait for " +
  "and read the reply; if it is still running, tell the user it's in progress and check again later.";

// ── videos (sessions) ──────────────────────────────────────────────────────

tool(
  "videoclaw_launch",
  "Start Videoclaw with its DevTools port open. Other tools do this automatically; use restart=true only " +
    "when the user agrees, because it interrupts a running job.",
  { restart: z.boolean().optional() },
  ({ restart }) => vc.launch({ restart }),
);

tool(
  "videoclaw_list_clients",
  "List Videoclaw projects (clients). A project decides which taste rules apply to its videos.",
  {},
  () => vc.listClients(),
);

tool(
  "videoclaw_list_sessions",
  "List Videoclaw videos (chat sessions) with title, project and status (needsYou, working, done, idle).",
  { clientId: clientId.optional() },
  ({ clientId }) => vc.listSessions({ clientId }),
);

tool(
  "videoclaw_create_session",
  "Create a new Videoclaw video under a project, and optionally send the first message (the brief) with " +
    "attached files. Returns immediately; use videoclaw_check_progress to get the reply.",
  { clientId: clientId.optional(), title: z.string().optional(), message: z.string().optional(), files },
  async ({ clientId, title, message, files }) => {
    const session = await vc.createSession({ clientId, title });
    if (!message) return { session };
    const sent = await vc.send(session.sessionId, message, { files });
    return { session, ...sent, next: NEXT_STEP };
  },
);

tool(
  "videoclaw_send_message",
  "Send a message to a Videoclaw video (a brief, feedback, or a go-ahead), optionally with attached files. " +
    "Returns as soon as Videoclaw accepts it; it does NOT wait for the reply. If Videoclaw is still working, " +
    "the message is queued and sent when the current turn ends. Then call videoclaw_check_progress.",
  { sessionId, message: z.string(), files },
  async ({ sessionId, message, files }) => ({ sessionId, ...(await vc.send(sessionId, message, { files })), next: NEXT_STEP }),
);

tool(
  "videoclaw_check_progress",
  "Wait up to waitMinutes (default 4, max 5) for a video's current turn to finish or to need the user, then " +
    "return its status (running/idle/error), the reply so far, the tools it used, anything waiting on the " +
    "user, and the latest and final versions. If done=false, report progress and check again later rather " +
    "than looping for a long time. If waitingOnUser is not empty, see videoclaw_get_pending.",
  { sessionId, waitMinutes: z.number().min(0).max(5).optional() },
  ({ sessionId, waitMinutes = 4 }) => vc.checkProgress(sessionId, { waitMs: waitMinutes * 60_000 }),
);

tool(
  "videoclaw_get_history",
  "Read a video's recent chat: user and assistant messages and notices (and tool steps with includeTools).",
  { sessionId, limit: z.number().int().positive().max(200).optional(), includeTools: z.boolean().optional() },
  ({ sessionId, limit, includeTools }) => vc.history(sessionId, { limit, tools: includeTools }),
);

tool(
  "videoclaw_get_job",
  "Get what a video produced: its job folder, numbered versions (V1, V2…, with the final marked) and other " +
    "outputs (stills, audio, clips, newest first) as absolute local paths you can open.",
  { sessionId, all: z.boolean().optional().describe("List every output, not only the newest 30") },
  ({ sessionId, all }) => vc.getJob(sessionId, { all }),
);

tool("videoclaw_interrupt", "Stop the running turn on a Videoclaw video.", { sessionId }, async ({ sessionId }) => {
  await vc.interrupt(sessionId);
  return { interrupted: true };
});

tool(
  "videoclaw_rename_session",
  "Rename a Videoclaw video.",
  { sessionId, title: z.string() },
  ({ sessionId, title }) => vc.renameSession(sessionId, title),
);

tool(
  "videoclaw_set_agent_settings",
  "Change the model, effort, mode or fast setting of a video's agent. Omitted fields keep their value. " +
    "mode 'plan' makes Videoclaw plan before it builds; 'ask' asks before each action. Only change these " +
    "when the user asks.",
  {
    sessionId,
    model: z.string().optional().describe("For example claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5"),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    mode: z.enum(["auto", "ask", "acceptEdits", "plan", "bypass"]).optional(),
    fast: z.boolean().optional(),
  },
  ({ sessionId, ...changes }) => vc.setAgentSettings(sessionId, changes),
);

// ── versions and sharing ───────────────────────────────────────────────────

tool(
  "videoclaw_approve_version",
  "Mark a numbered version (V1, V2…) as the final video. Only when the user approves it.",
  { sessionId, version: z.number().int().positive() },
  ({ sessionId, version }) => vc.approveVersion(sessionId, version),
);

tool(
  "videoclaw_share",
  "Upload a version and return a share link anyone can open (for example to send to a client). Defaults to " +
    "the final version, else the newest. Only share when the user asks for a link.",
  {
    sessionId,
    version: z.number().int().positive().optional().describe("Version number from videoclaw_get_job"),
    title: z.string().optional(),
  },
  ({ sessionId, version, title }) => vc.shareCreate(sessionId, { version, title }),
);

tool(
  "videoclaw_list_shares",
  "List share links (status active, unresolved, expired or stopped), for one video or all.",
  { sessionId: sessionId.optional() },
  ({ sessionId }) => vc.shareList(sessionId),
);

tool(
  "videoclaw_revoke_share",
  "Stop a share link; it stops working immediately.",
  { shareId: z.string() },
  ({ shareId }) => vc.shareRevoke(shareId),
);

// ── questions and requests ─────────────────────────────────────────────────

tool(
  "videoclaw_get_pending",
  "List what Videoclaw is waiting on: question cards (with questions and options), file, rights and " +
    "voiceover requests, and spend or permission approvals. Spend and permission approvals can only be " +
    "answered in the Videoclaw window. Without sessionId, checks every video that needs you.",
  { sessionId: sessionId.optional() },
  ({ sessionId }) => vc.pending(sessionId),
);

tool(
  "videoclaw_answer_question",
  "Answer an open question card. Show the questions and options to the user first. `answers` maps each " +
    "question (its id such as \"q0\", or its text) to the chosen option label, or a list of labels for " +
    "multi-select. Text that is not an option is sent as a free-form answer.",
  {
    sessionId,
    itemId: z.string().describe("itemId from videoclaw_get_pending"),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  },
  ({ sessionId, itemId, answers }) => vc.answerQuestion(sessionId, itemId, answers),
);

tool(
  "videoclaw_respond_request",
  "Answer an open file, rights or voiceover request. kind 'files' uploads `paths`; 'rights' with " +
    "accepted=true confirms the user holds the rights (only when the user says so); 'voiceover' with " +
    "accepted=true keeps the take; 'decline' declines. Spend and permission approvals stay in the app.",
  {
    sessionId,
    itemId: z.string().describe("itemId from videoclaw_get_pending"),
    kind: z.enum(["files", "rights", "voiceover", "decline"]),
    paths: z.array(z.string()).optional().describe("Absolute file paths, for kind 'files'"),
    accepted: z.boolean().optional(),
  },
  ({ sessionId, itemId, ...answer }) => vc.respondRequest(sessionId, itemId, answer),
);

// ── money ──────────────────────────────────────────────────────────────────

tool(
  "videoclaw_get_spend",
  "Show spend: the account's credit, and with sessionId the video's budget, limit and what it has spent.",
  { sessionId: sessionId.optional() },
  ({ sessionId }) => vc.getSpend(sessionId),
);

// ── taste ──────────────────────────────────────────────────────────────────

tool(
  "videoclaw_get_taste",
  "Show the taste rules Videoclaw applies: built-in defaults, the user's own rules (you) and the " +
    "project's rules, each with commitments, noes and proposals (rules Videoclaw suggests from feedback).",
  { clientId: clientId.optional() },
  ({ clientId }) => vc.getTaste(clientId),
);

tool(
  "videoclaw_add_taste_rule",
  "Save a taste rule the user states. With clientId it applies to that project; without, to all the " +
    "user's videos.",
  { rule: z.string(), clientId: clientId.optional() },
  ({ rule, clientId }) => vc.addTasteRule(clientId, rule),
);

tool(
  "videoclaw_decide_taste_proposal",
  "Accept or decline a taste proposal from videoclaw_get_taste. Ask the user for each one. Pass the " +
    "proposal's `signal`, and the clientId when it is a project proposal.",
  { signal: z.string(), decision: z.enum(["accept", "decline"]), clientId: clientId.optional() },
  ({ signal, decision, clientId }) => vc.decideTasteProposal(clientId, signal, decision),
);

// ── projects ───────────────────────────────────────────────────────────────

tool("videoclaw_create_client", "Create a Videoclaw project.", { name: z.string() }, ({ name }) =>
  vc.createClient(name),
);

tool("videoclaw_rename_client", "Rename a Videoclaw project.", { clientId, name: z.string() }, ({ clientId, name }) =>
  vc.renameClient(clientId, name),
);

// ── characters ─────────────────────────────────────────────────────────────

tool(
  "videoclaw_list_characters",
  "List saved characters (people Videoclaw can put in videos) with their state and sheet image. To use one " +
    "in a video, name it in the message. To make a new one, ask Videoclaw in a video's chat.",
  {},
  () => vc.listCharacters(),
);

tool(
  "videoclaw_approve_character",
  "Approve a pending character's sheet. Look at the sheet image with the user first.",
  { slug: z.string().describe("Character slug or name") },
  ({ slug }) => vc.approveCharacter(slug),
);

tool(
  "videoclaw_delete_character",
  "Delete a character (or discard a pending one). Only when the user asks.",
  { slug: z.string().describe("Character slug or name") },
  ({ slug }) => vc.deleteCharacter(slug),
);

await server.connect(new StdioServerTransport());
