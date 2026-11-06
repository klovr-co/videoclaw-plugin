---
name: videoclaw
description: Make or edit videos with the Videoclaw desktop app through the videoclaw MCP tools. Use when the user asks to create, edit, check on, approve, share or fetch a video from Videoclaw, or mentions a Videoclaw session, plan, version, render, share link, client/project, taste, project memory, media library, character, voice or template.
---

# Videoclaw

Videoclaw is a desktop app on this Mac that makes videos with its own agent. The
`videoclaw_*` tools talk to that app. They start or reconnect it automatically.

## Video builds are slow

One Videoclaw turn can take 30 minutes or more. Never wait for a build in one call.

1. Start: `videoclaw_create_session` (new video) or `videoclaw_send_message` (reply in an
   existing session). Pass source files in `files` as absolute paths. Both return at once.
2. Tell the user it has started, and give the session ID.
3. Check: `videoclaw_check_progress`. It waits at most a few minutes.
   - `done: false` → report the progress in `reply`, then stop. Check again when the user asks.
   - `done: true` → report the reply, and look at `waitingOnUser` and `renders`.
4. Do not call `videoclaw_check_progress` in a loop for more than about 10 minutes in total.

## The usual flow

1. **Brief.** Pick the project with `videoclaw_list_clients`. Attach the files. Name saved
   characters with their exact saved name (for example "Maxine Hebe"); Videoclaw attaches a
   character only when the message contains its name as a whole word. Say the format: aspect
   ratio, length, captions, voice or no voice.
2. **Plan.** Videoclaw usually proposes a plan first. Read it with `videoclaw_get_plan` and
   show it to the user. Then `videoclaw_choose_plan`:
   - `build` or `preview` only after the user approves.
   - `change` with the user's correction.
3. **Questions.** If `waitingOnUser` is not empty, call `videoclaw_get_pending`.
   - Question cards: show the questions and options, then `videoclaw_answer_question`.
   - File requests: `videoclaw_respond_request` with `kind: "files"`.
   - Rights requests: `kind: "rights"` only when the user explicitly confirms they hold the rights.
   - Spend and permission approvals: you cannot answer these. Tell the user to approve them in
     the Videoclaw window.
4. **Review.** `videoclaw_get_job` lists numbered versions, renders and stills. Open stills
   and sheets to look at them. Send feedback with `videoclaw_send_message`.
5. **Approve.** `videoclaw_approve_version` when the user approves a version.
6. **Share.** `videoclaw_share` uploads a finished version and returns a link. Only share when
   the user asks. `videoclaw_revoke_share` stops a link.

## Money

- `videoclaw_get_spend` shows a video's spend and the account's credit. Read it when the user
  asks about cost.
- Building, previews, `videoclaw_library_sync` and `videoclaw_build_character_sheet` with
  `confirm: true` spend credits. Ask the user first.

## Project setup

- **Taste:** `videoclaw_get_taste` shows the rules that apply. `videoclaw_list_taste_proposals`
  and `videoclaw_decide_taste_proposal` handle rules Videoclaw proposes; ask the user for each.
  `videoclaw_add_taste_rule` saves a rule the user states (`client` = this project, `global` =
  all projects).
- **Project memory:** `videoclaw_get_memory` reads notes. Edit or forget a note only when the
  user asks; `videoclaw_undo_memory` reverses it. To add a note, tell Videoclaw in a session to
  remember it.
- **Clients:** create, rename, and set the library id. Changing a library id points the project
  at different assets and taste; ask first.
- **Media library:** `videoclaw_library_search` finds footage by description.
  `videoclaw_library_add_folder`, then `videoclaw_library_scan` (free), then
  `videoclaw_library_sync` (paid) to index new media.
- **Characters and voices:** list, create from photos, build the sheet (look at the cost with
  `confirm: false` first), look at the sheet image, then approve. Delete only when asked.
- **Templates:** `videoclaw_list_templates`, then `videoclaw_start_template`.

## If a tool fails

- "busy": a Videoclaw job is running and the app has no DevTools port. Wait until it
  finishes, or ask the user before you call `videoclaw_launch` with `restart: true`, because
  that interrupts the job.
- Videoclaw needs macOS, the app in /Applications, and a signed-in account.
