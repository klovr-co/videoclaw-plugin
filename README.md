# videoclaw

> **Unofficial.** This plugin is not made or supported by Videoclaw. It calls the Videoclaw
> desktop app's internal functions, which are not a public API, so a Videoclaw update can break
> it until this plugin is updated.

A Claude Code plugin, MCP server and CLI for the Videoclaw desktop app. It creates video
sessions, sends briefs and replies, tracks long-running builds and fetches renders.

It drives the Videoclaw app on the same Mac. It reads the address of the app's local server
through the app's DevTools port, then calls the same server methods the app's own window
calls, so auth, billing, budgets, taste and approvals all stay inside Videoclaw.

Videoclaw calls a client a **project** and a chat session a **video**. The tools keep the
names `clientId` (a project's id or name, such as `Hover`) and `sessionId` (a video's id).

## Requirements (on each Mac)

- macOS, with Videoclaw 0.2 or newer installed in /Applications and signed in
- Node 22 or newer

Videoclaw 0.2 rebuilt the app's internals. Plugin 0.4 works with Videoclaw 0.2 and newer; for
Videoclaw 0.1, use plugin 0.3.1.

## Install (Claude Code)

    /plugin marketplace add klovr-co/videoclaw-plugin
    /plugin install videoclaw@videoclaw-tools

Or in one step on Claude Code 2.1.275 or later:

    /plugin install videoclaw --marketplace klovr-co/videoclaw-plugin

Start a new session after you install it. You get the `videoclaw_*` tools and a
`videoclaw` skill that teaches the agent the start-then-check flow for long builds.

To update:

    claude plugin update videoclaw@videoclaw-tools

Then restart Claude Code.

## Install (Claude Desktop)

Claude Desktop does not use Claude Code plugins. Add the MCP server and the skill separately.
The server runs from npm with `npx`, so Claude Desktop gets the newest version each time it
starts.

1. Find the folder that holds Node. Claude Desktop does not use your Terminal's `PATH`, so you
   give it the path yourself:

       dirname "$(which node)"        # for example /opt/homebrew/bin

2. Open `~/Library/Application Support/Claude/claude_desktop_config.json` (Claude Desktop →
   Settings → Developer → Edit Config). Add `videoclaw` inside `mcpServers`. Keep any servers
   that are already there. Replace `/opt/homebrew/bin` with the folder from step 1, in both
   places:

   ```json
   {
     "mcpServers": {
       "videoclaw": {
         "command": "/opt/homebrew/bin/npx",
         "args": ["-y", "videoclaw-mcp@latest"],
         "env": { "PATH": "/opt/homebrew/bin:/usr/bin:/bin" }
       }
     }
   }
   ```

   The `env` line is required. Without it the server stops with `env: node: No such file or
   directory`.

3. Quit Claude Desktop with Cmd+Q and open it again. It reads the config only at startup.
   `videoclaw` then shows in the tools menu of a chat. Claude Desktop asks you to allow each
   tool the first time it is used.

4. Optional, but recommended: add the skill, so Claude starts long builds and checks back
   instead of waiting on one call. Download
   [`skills/videoclaw/SKILL.md`](skills/videoclaw/SKILL.md), put it in a folder named
   `videoclaw`, and zip that folder:

       mkdir -p ~/Desktop/videoclaw && curl -fsSL -o ~/Desktop/videoclaw/SKILL.md \
         https://raw.githubusercontent.com/klovr-co/videoclaw-plugin/main/skills/videoclaw/SKILL.md
       cd ~/Desktop && zip -r videoclaw-skill.zip videoclaw

   Then in Claude Desktop: Settings → Capabilities → Skills → Upload, and pick
   `videoclaw-skill.zip`.

**Updates:** the server updates itself. Each time Claude Desktop starts, `npx` checks npm for
the newest `videoclaw-mcp`. The skill does not update itself; download and upload it again when
the release notes say it changed.

## Other MCP clients (Tag bots, Cursor, Codex)

Use the same `npx` command, with the `env` line when the client is an app rather than a
terminal:

    { "mcpServers": { "videoclaw": { "command": "/opt/homebrew/bin/npx", "args": ["-y", "videoclaw-mcp@latest"], "env": { "PATH": "/opt/homebrew/bin:/usr/bin:/bin" } } } }

For a Tag bot, put that in a `.mcp.json` in the bot's folder.

To pin a version instead of updating, replace `videoclaw-mcp@latest` with, for example,
`videoclaw-mcp@0.4.0`. To run from a clone instead of npm, use
`"command": "/opt/homebrew/bin/node", "args": ["/path/to/videoclaw-plugin/dist/mcp.mjs"]`.

## CLI

    npx -y --package=videoclaw-mcp vc --help     # or: npm i -g videoclaw-mcp, then `vc --help`
    vc new --client Hover "make a 30s video about ..." --file ~/footage/clip.mp4
    vc status <sessionId> --wait 3
    vc job <sessionId>
    vc share <sessionId>

## How it stays connected

Videoclaw has to run with `--remote-debugging-port` (default 9339, override with
`VIDEOCLAW_CDP_PORT`). The plugin uses the port only to read the address and secret of the
app's local server. Every command checks the port first:

- Videoclaw closed → it starts Videoclaw with the port.
- Videoclaw open without the port (after an update or a Dock launch) and idle → it restarts
  Videoclaw with the port.
- Videoclaw open without the port and a job running → it refuses, so the job isn't
  interrupted. It reads the app's database (read-only) to tell.

Set `VIDEOCLAW_AUTO_LAUNCH=0` to turn this off.

## Notes

- Spend and permission approvals are never answered from here. They show in the Videoclaw
  window.
- While the port is open, any local process can control Videoclaw. It only listens on
  127.0.0.1.
- This uses Videoclaw's internal server methods (`createVideo`, `send`, `watchVideo`, ...).
  A Videoclaw update could rename them.

## Changes in 0.4.0

Rewritten for Videoclaw 0.2.

- Projects and videos have new ids. `clientId` also accepts a project's name.
- Files you attach are listed in the message, the same way the app's composer does it.
- A message sent while Videoclaw is working is queued, and sent when the turn ends.
- New tools: `videoclaw_rename_session`, `videoclaw_set_agent_settings`.
- Removed, because Videoclaw 0.2 has no methods for them: plan cards (use
  `videoclaw_set_agent_settings` with mode `plan`; plans now come as questions), revert and
  reopen, project memory, the media library, templates, voices, and creating characters or
  sheets (ask Videoclaw in a chat). Taste proposals are now part of `videoclaw_get_taste`.

## Develop

    npm install
    npm run build     # rebuilds dist/ from src/ and bin/; commit dist/

To release: bump the version in `package.json` and `.claude-plugin/plugin.json`, build, commit,
push, then `npm publish`.

## License

MIT. See [LICENSE](LICENSE).
