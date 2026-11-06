// Tier 1 + Tier 2 actions: plans, versions, sharing, questions, budget, files,
// taste, project memory, clients, media library, characters and templates.
// Every function body runs inside the Videoclaw renderer through `app()`, with
// `vc`, `workspace()`, `appScope()` and `unwrap()` in scope (see PRELUDE).
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "./videoclaw.mjs";

const fileRef = (path) => ({ path, name: basename(path) });

const publicShare = (s) => ({
  shareId: s.shareId,
  status: s.revokedAtMs ? "revoked" : s.expiresAtMs && s.expiresAtMs < Date.now() ? "expired" : "active",
  url: s.url,
  title: s.title,
  version: s.versionN,
  path: s.path,
  sizeMb: s.sizeBytes ? +(s.sizeBytes / 1e6).toFixed(1) : undefined,
  created: s.createdAtMs ? new Date(s.createdAtMs).toISOString() : undefined,
  expires: s.expiresAtMs ? new Date(s.expiresAtMs).toISOString() : undefined,
});

// ── plan ───────────────────────────────────────────────────────────────────

export function getPlan(sessionId) {
  return app(async (sessionId) => {
    const plan = unwrap(await vc.readSessionPlan(await appScope({ sessionId })));
    if (!plan) return { plan: null, note: "This session has no plan card." };
    return { plan };
  }, sessionId);
}

/** Press a plan button: build, preview, change (with a correction) or dismiss. */
export function choosePlan(sessionId, action, correction) {
  return app(
    async ({ sessionId, action, correction, clientActionId }) => {
      const scope = await appScope({ sessionId });
      const plan = unwrap(await vc.readSessionPlan(scope));
      if (!plan) throw new Error("This session has no plan to choose.");
      const reply = await vc.chooseSessionPlan(scope, {
        planId: plan.id,
        revision: plan.revision,
        action,
        clientActionId,
        ...(action === "change" ? { correction } : {}),
      });
      return { chosen: action, plan: unwrap(reply) };
    },
    { sessionId, action, correction, clientActionId: randomUUID() },
  );
}

// ── versions ───────────────────────────────────────────────────────────────

export function approveVersion(sessionId, version) {
  return app(({ sessionId, version }) => vc.approveVersion(sessionId, version), { sessionId, version });
}

export function revertFinal(sessionId, version) {
  return app(({ sessionId, version }) => vc.revertFinal(sessionId, version), { sessionId, version });
}

export function reopenSession(sessionId) {
  return app((sessionId) => vc.unfinalizeSession(sessionId), sessionId);
}

// ── sharing ────────────────────────────────────────────────────────────────

/**
 * Upload a finished version and return its share link. Defaults to the approved
 * final, else the newest version. Only version files (versions/vN.mp4) can be shared.
 */
export async function shareCreate(sessionId, { version, title } = {}) {
  return publicShare(await app(
    async ({ sessionId, version, title }) => {
      const job = await vc.getJobSnapshot(sessionId);
      const versions = job?.versions ?? [];
      const pick =
        version !== undefined
          ? versions.find((v) => v.n === version)
          : (job?.finals?.at(-1) ?? versions.at(-1));
      if (!pick) throw new Error(version !== undefined ? `This session has no V${version}.` : "This session has no finished version to share yet.");
      const session = (await vc.listSessions()).find((s) => s.sessionId === sessionId);
      await vc.shareCreate({ sessionId, path: pick.path, title: (title || session?.title || "Video").slice(0, 120) });
      const shares = await vc.shareList(sessionId);
      const live = shares.filter((s) => s.path === pick.path && !s.revokedAtMs);
      return live.sort((a, b) => b.createdAtMs - a.createdAtMs)[0] ?? { path: pick.path };
    },
    { sessionId, version, title },
  ));
}

export async function shareList(sessionId) {
  return (await app((sessionId) => vc.shareList(sessionId ?? undefined), sessionId ?? null)).map(publicShare);
}

export function shareRevoke(shareId) {
  return app((shareId) => vc.shareRevoke(shareId), shareId);
}

// ── questions and input requests ───────────────────────────────────────────

/** Everything the session is waiting on, with full question details. */
export function pendingRequests(sessionId) {
  return app(async (sessionId) => {
    const seen = [];
    const offs = [
      vc.onPermissionRequest((r) => seen.push({ channel: "permission", ...r })),
      vc.onInputRequest((r) => seen.push({ channel: "input", ...r })),
    ];
    await vc.replayPendingInteractions();
    await new Promise((r) => setTimeout(r, 400));
    for (const off of offs) if (typeof off === "function") off();
    const unique = new Map(seen.filter((r) => !sessionId || r.sessionId === sessionId).map((r) => [r.requestId, r]));
    return [...unique.values()];
  }, sessionId ?? null);
}

