---
name: videoclaw
description: Make or edit videos with the Videoclaw desktop app through the videoclaw MCP tools. Use when the user asks to create, edit, check on, approve, share or fetch a video from Videoclaw, or mentions a Videoclaw video, session, version, render, share link, project/client, taste rule or character.
---

# Videoclaw

Videoclaw is a desktop app on this Mac that makes videos with its own agent. The
`videoclaw_*` tools talk to that app. They start or reconnect it automatically.

Videoclaw calls a client a **project** and a chat session a **video**. In the tools,
`clientId` is a project (its id, or its name such as "Hover") and `sessionId` is a video's id.

## Video builds are slow

One Videoclaw turn can take 30 minutes or more. Never wait for a build in one call.

1. Start: `videoclaw_create_session` (new video) or `videoclaw_send_message` (reply on an
   existing video). Pass source files in `files` as absolute paths. Both return at once. A
   message sent while Videoclaw is working is queued and goes out when the turn ends.
2. Tell the user it has started, and give the session ID.
3. Check: `videoclaw_check_progress`. It waits at most a few minutes.
   - `done: false` → report the progress in `reply` and `toolsUsedThisTurn`, then stop. Check
     again when the user asks.
   - `done: true` → report the reply, and look at `waitingOnUser` and `latestVersion`.
4. Do not call `videoclaw_check_progress` in a loop for more than about 10 minutes in total.

## The usual flow

1. **Brief.** Pick the project with `videoclaw_list_clients`. Attach the files. Name saved
   characters by their saved name (see `videoclaw_list_characters`). Say the format: aspect
   ratio, length, captions, voice or no voice.
2. **Questions.** Videoclaw often asks before it builds, including to confirm a plan. If
   `waitingOnUser` is not empty, call `videoclaw_get_pending`.
   - `question`: show the questions and options to the user, then `videoclaw_answer_question`
     with their choices. Never choose for them.
   - `files`: `videoclaw_respond_request` with `kind: "files"` and the paths.
   - `rights`: `kind: "rights", accepted: true` only when the user explicitly confirms they
     hold the rights.
   - `voiceover`: `kind: "voiceover"` with `accepted` as the user decides.
   - `spend` and `permission` (`answerable: false`): you cannot answer these. Tell the user to
     approve or deny them in the Videoclaw window.
3. **Review.** `videoclaw_get_job` lists numbered versions and other outputs as local paths.
   Open stills to look at them. Send feedback with `videoclaw_send_message`.
4. **Approve.** `videoclaw_approve_version` when the user approves a version.
5. **Share.** `videoclaw_share` uploads a version and returns a link. Only share when the user
   asks. `videoclaw_revoke_share` stops a link.

## Money

- `videoclaw_get_spend` shows the account's credit and a video's budget and spend.
- Every message makes Videoclaw's agent work, which costs money. Send what the user asks for;
  don't send test or filler messages.
- Change a video's model, effort or mode (`videoclaw_set_agent_settings`) only when the user
  asks. Mode `plan` makes Videoclaw plan before it builds.

## Project setup

- **Taste:** `videoclaw_get_taste` shows the rules that apply: defaults, the user's own rules
  and the project's rules, with proposals Videoclaw suggests from feedback. Ask the user about
  each proposal, then `videoclaw_decide_taste_proposal`. `videoclaw_add_taste_rule` saves a
  rule the user states (with `clientId` for one project, without for all videos).
- **Projects:** `videoclaw_create_client`, `videoclaw_rename_client`.
- **Characters:** list them, look at the sheet image with the user, then approve. Delete only
  when asked. To make a new character, ask Videoclaw in a video's chat.

## If a tool fails

- "busy": a Videoclaw job is running and the app has no DevTools port. Wait until it
  finishes, or ask the user before you call `videoclaw_launch` with `restart: true`, because
  that interrupts the job.
- "doesn't offer the server bridge": Videoclaw is older than 0.2, or an update changed it.
  Tell the user to update Videoclaw or the plugin.
- Videoclaw needs macOS, the app in /Applications, and a signed-in account.
