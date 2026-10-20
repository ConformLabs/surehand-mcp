// `surehand-ae chatgpt`: HTTP server + public HTTPS tunnel so ChatGPT on the web can connect.
//
//   chatgpt [--local]             in this window (Ctrl+C stops it); prints the connector URL
//   chatgpt --background --json   for the panel: starts it as a detached process group that outlives the
//                                 panel (or reuses the running one), prints {ok, state} and exits
//   chatgpt --status --json       {ok, state: "starting"|"running"|"needs-tunnel"|"error"|"stopped", url?, ...}
//   chatgpt --stop --json         stops it (the whole process group) and removes the status file
//   chatgpt --install-tunnel [--json]   downloads Cloudflare's cloudflared (pinned, verified) into ~/.surehand/bin
//                                 (tunnel-install.ts): {ok, path?, version?, already?, error?}
//
// The background one is a small supervisor (`chatgpt --supervise`) that runs the HTTP server and the tunnel
// (cloudflared, else ngrok) as its children and keeps ~/.surehand/ae/chatgpt.json up to date:
// {state, url?, pid, startedAt, tunnel?, error?}. The URL contains the access token: the file is readable
// only by the user, and the URL is printed only by --status / --background (for the panel), never logged.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, existsSync, openSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { readJsonFile, sleepSync, writeFileAtomic } from "../fsutil.js";
import { appFile, env } from "../paths.js";
import { ensureConfig } from "./setup.js";
import { CLOUDFLARED_VERSION, cloudflaredPath, installCloudflared } from "./tunnel-install.js";
import { bold, dim, fail, isWin, warn, which, yellow } from "./util.js";

export type ChatgptState = "starting" | "running" | "needs-tunnel" | "error" | "stopped";
export interface ChatgptStatus {
  state: ChatgptState;
  url?: string;
  pid?: number;
  startedAt?: string;
  tunnel?: "cloudflared" | "ngrok";
  error?: string;
}

export const chatgptStatusFile = () => appFile("chatgpt.json");
const lockFile = () => appFile("chatgpt.lock");
const self = () => fileURLToPath(import.meta.url);
/** How long the tunnel may take to give an address. */
const START_TIMEOUT_MS = 60_000;

export const CLOUDFLARED_INSTALL = isWin ? "winget install --id Cloudflare.cloudflared" : "brew install cloudflared";

/**
 * cloudflared (no account needed), else ngrok; null when neither is installed. cloudflared: on the PATH, in
 * Homebrew's folders, else the copy `chatgpt --install-tunnel` put in ~/.surehand/bin.
 */
export function tunnelTool(): { kind: "cloudflared" | "ngrok"; path: string } | null {
  // Homebrew's folders aren't always on the PATH of a program started by After Effects
  const extra = isWin || env("TUNNEL_PATH_ONLY") ? [] : ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"];
  if (!env("TUNNEL_PATH_ONLY")) extra.push(cloudflaredPath());
  const cloudflared = which("cloudflared") || extra.find((p) => existsSync(p)) || null;
  if (cloudflared) return { kind: "cloudflared", path: cloudflared };
  const ngrok = which("ngrok");
  return ngrok ? { kind: "ngrok", path: ngrok } : null;
}

function readStatusFile(): ChatgptStatus | null {
  const r = readJsonFile<ChatgptStatus>(chatgptStatusFile());
  return r.ok && r.data && typeof r.data === "object" ? r.data : null;
}

