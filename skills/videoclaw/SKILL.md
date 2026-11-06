---
name: videoclaw
description: Make or edit videos with the Videoclaw desktop app through the videoclaw MCP tools. Use when the user asks to create, edit, check on, or fetch a video from Videoclaw, or mentions a Videoclaw session, job, render, client/project, taste pack or character.
---

# Videoclaw

Videoclaw is a desktop app on this Mac that makes videos with its own agent. The
`videoclaw_*` tools talk to that app. They start or reconnect it automatically.

## Video builds are slow

One Videoclaw turn can take 30 minutes or more. Never wait for a build in one call.

1. Start: `videoclaw_create_session` (new video) or `videoclaw_send_message` (reply in an
   existing session). Both return at once.
2. Tell the user it has started, and give the session ID.
3. Check: `videoclaw_check_progress`. It waits at most a few minutes.
   - `done: false` → report the progress in `reply`, then stop. Check again when the user asks.
   - `done: true` → report the reply and any `renders` paths.
4. Do not call `videoclaw_check_progress` in a loop for more than about 10 minutes in total.

## Choose the project

Call `videoclaw_list_clients` and pass the matching `clientId` when you create a session.
The client decides the taste pack and media library. Ask the user if the project is unclear.

## Write the brief

- Give absolute paths for every source file.
- Name saved characters with their exact saved name (for example "Maxine Hebe"). Videoclaw
  attaches a character only when the message contains its name as a whole word.
- Say the format you want: aspect ratio, length, captions, voice or no voice.

## Answer what Videoclaw asks

- Videoclaw often replies with a plan first. Show the plan to the user. Send their answer, or
  "build it" when they approve, with `videoclaw_send_message`.
- `waitingOnUser` lists spend approvals and questions. The user answers those in the
  Videoclaw window. You cannot approve spend.

## Other tools

- `videoclaw_get_job`: the job folder, renders and other outputs as local paths. Open
  stills or sheets to review them.
- `videoclaw_get_history`: the full transcript of a session.
- `videoclaw_get_taste`: which taste layers apply to a client.
- `videoclaw_interrupt`: stop the current turn.

## If a tool fails

- "busy": a Videoclaw job is running and the app has no DevTools port. Wait until it
  finishes, or ask the user before you call `videoclaw_launch` with `restart: true`, because
  that interrupts the job.
- Videoclaw needs macOS, the app in /Applications, and a signed-in account.
