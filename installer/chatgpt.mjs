#!/usr/bin/env node
// Starts the MCP server in HTTP mode and exposes it through a public HTTPS tunnel for ChatGPT.
// Uses cloudflared (preferred, no account needed) or ngrok if installed.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, ROOT, SERVER_FILE, bold, dim, fail, isWin, readJson, warn, which, yellow } from "./common.mjs";

const cfg = readJson(CONFIG_FILE, null);
if (!cfg?.token) { fail("Not installed yet: run the installer first."); process.exit(1); }
const server = existsSync(SERVER_FILE) ? SERVER_FILE : join(ROOT, "server", "dist", "ae-mcp.mjs");
const port = String(cfg.httpPort || 8766);
const children = [];
const cleanup = () => { for (const c of children) try { c.kill(); } catch {} };
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);

const srv = spawn(process.execPath, [server, "--http", "--port", port], { stdio: ["ignore", "inherit", "inherit"] });
children.push(srv);
srv.on("exit", (code) => { fail(`MCP server exited (${code})`); process.exit(1); });

const localOnly = process.argv.includes("--local");
const announce = (base) => {
  console.log(`
${bold("ChatGPT connector URL")} (keep it secret, it contains your access token):

  ${yellow(`${base}/mcp/${cfg.token}`)}

In ChatGPT: Settings > Apps & Connectors > Advanced > enable Developer mode,
then Create (connector) > paste the URL above > Authentication: "No authentication" > Create.
Keep this window open while you use it. Press Ctrl+C to stop.
`);
};

if (localOnly) { announce(`http://127.0.0.1:${port}`); }
else {
  const cloudflared = which("cloudflared") || (isWin ? null : ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"].find(existsSync));
  const ngrok = which("ngrok");
  if (cloudflared) {
    const t = spawn(cloudflared, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(t);
    let shown = false;
    const onData = (d) => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !shown) { shown = true; announce(m[0]); }
    };
    t.stdout.on("data", onData);
    t.stderr.on("data", onData);
    console.log(dim("Starting Cloudflare quick tunnel..."));
  } else if (ngrok) {
    const t = spawn(ngrok, ["http", port, "--log", "stdout", "--log-format", "json"], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(t);
    let shown = false;
    t.stdout.on("data", (d) => {
      for (const line of String(d).split("\n")) {
        try { const j = JSON.parse(line); if (j.url && !shown && j.url.startsWith("https")) { shown = true; announce(j.url); } } catch {}
      }
    });
    console.log(dim("Starting ngrok tunnel..."));
  } else {
    warn("No tunnel tool found. ChatGPT needs a public HTTPS URL. Install one of:");
    console.log(`  - cloudflared: ${isWin ? "winget install --id Cloudflare.cloudflared" : "brew install cloudflared"}  (no account needed)`);
    console.log("  - ngrok:       https://ngrok.com/download");
    console.log(`\nThe server is running locally at http://127.0.0.1:${port}/mcp (token in ${CONFIG_FILE}).`);
  }
}