/**
 * Answer a question card. Only `kind: "question"` permission requests are
 * accepted here; spend and tool permissions stay in the Videoclaw window.
 * `answers` maps each question's text to the chosen option label(s) or free text.
 */
export async function answerQuestion(sessionId, requestId, answers) {
  const req = (await pendingRequests(sessionId)).find((r) => r.requestId === requestId);
  if (!req) throw new Error("No pending request with that id in this session.");
  if (req.channel !== "permission" || req.kind !== "question") {
    throw new Error(`That request is a ${req.kind ?? req.channel} request, not a question. Answer it in the Videoclaw window.`);
  }
  const questions = req.questions ?? req.input?.questions ?? [];
  const flat = {};
  const selections = {};
  for (const q of questions) {
    const given = answers[q.question];
    if (given === undefined) throw new Error(`Missing an answer for: ${q.question}`);
    const list = Array.isArray(given) ? given : [given];
    const labels = new Set((q.options ?? []).map((o) => o.label));
    const chosen = list.filter((a) => labels.has(a));
    const other = list.filter((a) => !labels.has(a)).join(", ");
    flat[q.question] = list.join(", ");
    selections[q.question] = { chosen, ...(other ? { other } : {}) };
  }
  await app(
    ({ requestId, flat, selections }) => vc.respondPermission(requestId, { behavior: "answers", answers: flat, selections }),
    { requestId, flat, selections },
  );
  return { answered: true, answers: flat };
}

/**
 * Answer an input request: provide files, confirm rights, or decline.
 * Rights confirmation is the user's legal statement — only send it when the user said so.
 */
export async function respondInput(sessionId, requestId, response) {
  const req = (await pendingRequests(sessionId)).find((r) => r.requestId === requestId);
  if (!req || req.channel !== "input") throw new Error("No pending file or rights request with that id.");
  await app(({ requestId, response }) => vc.respondInput(requestId, response), { requestId, response });
  return { responded: true, kind: response.kind };
}

// ── budget and timing ──────────────────────────────────────────────────────

export function getSpend(sessionId) {
  return app(async (sessionId) => {
    const [spend, meter] = await Promise.all([
      sessionId ? vc.getSpendSnapshot(sessionId) : null,
      vc.keyMeter().catch(() => null),
    ]);
    return { video: spend, account: meter };
  }, sessionId ?? null);
}

/** Typical duration of each production stage, learned from this workspace's past jobs. */
export function stageEtas() {
  return app(async () => vc.getStageEtas(await workspace()));
}

// ── files into a session ───────────────────────────────────────────────────

/** Stage local files on a session the way drag-and-drop does; returns attachment ids. */
export async function stageFiles(sessionId, paths) {
  const staged = await app(
    ({ sessionId, files }) => vc.attachmentStage({ sessionId, destination: "video", files }),
    { sessionId, files: paths.map(fileRef) },
  );
  const rejected = staged.filter((a) => a.status === "rejected" || a.rejection);
  if (rejected.length) {
    throw new Error(`Videoclaw refused: ${rejected.map((a) => `${a.name} (${a.rejection ?? a.status})`).join(", ")}`);
  }
  return staged.map((a) => a.id);
}

// ── taste ──────────────────────────────────────────────────────────────────

async function tasteState(clientId) {
  return app(async (clientId) => {
    const cwd = await workspace();
    return { cwd, ...(await vc.listTaste(clientId, cwd)) };
  }, clientId);
}

export async function tasteProposals(clientId) {
  const t = await tasteState(clientId);
  return (t.proposals ?? []).map((p) => ({ id: p.id, rule: p.takeaway, file: p.file, ...p }));
}

/** Accept a proposed rule into its taste file (the same text the app's Accept button writes). */
export async function acceptTasteProposal(clientId, proposalId) {
  const t = await tasteState(clientId);
  const p = (t.proposals ?? []).find((x) => x.id === proposalId);
  if (!p) throw new Error("No taste proposal with that id for this project.");
  const scope = t.scopes.find((s) => s.file === p.file);
  const card = `${p.takeaway} *(${new Date().toISOString().slice(0, 10)}, from a repeated pattern)*`;
  const result = await app(({ cwd, files }) => vc.commitTaste(cwd, files), {
    cwd: t.cwd,
    files: [{ file: p.file, cards: [...(scope?.cards ?? []), card] }],
  });
  return { accepted: p.takeaway, file: p.file, result };
}

