# videoclaw

> **Unofficial.** This plugin is not made or supported by Videoclaw. It calls the Videoclaw
> desktop app's internal functions, which are not a public API, so a Videoclaw update can break
> it until this plugin is updated.

A Claude Code plugin, MCP server and CLI for the Videoclaw desktop app. It creates video
sessions, sends briefs and replies, tracks long-running builds and fetches renders.

It drives the Videoclaw app on the same Mac through the app's DevTools port. It calls the
same functions the app's own UI uses, so auth, billing, budgets, taste and approvals all
stay inside Videoclaw.

## Requirements (on each Mac)

- macOS, with Videoclaw installed in /Applications and signed in
- Node 22 or newer

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

1. Download the plugin. The repo includes the built server, so you don't need `npm install`:

       git clone https://github.com/klovr-co/videoclaw-plugin ~/videoclaw-plugin

2. Find the full path to Node. Claude Desktop does not use your Terminal's `PATH`, so a bare
   `node` may not start:

       which node        # for example /opt/homebrew/bin/node

3. Open `~/Library/Application Support/Claude/claude_desktop_config.json` (Claude Desktop →
   Settings → Developer → Edit Config). Add `videoclaw` inside `mcpServers`. Keep any servers
   that are already there. Use your Node path and your home folder:

   ```json
   {
     "mcpServers": {
       "videoclaw": {
         "command": "/opt/homebrew/bin/node",
         "args": ["/Users/YOU/videoclaw-plugin/dist/mcp.mjs"]
       }
     }
   }
   ```

4. Quit Claude Desktop with Cmd+Q and open it again. It reads the config only at startup.
   `videoclaw` then shows in the tools menu of a chat. Claude Desktop asks you to allow each
   tool the first time it is used.

5. Optional, but recommended: add the skill, so Claude starts long builds and checks back
   instead of waiting on one call.

       cd ~/videoclaw-plugin/skills && zip -r ~/Desktop/videoclaw-skill.zip videoclaw

   Then in Claude Desktop: Settings → Capabilities → Skills → Upload, and pick
   `videoclaw-skill.zip`.

To update, pull the repo and restart Claude Desktop:

    cd ~/videoclaw-plugin && git pull

If the skill changed, zip and upload it again. Claude Desktop does not update either part by
itself.

## Other MCP clients (Tag bots, Cursor, Codex)

Clone the repo as above, then point the client at the bundled server. Use the full path to
Node if the client is an app rather than a terminal:

    { "mcpServers": { "videoclaw": { "command": "/opt/homebrew/bin/node", "args": ["/path/to/videoclaw-plugin/dist/mcp.mjs"] } } }

For a Tag bot, put that in a `.mcp.json` in the bot's folder. To update, `git pull` the repo.

## CLI

    node dist/vc.mjs --help        # or: npm link, then `vc --help`
    vc new --client hover "make a 30s video about ..."
    vc status <sessionId> --wait 3
    vc job <sessionId>

## How it stays connected

Videoclaw has to run with `--remote-debugging-port` (default 9339, override with
`VIDEOCLAW_CDP_PORT`). Every command checks the port first:

- Videoclaw closed → it starts Videoclaw with the port.
- Videoclaw open without the port (after an update or a Dock launch) and idle → it restarts
  Videoclaw with the port.
- Videoclaw open without the port and a job running → it refuses, so the job isn't
  interrupted.

Set `VIDEOCLAW_AUTO_LAUNCH=0` to turn this off.

## Notes

- Spend approvals are never answered from here. They show in the Videoclaw window.
- While the port is open, any local process can control Videoclaw. It only listens on
  127.0.0.1.
- This uses Videoclaw's internal functions (`createSession`, `sendMessage`, `getHistory`,
  ...). A Videoclaw update could rename them.

## Develop

    npm install
    npm run build     # rebuilds dist/ from src/ and bin/; commit dist/

## License

MIT. See [LICENSE](LICENSE).
