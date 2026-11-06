# videoclaw

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

## Other MCP clients (Tag bots, Claude Desktop, Cursor, Codex)

Clone the repo, then point the client at the bundled server:

    { "mcpServers": { "videoclaw": { "command": "node", "args": ["/path/to/repo/dist/mcp.mjs"] } } }

For a Tag bot, put that in a `.mcp.json` in the bot's folder.

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