function writeStatus(s: ChatgptStatus) {
  const file = chatgptStatusFile();
  writeFileAtomic(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  if (!isWin) {
    try {
      chmodSync(file, 0o600); // the URL in it contains the access token
    } catch {}
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** The process is our supervisor (not an unrelated one that got its number after a restart). */
function isSupervisor(pid: number): boolean {
  if (!alive(pid)) return false;
  if (isWin) return true;
  const r = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
  if (r.error) return true; // no ps: trust the number
  return /chatgpt/.test(r.stdout || "") && /--supervise/.test(r.stdout || "");
}

/** The status, checked against the process: a file whose process is gone says "stopped". */
export function chatgptStatus(): ChatgptStatus {
  const s = readStatusFile();
  if (!s || !s.state) return { state: "stopped" };
  if (s.state === "starting" || s.state === "running") return s.pid && isSupervisor(s.pid) ? s : { state: "stopped" };
  // a tunnel tool installed since the last try
  if (s.state === "needs-tunnel" && tunnelTool()) return { state: "stopped" };
  return s;
}

/** For the panel: the status plus what it needs to show it. */
function statusJson(s: ChatgptStatus, extra: Record<string, unknown> = {}) {
  return {
    ok: s.state !== "error" && s.state !== "needs-tunnel",
    ...s,
    ...(s.state === "needs-tunnel" ? { installCommand: CLOUDFLARED_INSTALL } : {}),
    ...extra,
  } as { ok: boolean; reused?: boolean; installCommand?: string } & ChatgptStatus;
}

/** Starts the background one (or finds the running one). Never two at once. */
export function startBackground(): ReturnType<typeof statusJson> {
  ensureConfig();
  const cur = chatgptStatus();
  if (cur.state === "starting" || cur.state === "running") return statusJson(cur, { reused: true });
  if (!tunnelTool()) {
    const s: ChatgptStatus = { state: "needs-tunnel", startedAt: new Date().toISOString() };
    writeStatus(s);
    return statusJson(s);
  }
  // two starts at the same moment (two panels): only one gets the lock
  let fd: number;
  try {
    fd = openSync(lockFile(), "wx");
  } catch {
    let age = Infinity;
    try {
      age = Date.now() - statSync(lockFile()).mtimeMs;
    } catch {}
    if (age < 15_000) return statusJson({ state: "starting" }, { reused: true });
    try {
      unlinkSync(lockFile());
    } catch {}
    return startBackground();
  }
  try {
    const child = spawn(process.execPath, [self(), "chatgpt", "--supervise"], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
    child.unref();
    const s: ChatgptStatus = { state: "starting", pid: child.pid, startedAt: new Date().toISOString() };
    writeStatus(s);
    return statusJson(s);
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockFile());
    } catch {}
  }
}

/** Kills a process and everything it started. */
function killTree(pid: number) {
  if (isWin) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig); // the whole process group (the supervisor is its leader)
    } catch {
      try {
        process.kill(pid, sig);
      } catch {}
    }
  };
  signal("SIGTERM");
  for (let i = 0; i < 30 && alive(pid); i++) sleepSync(100);
  signal("SIGKILL"); // whatever is left in the group
  for (let i = 0; i < 20 && alive(pid); i++) sleepSync(50);
}

export function stopBackground(): { ok: boolean; state: "stopped"; stopped: boolean } {
  const s = readStatusFile();
  let stopped = false;
  if (s?.pid && isSupervisor(s.pid)) {
    killTree(s.pid);
    stopped = true;
  }
  // after the processes are gone, so nothing writes the file again
  try {
    unlinkSync(chatgptStatusFile());
  } catch {}
  return { ok: true, state: "stopped", stopped };
}

