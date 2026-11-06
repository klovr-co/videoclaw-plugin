#!/usr/bin/env node
// MCP server (stdio) exposing Videoclaw as tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as vc from "./videoclaw.mjs";
import * as studio from "./studio.mjs";

const server = new McpServer({ name: "videoclaw", version: "0.3.0" });

const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value ?? { done: true }, null, 2) }] });
const tool = (name, description, schema, run) =>
  server.tool(name, description, schema, async (args) => {
    try {
      return ok(await run(args));
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
  });

const sessionId = z.string().describe("Videoclaw session id");
const clientId = z.string().describe("Videoclaw client/project id (see videoclaw_list_clients)");
const files = z
  .array(z.string())
  .optional()
  .describe("Absolute paths of local files to attach (footage, stills, audio, briefs)");

// ── sessions ───────────────────────────────────────────────────────────────

tool(
  "videoclaw_launch",
  "Start Videoclaw with its DevTools port open. Other tools do this automatically; use restart=true only " +
    "when the user agrees, because it interrupts a running job.",
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

async function sendWithFiles(id, message, paths) {
  const attachmentIds = paths?.length ? await studio.stageFiles(id, paths) : [];
  await vc.send(id, message, { wait: false, attachmentIds });
  return attachmentIds.length;
}

tool(
  "videoclaw_create_session",
  "Create a new Videoclaw chat session, optionally under a client (the project; it decides which taste pack " +
    "and media library apply), and optionally send a first message with attached files. Returns immediately; " +
    "use videoclaw_check_progress to get the reply.",
  { clientId: clientId.optional(), message: z.string().optional(), files },
  async ({ clientId, message, files }) => {
    const session = await vc.createSession({ clientId });
    if (!message) return { session };
    const attached = await sendWithFiles(session.sessionId, message, files);
    return { session, sent: true, attached, next: NEXT_STEP };
  },
);

tool(
  "videoclaw_send_message",
  "Send a message to a Videoclaw session (a brief, a reply, or a go-ahead), optionally with attached files. " +
    "Returns as soon as Videoclaw accepts it; it does NOT wait for the reply. Then call videoclaw_check_progress.",
  { sessionId, message: z.string(), files },
  async ({ sessionId, message, files }) => {
    const attached = await sendWithFiles(sessionId, message, files);
    return { sessionId, sent: true, attached, next: NEXT_STEP };
  },
);

tool(
  "videoclaw_check_progress",
  "Wait up to waitMinutes (default 4, max 5) for a Videoclaw session's current turn to finish, then return " +
    "its status (running/idle/error), the assistant's reply so far, anything waiting on the user, and current " +
    "renders. While running it also returns typical stage durations. If done=false, report progress and call " +
    "again later rather than looping for a long time. If waitingOnUser lists a question, use " +
    "videoclaw_get_pending and videoclaw_answer_question.",
  { sessionId, waitMinutes: z.number().min(0).max(5).optional() },
  async ({ sessionId, waitMinutes = 4 }) => {
    const progress = await vc.checkProgress(sessionId, { waitMs: waitMinutes * 60_000 });
    if (progress.done) return progress;
    return { ...progress, typicalStageTimes: await studio.stageEtas().catch(() => undefined) };
  },
);

tool(
  "videoclaw_get_history",
  "Read a Videoclaw session's transcript (user, assistant, tool and error entries).",
  { sessionId },
  ({ sessionId }) => vc.transcript(sessionId),
);

tool(
  "videoclaw_get_job",
  "Get the artifacts a session produced: its job folder, numbered versions (with approval state and the " +
    "user's feedback), renders (newest first) and other outputs (stills, audio, approval sheets) as absolute " +
    "local paths you can open or read.",
  { sessionId },
  ({ sessionId }) => vc.getJob(sessionId),
);

tool("videoclaw_interrupt", "Stop the running turn in a Videoclaw session.", { sessionId }, ({ sessionId }) =>
  vc.interrupt(sessionId).then(() => ({ interrupted: true })),
);

// ── plan ───────────────────────────────────────────────────────────────────

tool(
  "videoclaw_get_plan",
  "Read the session's plan card (Videoclaw's proposal before it builds): title, text, format, shots, budget " +
    "and phase. phase 'awaiting-decision' means it waits for videoclaw_choose_plan.",
  { sessionId },
  ({ sessionId }) => studio.getPlan(sessionId),
);

tool(
  "videoclaw_choose_plan",
  "Press a plan button, exactly like the app: 'build' (start the full build), 'preview' (cheap preview first), " +
    "'change' (revise the plan; requires correction text) or 'dismiss'. Show the plan to the user and only " +
    "choose build or preview when they approve it. Building may spend credits within the app's budget rules.",
  {
    sessionId,
    action: z.enum(["build", "preview", "change", "dismiss"]),
    correction: z.string().optional().describe("What to change; required for action 'change'"),
  },
  ({ sessionId, action, correction }) => {
    if (action === "change" && !correction) throw new Error("Give correction text for 'change'.");
    return studio.choosePlan(sessionId, action, correction);
  },
);

// ── versions ───────────────────────────────────────────────────────────────

tool(
  "videoclaw_approve_version",
  "Approve a numbered version (V1, V2…) as the final video for the session.",
  { sessionId, version: z.number().int().positive() },
  ({ sessionId, version }) => studio.approveVersion(sessionId, version),
);

tool(
  "videoclaw_revert_final",
  "Make an earlier version the final one instead.",
  { sessionId, version: z.number().int().positive() },
  ({ sessionId, version }) => studio.revertFinal(sessionId, version),
);

tool(
  "videoclaw_reopen",
  "Reopen a finished (approved) video so it can be edited again.",
  { sessionId },
  ({ sessionId }) => studio.reopenSession(sessionId),
);

// ── sharing ────────────────────────────────────────────────────────────────

tool(
  "videoclaw_share",
  "Upload a finished version and return a share link anyone can open (for example to post to a client). " +
    "Defaults to the approved final, else the newest version. Only share when the user asks for a link.",
  {
    sessionId,
    version: z.number().int().positive().optional().describe("Version number from videoclaw_get_job"),
    title: z.string().optional(),
  },
  ({ sessionId, version, title }) => studio.shareCreate(sessionId, { version, title }),
);

tool(
  "videoclaw_list_shares",
  "List share links, for one session or all sessions.",
  { sessionId: sessionId.optional() },
  ({ sessionId }) => studio.shareList(sessionId),
);

tool(
  "videoclaw_revoke_share",
  "Stop a share link; it stops working immediately.",
  { shareId: z.string() },
  ({ shareId }) => studio.shareRevoke(shareId).then(() => ({ revoked: shareId })),
);

// ── questions and requests ─────────────────────────────────────────────────

tool(
  "videoclaw_get_pending",
  "List what Videoclaw is waiting on: question cards (with their questions and options), file and rights " +
    "requests, and spend or permission approvals. Spend/permission approvals can only be answered in the " +
    "Videoclaw window.",
  { sessionId: sessionId.optional() },
  ({ sessionId }) => studio.pendingRequests(sessionId),
);

tool(
  "videoclaw_answer_question",
  "Answer a question card from videoclaw_get_pending. answers maps each question's exact text to an option " +
    "label, several labels, or free text. Ask the user unless they already gave the answer.",
  {
    sessionId,
    requestId: z.string(),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  },
  ({ sessionId, requestId, answers }) => studio.answerQuestion(sessionId, requestId, answers),
);

tool(
  "videoclaw_respond_request",
  "Answer a file or rights request from videoclaw_get_pending: 'files' with absolute paths, 'rights' to " +
    "confirm the user holds the rights (only when the user explicitly confirmed it), or 'cancel' to decline.",
  {
    sessionId,
    requestId: z.string(),
    kind: z.enum(["files", "rights", "cancel"]),
    paths: z.array(z.string()).optional(),
    reason: z.string().optional(),
  },
  ({ sessionId, requestId, kind, paths, reason }) => {
    const response =
      kind === "files"
        ? { kind, paths: paths ?? [] }
        : kind === "rights"
          ? { kind, accepted: true }
          : { kind, reason: reason ?? "Declined" };
    if (kind === "files" && !paths?.length) throw new Error("Give paths for 'files'.");
    return studio.respondInput(sessionId, requestId, response);
  },
);

// ── budget ─────────────────────────────────────────────────────────────────

tool(
  "videoclaw_get_spend",
  "Show a video's spend and reserved budget, and the account's credit balance. Read-only.",
  { sessionId: sessionId.optional() },
  ({ sessionId }) => studio.getSpend(sessionId),
);

// ── taste ──────────────────────────────────────────────────────────────────

tool(
  "videoclaw_get_taste",
  "Show the taste layers Videoclaw applies to a client/project: engine defaults, the user's global taste, " +
    "and the project pack, with whether each file exists and its contents.",
  { clientId },
  ({ clientId }) => vc.getTaste(clientId),
);

tool(
  "videoclaw_list_taste_proposals",
  "List taste rules Videoclaw proposes saving for a project (patterns it noticed in feedback).",
  { clientId },
  ({ clientId }) => studio.tasteProposals(clientId),
);

tool(
  "videoclaw_decide_taste_proposal",
  "Accept a proposed taste rule (saved and applied to future videos) or decline it (Videoclaw won't raise it " +
    "again). Ask the user first.",
  { clientId, proposalId: z.string(), decision: z.enum(["accept", "decline"]) },
  ({ clientId, proposalId, decision }) =>
    decision === "accept"
      ? studio.acceptTasteProposal(clientId, proposalId)
      : studio.declineTasteProposal(clientId, proposalId),
);

tool(
  "videoclaw_add_taste_rule",
  "Add a taste rule the user stated. layer 'client' applies to this project only; 'global' applies to all " +
    "the user's projects.",
  { clientId, rule: z.string(), layer: z.enum(["client", "global"]).optional() },
  ({ clientId, rule, layer }) => studio.addTasteRule(clientId, rule, layer ?? "client"),
);

tool(
  "videoclaw_seed_taste_pack",
  "Create a project's taste pack from a short brief about the brand or creator (what Videoclaw's project " +
    "starter does).",
  { clientId, brief: z.string() },
  ({ clientId, brief }) => studio.seedProjectPack(clientId, brief),
);

// ── project memory ─────────────────────────────────────────────────────────

tool(
  "videoclaw_get_memory",
  "Read the notes Videoclaw remembers about a project (preferences, decisions), with their sources. To add " +
    "a note, tell Videoclaw in a session to remember it.",
  { clientId },
  ({ clientId }) => studio.getMemory(clientId),
);

tool(
  "videoclaw_edit_memory",
  "Rewrite the text of an existing project-memory note (its sources are kept).",
  { clientId, entryId: z.string(), text: z.string() },
  ({ clientId, entryId, text }) => studio.editMemory(clientId, entryId, text),
);

tool(
  "videoclaw_forget_memory",
  "Remove a project-memory note. The reply includes an undo id for videoclaw_undo_memory.",
  { clientId, entryId: z.string() },
  ({ clientId, entryId }) => studio.forgetMemory(clientId, entryId),
);

tool(
  "videoclaw_undo_memory",
  "Undo a project-memory edit or removal.",
  { clientId, undoId: z.string() },
  ({ clientId, undoId }) => studio.undoMemory(clientId, undoId),
);

// ── clients ────────────────────────────────────────────────────────────────

tool("videoclaw_create_client", "Create a new client/project.", { name: z.string() }, ({ name }) =>
  studio.createClient(name),
);

tool(
  "videoclaw_rename_client",
  "Rename a client/project.",
  { clientId, name: z.string() },
  ({ clientId, name }) => studio.renameClient(clientId, name),
);

tool(
  "videoclaw_set_library_id",
  "Set the id a project uses for its media library and taste pack folder (assets/<id>, taste/packs/<id>). " +
    "Changing it points the project at a different library; ask the user first.",
  { clientId, libraryId: z.string() },
  ({ clientId, libraryId }) => studio.setLibraryId(clientId, libraryId),
);

// ── media library ──────────────────────────────────────────────────────────

tool(
  "videoclaw_library_stats",
  "Show a project's media library: indexed videos and images, and its source folders.",
  { clientId },
  ({ clientId }) => studio.libraryStats(clientId),
);

tool(
  "videoclaw_library_scan",
  "Check a project's source folders for media not yet indexed. Free.",
  { clientId },
  ({ clientId }) => studio.libraryScan(clientId),
);

tool(
  "videoclaw_library_search",
  "Search a project's indexed footage or stills in plain words (for example 'dark mode home screen').",
  { clientId, query: z.string(), type: z.enum(["video", "image"]).optional() },
  ({ clientId, query, type }) => studio.librarySearch(clientId, query, type ?? "video"),
);

tool(
  "videoclaw_library_add_folder",
  "Add a local folder of footage or stills to a project's library. Then run videoclaw_library_sync to index it.",
  { clientId, folder: z.string().describe("Absolute folder path") },
  ({ clientId, folder }) => studio.libraryAddFolder(clientId, folder),
);

tool(
  "videoclaw_library_sync",
  "Index new media in a project's library so it becomes searchable. This uses a paid embedding model; " +
    "check videoclaw_library_scan first and ask the user before syncing many files.",
  { clientId },
  ({ clientId }) => studio.librarySync(clientId),
);

// ── characters ─────────────────────────────────────────────────────────────

tool(
  "videoclaw_list_characters",
  "List saved characters (people Videoclaw can put in videos), with state and sheet path.",
  {},
  () => studio.listCharacters(),
);

tool(
  "videoclaw_create_character",
  "Create a character from reference photos (pending until its sheet is built and approved). isSelf marks " +
    "the user's own character.",
  { name: z.string(), photos: z.array(z.string()).min(1), isSelf: z.boolean().optional() },
  ({ name, photos, isSelf }) => studio.createCharacter(name, photos, isSelf ?? false),
);

tool(
  "videoclaw_build_character_sheet",
  "Build a pending character's reference sheet. confirm=false (default) only returns what it involves and " +
    "costs; confirm=true starts the paid build. Ask the user before confirming.",
  { slug: z.string(), confirm: z.boolean().optional() },
  ({ slug, confirm }) => (confirm ? studio.buildCharacterSheet(slug) : studio.characterSheetPlan(slug)),
);

tool(
  "videoclaw_approve_character",
  "Approve a character's built sheet so it can be used in videos. Look at the sheet image first.",
  { slug: z.string() },
  ({ slug }) => studio.approveCharacter(slug),
);

tool(
  "videoclaw_delete_character",
  "Delete a character (or discard a pending one). Ask the user first.",
  { slug: z.string() },
  ({ slug }) => studio.deleteCharacter(slug),
);

tool(
  "videoclaw_list_voices",
  "List saved character voices for a project.",
  { clientId },
  ({ clientId }) => studio.listVoices(clientId),
);

tool(
  "videoclaw_approve_voice",
  "Approve a saved character voice for a project after the user has listened to it.",
  { clientId, voiceId: z.string() },
  ({ clientId, voiceId }) => studio.approveVoice(clientId, voiceId),
);

// ── templates ──────────────────────────────────────────────────────────────

tool("videoclaw_list_templates", "List Videoclaw's starter templates (Quickstarts).", {}, () =>
  studio.listTemplates(),
);

tool(
  "videoclaw_start_template",
  "Start a new video session from a template under a client. Returns the new session; then use " +
    "videoclaw_check_progress.",
  { clientId, templateId: z.string().describe("Template id from videoclaw_list_templates") },
  ({ clientId, templateId }) => studio.startTemplate(clientId, templateId),
);

await server.connect(new StdioServerTransport());
