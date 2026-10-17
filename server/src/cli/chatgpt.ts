// `ae-mcp chatgpt`: HTTP server + public HTTPS tunnel so ChatGPT can connect.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { ensureConfig } from "./setup.js";
import { bold, dim, fail, isWin, warn, which, yellow } from "./util.js";

export function chatgpt(argv: string[]) {
  ensureConfig();
  const cfg = loadConfig();
  const port = String(cfg.httpPort);
  const children: ChildProcess[] = [];
  const cleanup = () => children.forEach((c) => { try { c.kill(); } catch {} });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);

  const srv = spawn(process.execPath, [fileURLToPath(import.meta.url), "--http", "--port", port], { stdio: ["ignore", "inherit", "inherit"] });
  children.push(srv);
  srv.on("exit", (code) => { fail(`MCP server exited (${code})`); process.exit(1); });

  const announce = (base: string) =>
    console.log(`
${bold("ChatGPT connector URL")} (keep it secret, it contains your access token):

  ${yellow(`${base}/mcp/${cfg.token}`)}

In ChatGPT: Settings > Apps & Connectors > Advanced settings > turn on Developer mode,
then Create a connector > paste the URL above > Authentication: "No authentication" > Create.
Keep this window open while you use it. Press Ctrl+C to stop.
`);

  console.log(dim("Tip: the ChatGPT desktop app does not need this; 1. Install connects it directly (Settings > Plugins).\n"));
  if (argv.includes("--local")) return announce(`http://127.0.0.1:${port}`);

  const cloudflared = which("cloudflared") || (isWin ? null : ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"].find((p) => existsSync(p)) ?? null);
  const ngrok = which("ngrok");
  let shown = false;
  if (cloudflared) {
    const t = spawn(cloudflared, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(t);
    const onData = (d: Buffer) => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !shown) { shown = true; announce(m[0]); }
    };
    t.stdout!.on("data", onData);
    t.stderr!.on("data", onData);
    console.log(dim("Starting Cloudflare tunnel..."));
  } else if (ngrok) {
    const t = spawn(ngrok, ["http", port, "--log", "stdout", "--log-format", "json"], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(t);
    t.stdout!.on("data", (d: Buffer) => {
      for (const line of String(d).split("\n")) {
        try {
          const j = JSON.parse(line);
          if (j.url?.startsWith("https") && !shown) { shown = true; announce(j.url); }
        } catch {}
      }
    });
    console.log(dim("Starting ngrok tunnel..."));
  } else {
    warn("ChatGPT needs a public HTTPS address, which needs a free tunnel tool. Install one, then run this again:");
    console.log(`  - cloudflared (no account): ${isWin ? "winget install --id Cloudflare.cloudflared" : "brew install cloudflared"}`);
    console.log("  - or ngrok: https://ngrok.com/download");
    console.log(`\nThe server is running locally at http://127.0.0.1:${port}/mcp (token in ~/.aemcp/config.json).`);
  }
}