export async function declineTasteProposal(clientId, proposalId) {
  const t = await tasteState(clientId);
  const p = (t.proposals ?? []).find((x) => x.id === proposalId);
  if (!p) throw new Error("No taste proposal with that id for this project.");
  const scope = t.scopes.find((s) => s.file === p.file);
  const antiText = `${p.takeaway} *(declined ${new Date().toISOString().slice(0, 10)})*`;
  const result = await app(({ cwd, file, cards, antiText }) => vc.declineProposal(cwd, file, cards, antiText), {
    cwd: t.cwd,
    file: p.file,
    cards: scope?.cards ?? [],
    antiText,
  });
  return { declined: p.takeaway, result };
}

/** Add a rule to the project's taste ("client") or to your taste across all projects ("global"). */
export async function addTasteRule(clientId, rule, layer = "client") {
  const t = await tasteState(clientId);
  const scope = t.scopes.find((s) => s.scope === layer);
  if (!scope) throw new Error(`No ${layer} taste layer for this project.`);
  if (scope.readonly) throw new Error("That taste layer is read-only.");
  const result = await app(({ cwd, files }) => vc.commitTaste(cwd, files), {
    cwd: t.cwd,
    files: [{ file: scope.file, cards: [...scope.cards, rule] }],
  });
  return { added: rule, file: scope.file, result };
}

/** Create a project's taste pack from a short brief (what the app's project starter does). */
export function seedProjectPack(clientId, brief) {
  return app(async ({ clientId, brief }) => vc.seedProjectPack(clientId, await workspace(), brief), { clientId, brief });
}

// ── project memory ─────────────────────────────────────────────────────────

export function getMemory(clientId) {
  return app(async (clientId) => unwrap(await vc.readProjectMemory(await appScope({ clientId }))), clientId);
}

/** Rewrite an existing note's text, keeping its sources. */
export function editMemory(clientId, entryId, text) {
  return app(
    async ({ clientId, entryId, text }) => {
      const scope = await appScope({ clientId });
      const snap = unwrap(await vc.readProjectMemory(scope));
      const entry = snap.entries.find((e) => e.id === entryId);
      if (!entry) throw new Error("No memory note with that id.");
      return unwrap(
        await vc.updateProjectMemory(scope, {
          action: "save",
          expectedRevision: snap.revision,
          entry: { id: entry.id, sources: entry.sources, relatedIds: entry.relatedIds, text },
        }),
      );
    },
    { clientId, entryId, text },
  );
}

export function forgetMemory(clientId, entryId) {
  return app(
    async ({ clientId, entryId }) => {
      const scope = await appScope({ clientId });
      const snap = unwrap(await vc.readProjectMemory(scope));
      return unwrap(await vc.updateProjectMemory(scope, { action: "forget", expectedRevision: snap.revision, id: entryId }));
    },
    { clientId, entryId },
  );
}

export function undoMemory(clientId, undoId) {
  return app(
    async ({ clientId, undoId }) => {
      const scope = await appScope({ clientId });
      const snap = unwrap(await vc.readProjectMemory(scope));
      return unwrap(await vc.undoProjectMemory(scope, undoId, snap.revision));
    },
    { clientId, undoId },
  );
}

// ── clients ────────────────────────────────────────────────────────────────

export function createClient(name) {
  return app((name) => vc.createClient(name), name);
}

export async function renameClient(clientId, name) {
  const result = await app(({ clientId, name }) => vc.renameClient(clientId, name), { clientId, name });
  if (result && "error" in result) throw new Error(result.error);
  return result;
}

/** Set the media-library / taste-pack id a project uses (taste/packs/<id>, assets/<id>). */
export function setLibraryId(clientId, libraryId) {
  return app(({ clientId, libraryId }) => vc.librarySetTenant(clientId, libraryId), { clientId, libraryId });
}

// ── media library ──────────────────────────────────────────────────────────

const libraryReply = (r) => {
  if (r && r.error) throw new Error(r.error === "no-tenant" ? "This project has no media library yet. Set one with videoclaw_set_library_id." : r.message ?? r.error);
  return r;
};

export async function libraryStats(clientId) {
  return libraryReply(await app(async (clientId) => vc.libraryStats(clientId, await workspace()), clientId));
}

