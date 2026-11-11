#!/usr/bin/env node
// Builds videoclaw.mcpb, a Claude Desktop extension (one-file install).
// Run `npm run build` first. Output: release/videoclaw-<version>.mcpb
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const stage = join(root, "release", "mcpb");
const out = join(root, "release", `videoclaw-${pkg.version}.mcpb`);

/** Ask the built server for its tools, so the manifest lists them exactly. */
async function listTools() {
  const p = spawn(process.execPath, [join(root, "dist", "mcp.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const replies = new Map();
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const req = (method, params) =>
    new Promise((resolve) => {
      replies.set(++id, resolve);
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "build", version: "1" } });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const { result } = await req("tools/list", {});
  p.kill();
  return result.tools.map((t) => ({ name: t.name, description: t.description.split(/(?<=\.) /)[0] }));
}

const tools = await listTools();

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "server"), { recursive: true });
cpSync(join(root, "dist", "mcp.mjs"), join(stage, "server", "mcp.mjs"));
cpSync(join(root, "README.md"), join(stage, "README.md"));
cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));

const manifest = {
  manifest_version: "0.2",
  name: "videoclaw",
  display_name: "Videoclaw (unofficial)",
  version: pkg.version,
  description: "Drive the Videoclaw desktop app from Claude: create videos, track long builds, approve and share versions.",
  long_description:
    "Unofficial. Not made or supported by Videoclaw. Creates Videoclaw videos, sends briefs, replies and files, " +
    "tracks long-running builds, answers question cards, approves versions and makes share links. It drives the " +
    "Videoclaw app on this Mac, so auth, billing, budgets, taste and approvals stay inside Videoclaw. Spend and " +
    "permission approvals are never answered from Claude. Needs macOS and Videoclaw 0.2 or newer.",
  author: { name: "Maxine" },
  homepage: pkg.homepage,
  repository: { type: "git", url: "https://github.com/klovr-co/videoclaw-plugin.git" },
  support: pkg.bugs?.url ?? `${pkg.homepage}/issues`,
  license: "MIT",
  keywords: ["videoclaw", "video", "mcp"],
  server: {
    type: "node",
    entry_point: "server/mcp.mjs",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/mcp.mjs"],
      // Claude Desktop starts servers with a short PATH; these hold pgrep, open, osascript and sqlite3.
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    },
  },
  tools,
  compatibility: {
    platforms: ["darwin"],
    runtimes: { node: ">=22.0.0" },
  },
};
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const mcpb = ["-y", "@anthropic-ai/mcpb@2.1.2"];
execFileSync("npx", [...mcpb, "validate", join(stage, "manifest.json")], { stdio: "inherit" });
rmSync(out, { force: true });
execFileSync("npx", [...mcpb, "pack", stage, out], { stdio: "inherit" });
console.log(`\n${out}`);