/** The detached supervisor: runs the server and the tunnel, writes the status, and stops both together. */
function supervise() {
  const cfg = loadConfig();
  const port = String(cfg.httpPort);
  const base = { pid: process.pid, startedAt: new Date().toISOString() };
  const children: ChildProcess[] = [];
  let done = false;
  const killAll = () => children.forEach((c) => { try { c.kill(); } catch {} });
  const finish = (s: ChatgptStatus | null, code: number) => {
    if (done) return;
    done = true;
    if (s) {
      try {
        writeStatus(s);
      } catch {}
    }
    killAll();
    setTimeout(() => process.exit(code), 200);
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => finish(null, 0));
  process.on("exit", killAll);

  const tool = tunnelTool();
  if (!tool) return finish({ state: "needs-tunnel", startedAt: base.startedAt }, 0);
  writeStatus({ state: "starting", ...base, tunnel: tool.kind });

  const srv = spawn(process.execPath, [self(), "--http", "--port", port], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  children.push(srv);
  let srvLast = "";
  srv.stderr!.on("data", (d: Buffer) => {
    const text = String(d);
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length) srvLast = lines[lines.length - 1].slice(0, 200);
    if (/EADDRINUSE/.test(text)) srvLast = `port ${port} is already in use; is \`surehand-ae chatgpt\` running in a terminal window?`;
  });
  srv.on("exit", (code) => finish({ state: "error", ...base, tunnel: tool.kind, error: `The Surehand server stopped (${srvLast || `exit code ${code}`}).` }, 1));

  // "running" only once the tunnel gave its address and the local server answers
  let url = "";
  let serverUp = false;
  const ready = () => {
    if (url && serverUp && !done) writeStatus({ state: "running", ...base, tunnel: tool.kind, url });
  };
  const found = (publicBase: string) => {
    if (url || done) return;
    url = `${publicBase}/mcp/${cfg.token}`;
    ready();
  };
  const probe = () => {
    if (done || serverUp) return;
    fetch(`http://127.0.0.1:${port}/health`)
      .then((r) => r.ok)
      .catch(() => false)
      .then((ok) => {
        if (ok) {
          serverUp = true;
          ready();
        } else setTimeout(probe, 200);
      });
  };
  probe();
  let tunnelLast = "";
  const t =
    tool.kind === "cloudflared"
      ? spawn(tool.path, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
      : spawn(tool.path, ["http", port, "--log", "stdout", "--log-format", "json"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  children.push(t);
  const onData = (d: Buffer) => {
    const text = String(d);
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length) tunnelLast = lines[lines.length - 1].slice(0, 200);
    if (tool.kind === "cloudflared") {
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) found(m[0]);
    } else
      for (const line of lines) {
        try {
          const j = JSON.parse(line);
          if (typeof j.url === "string" && j.url.startsWith("https")) found(j.url);
        } catch {}
      }
  };
  t.stdout!.on("data", onData);
  t.stderr!.on("data", onData);
  t.on("error", (e) => finish({ state: "error", ...base, tunnel: tool.kind, error: `${tool.kind} could not start: ${e.message}` }, 1));
  t.on("exit", (code) =>
    finish({ state: "error", ...base, tunnel: tool.kind, error: `${tool.kind} stopped${url ? "" : " before giving an address"} (${tunnelLast || `exit code ${code}`}).` }, 1),
  );
  setTimeout(() => {
    if (!url) finish({ state: "error", ...base, tunnel: tool.kind, error: `${tool.kind} gave no address within a minute. Check the internet connection and try again.` }, 1);
  }, START_TIMEOUT_MS).unref();
}

export function chatgpt(argv: string[]) {
  const json = argv.includes("--json");
  const print = (o: object, text: string) => console.log(json ? JSON.stringify(o) : text);
  if (argv.includes("--supervise")) return supervise();
  if (argv.includes("--install-tunnel")) {
    if (!json) console.log(`Downloading Cloudflare's cloudflared ${CLOUDFLARED_VERSION} (github.com/cloudflare/cloudflared)...`);
    return installCloudflared().then((r) => {
      process.exitCode = r.ok ? 0 : 1;
      print(r, r.ok ? `${r.already ? "Already installed" : "Installed"}: ${r.path}` : `Could not install cloudflared: ${r.error}`);
    });
  }
  if (argv.includes("--status")) {
    const s = statusJson(chatgptStatus());
    return print(s, s.state === "running" ? `Running (${s.tunnel}). Connector URL (keep it private): ${s.url}` : s.state + (s.error ? `: ${s.error}` : ""));
  }
  if (argv.includes("--stop")) {
    const r = stopBackground();
    return print(r, r.stopped ? "Stopped." : "It wasn't running.");
  }
  if (argv.includes("--background")) {
    const r = startBackground();
    // in a terminal the URL isn't printed here: --status shows it
    if (!json) return console.log(r.state === "needs-tunnel" ? `ChatGPT needs a free tunnel tool: ${CLOUDFLARED_INSTALL}` : `${r.reused ? "Already " : ""}${r.state}. The address: surehand-ae chatgpt --status`);
    process.exitCode = r.ok ? 0 : 1;
    return print(r, "");
  }
  foreground(argv);
}

function foreground(argv: string[]) {
  ensureConfig();
  const cfg = loadConfig();
  const port = String(cfg.httpPort);
  const children: ChildProcess[] = [];
  const cleanup = () => children.forEach((c) => { try { c.kill(); } catch {} });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);

  const srv = spawn(process.execPath, [self(), "--http", "--port", port], { stdio: ["ignore", "inherit", "inherit"] });
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

  const tool = tunnelTool();
  let shown = false;
  if (tool?.kind === "cloudflared") {
    const t = spawn(tool.path, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(t);
    const onData = (d: Buffer) => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !shown) { shown = true; announce(m[0]); }
    };
    t.stdout!.on("data", onData);
    t.stderr!.on("data", onData);
    console.log(dim("Starting Cloudflare tunnel..."));
  } else if (tool?.kind === "ngrok") {
    const t = spawn(tool.path, ["http", port, "--log", "stdout", "--log-format", "json"], { stdio: ["ignore", "pipe", "inherit"] });
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
    console.log(`  - cloudflared (no account): ${CLOUDFLARED_INSTALL}`);
    console.log("  - or ngrok: https://ngrok.com/download");
    console.log(`\nThe server is running locally at http://127.0.0.1:${port}/mcp (token in ~/.surehand/ae/config.json).`);
  }
}