/** Folders added since the last sync, and sources that can't be reached. Free. */
export async function libraryScan(clientId) {
  return libraryReply(await app(async (clientId) => vc.libraryScan(clientId, await workspace()), clientId));
}

export async function librarySearch(clientId, query, type = "video") {
  return libraryReply(
    await app(async ({ clientId, query, type }) => vc.librarySearch(clientId, await workspace(), query, type, undefined), {
      clientId,
      query,
      type,
    }),
  );
}

export async function libraryAddFolder(clientId, folder) {
  return libraryReply(
    await app(async ({ clientId, folder }) => vc.libraryAddSource(clientId, await workspace(), "all", folder), { clientId, folder }),
  );
}

/** Index new media. This embeds media with a paid model; the app's own spend rules apply. */
export async function librarySync(clientId) {
  return libraryReply(await app(async (clientId) => vc.librarySync(clientId, await workspace()), clientId));
}

// ── characters ─────────────────────────────────────────────────────────────

export function listCharacters() {
  return app(async () =>
    (await vc.charactersList(await workspace())).map((c) => ({
      slug: c.slug,
      name: c.name,
      state: c.state,
      isSelf: c.isSelf,
      sheetPath: c.sheetPath,
      refs: c.refs?.length ?? 0,
    })),
  );
}

/** Create a pending character from reference photos. Build and approve its sheet next. */
export function createCharacter(name, photos, isSelf = false) {
  return app(
    async ({ name, isSelf, photos }) => vc.charactersCreate(await workspace(), name, isSelf, photos),
    { name, isSelf, photos: photos.map(fileRef) },
  );
}

/** What building this character's sheet involves (and costs), without starting it. */
export function characterSheetPlan(slug) {
  return app(async (slug) => vc.charactersSheetPlan(await workspace(), slug), slug);
}

export function buildCharacterSheet(slug) {
  return app(async (slug) => vc.charactersSheetBuild(await workspace(), slug), slug);
}

export function approveCharacter(slug) {
  return app(async (slug) => vc.charactersApprove(await workspace(), slug), slug);
}

export async function deleteCharacter(slug) {
  const removed = await app(async (slug) => {
    const cwd = await workspace();
    const c = (await vc.charactersList(cwd)).find((x) => x.slug === slug);
    if (!c) throw new Error("No character with that slug.");
    return c.state === "pending" ? vc.charactersDiscard(cwd, slug) : vc.charactersDelete(cwd, slug);
  }, slug);
  if (!removed) throw new Error("Videoclaw kept this character: remove its saved voices first.");
  return { removed: slug };
}

const voiceReply = (r) => {
  if (r && r.ok === false) throw new Error(r.message ?? "Videoclaw refused that.");
  return (r?.snapshot?.voices ?? []).map(({ sampleSha256, ...v }) => v);
};

export async function listVoices(clientId) {
  return voiceReply(await app(async (clientId) => vc.characterVoicesList(await appScope({ clientId })), clientId));
}

export function approveVoice(clientId, voiceId) {
  return app(
    async ({ clientId, voiceId }) => {
      const scope = await appScope({ clientId });
      const list = await vc.characterVoicesList(scope);
      const voice = (list?.snapshot?.voices ?? []).find((v) => v.id === voiceId);
      if (!voice) throw new Error("No voice with that id in this project.");
      const reply = await vc.characterVoiceApprove(scope, voiceId, voice.sampleSha256);
      if (reply?.ok === false) throw new Error(reply.message ?? "Videoclaw refused that.");
      return { approved: voiceId };
    },
    { clientId, voiceId },
  );
}

// ── templates ──────────────────────────────────────────────────────────────

export function listTemplates() {
  return app(async () => {
    const catalog = await vc.quickstartCatalog();
    return {
      catalogSha256: catalog?.catalogSha256,
      templates: (catalog?.starters ?? catalog?.catalog?.starters ?? []).map((s) => ({
        id: s.id,
        title: s.title ?? s.name,
        description: s.description ?? s.summary,
        category: s.category,
      })),
    };
  });
}

/** Start a new video from a template; returns the new session. */
export function startTemplate(clientId, starterId) {
  return app(
    async ({ clientId, starterId, journeyId, activationId }) => {
      const catalog = await vc.quickstartCatalog();
      const result = await vc.quickstartStart({
        starterId,
        clientId,
        catalogSha256: catalog.catalogSha256,
        entryPoint: "project-starter",
        journeyId,
        activationId,
      });
      return result.session;
    },
    { clientId, starterId, journeyId: randomUUID(), activationId: randomUUID() },
  );
}
