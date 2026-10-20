import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { loadConfig, VERSION } from "./config.js";
import { ensureAeSetup } from "./cli/setup.js";
import { checkForUpdate } from "./update.js";
// CLI commands are imported statically: lazily imported modules made esbuild initialize shared
// dependencies (zod) too late for the MCP SDK, crashing the bundle at startup.
import { activityFile, readActivity } from "./activity.js";
import { chatgpt } from "./cli/chatgpt.js";
import { chatCommand } from "./cli/chat.js";
import { checkpointDiffCommand, checkpointSaveCommand, checkpointsCommand } from "./cli/checkpoints.js";
import { CLIENT_IDS, clientsJson, connectClient, disconnectClient, listClients, moveFromLegacy } from "./cli/clients.js";
import { diagnostics } from "./cli/diagnostics.js";
import { install, reportSkills } from "./cli/install.js";
import { installSkills, skillsStatus, uninstallSkills } from "./cli/skills.js";
import { selftest, selftestJson } from "./cli/selftest.js";
import { updateCommand } from "./cli/update-cmd.js";
import { recordRuntime } from "./cli/setup.js";
import { uninstall } from "./cli/uninstall.js";
import { createMcpServer } from "./server.js";
import { trackSession } from "./sessions.js";
import { noteViewClient } from "./tools/views.js";
import { env, migrationPending, SERVER_NAME } from "./paths.js";
import { migrationLog } from "./migrate.js";
import { movesLegacyBeforeRunning } from "./cli/commands.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function startHttp() {
  const cfg = loadConfig();
  const port = Number(arg("--port") || cfg.httpPort);
  const host = arg("--host") || "127.0.0.1";
  const token = env("HTTP_TOKEN") || cfg.token;
  const noAuth = process.argv.includes("--no-auth");
  if (!token && !noAuth) {
    console.error("No token configured (~/.surehand/ae/config.json). Run the installer, set SUREHAND_AE_HTTP_TOKEN, or pass --no-auth (NOT recommended with a tunnel).");
    process.exit(1);
  }

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://localhost");
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type, mcp-session-id, mcp-protocol-version");
    res.setHeader("access-control-expose-headers", "mcp-session-id");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    if (url.pathname === "/health") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION }));

    // Auth: "Authorization: Bearer <token>" or the token as a path segment (/mcp/<token>) for clients
    // like ChatGPT that can't send custom headers.
    const m = url.pathname.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (!m) return void res.writeHead(404).end("Not found. MCP endpoint is /mcp");
    if (!noAuth) {
      const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const supplied = m[1] ? decodeURIComponent(m[1]) : bearer;
      if (!supplied || !safeEqual(supplied, token)) return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    }
    if (req.method !== "POST")
      return void res.writeHead(405, { allow: "POST" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null }));

    try {
      const body = await readBody(req);
      // the AI app says at initialize whether it shows in-chat views; later requests get fresh servers (tools/views.ts)
      for (const m of Array.isArray(body) ? body : [body]) if ((m as any)?.method === "initialize") noteViewClient((m as any).params?.capabilities);
      // Stateless: a fresh server + transport per request.
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e: any) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(e?.message || e) }, id: null }));
    }
  });
  http.listen(port, host, () => {
    console.error(`Surehand MCP (HTTP) v${VERSION} listening on http://${host}:${port}/mcp`);
    if (!noAuth) console.error(`Auth: header "Authorization: Bearer <token>" or URL http://${host}:${port}/mcp/<token> (token in ~/.surehand/ae/config.json)`);
  });
}

const HELP = `Surehand MCP v${VERSION} for Adobe After Effects (command: surehand-ae; ae-mcp still works)

Usage:
  surehand-ae                 run the MCP server over stdio (Claude Desktop, Claude Code, Cursor...)
  surehand-ae [--tools core|full]   core (default, 29 tools) or every tool
  surehand-ae --http [--port 8766] [--host 127.0.0.1] [--no-auth]
                         run over Streamable HTTP at /mcp (ChatGPT via a tunnel)
  surehand-ae install [--skip-clients] [--no-<app>]
                         install the server + After Effects extension and connect AI apps
                         [--clients <id,id|none>] only these apps   [--tunnel] also get cloudflared
                         (results: ~/.surehand/ae/install-result.json; install --summary prints them)
  surehand-ae uninstall [--keep-config] [--all]   (keeps checkpoints and files that are not ours unless --all)
  surehand-ae selftest [--full]  check the installation and the connection to After Effects;
                         --full also runs every major tool and saves a compatibility report
  surehand-ae test --json     the quick self-test as data: {checks: [{ok, name, message, fix?}]}
  surehand-ae diagnostics     print a report to paste into a bug report (no secrets)
  surehand-ae activity [n]    the last n tool calls (default 30); full log in ~/.surehand/ae/activity.jsonl
  surehand-ae chatgpt [--local]
                         HTTP server + public tunnel for ChatGPT (in this window; Ctrl+C stops it)
  surehand-ae chatgpt --install-tunnel [--json]   download Cloudflare's cloudflared (pinned, verified) into ~/.surehand/bin
  surehand-ae chatgpt --background|--status|--stop [--json]
                         the same in the background (the panel's ChatGPT screen): start, its state and address, stop
  surehand-ae chat --agents --json   the AI agents for the panel's Chat (Codex, Claude Code, Antigravity) and their sign-in
  surehand-ae chat --agent <codex|claude|agy> [--session <id>]
                         one chat turn for the panel: the message as JSON on stdin, events as JSON lines
  surehand-ae chat --connect agy|--disconnect agy   Surehand in Antigravity's MCP servers
  surehand-ae update [--json]  install the latest release over this installation (and the AE extension)
  surehand-ae update --check [--json]   only report: {latest, current, updateAvailable, url, checkedAt, channel, notes}
  surehand-ae update --channel beta|stable [--check]   save the update channel first (beta: pre-releases too;
                         back on stable, a newer beta stays until a newer stable release is out)
  surehand-ae clients [--json]          the AI apps on this computer and whether they are connected
  surehand-ae connect <app> [--json]    connect one: claude-desktop, claude-code, codex, cursor,
                                        vscode, windsurf, lm-studio
  surehand-ae disconnect <app> [--json]
  surehand-ae checkpoints [--json] [--project <path.aep>]      a project's checkpoints (default: the open one)
  surehand-ae checkpoint-diff <id> [--json] [--project <path>]  what changed since a checkpoint (needs After Effects)
  surehand-ae checkpoint-save [--label <text>] [--project <path>] [--json]   save the open project and checkpoint it
  surehand-ae skills [--json]           where the Surehand skills (how AI apps use Surehand well) are installed
  surehand-ae skills install|uninstall [--json]
                         write them for the AI apps found (~/.claude/skills, ~/.agents/skills) and the zips to
                         upload in Claude Desktop chat (~/.surehand/ae/skills), or remove exactly those
  surehand-ae setup           only install/update the After Effects extension, the config and the skills

Files: ~/.surehand/ae (config.json, checkpoints, history...); shared: ~/.surehand/node, ~/.surehand/ffmpeg.
Version 1.3's ~/.aemcp moves there automatically.
Environment (SUREHAND_AE_* or the older AEMCP_* names): SUREHAND_AE_CONFIG, SUREHAND_AE_BRIDGE_PORT, SUREHAND_AE_TOKEN,
  SUREHAND_AE_HTTP_PORT, SUREHAND_AE_HTTP_TOKEN, SUREHAND_AE_TOOLS, SUREHAND_AE_INSTANCE, SUREHAND_AE_NO_UPDATE_CHECK,
  SUREHAND_AE_NO_AUTOSETUP, SUREHAND_AE_NO_ACTIVITY_LOG, SUREHAND_AE_BLOCKED_AFTER_SECONDS, SUREHAND_AE_STARTUP_WAIT_SECONDS`;

/** Make sure the After Effects side is installed/up to date (cheap no-op when it already is). */
function autoSetup() {
  if (env("NO_AUTOSETUP")) return;
  try {
    const r = ensureAeSetup();
    if (r.extensionInstalled) console.error(`[${SERVER_NAME}] After Effects extension ${r.extensionUpdated ? "updated" : "installed"}; restart After Effects to load it.`);
    if (r.errors.length) console.error(`[${SERVER_NAME}] setup problems: ${r.errors.join("; ")}`);
  } catch (e) {
    console.error(`[${SERVER_NAME}] setup failed:`, e);
  }
}

/**
 * A 1.3 installation (~/.aemcp) moves to ~/.surehand/ae: a cheap check once done. Never fails a start.
 * Only where Surehand is about to work (the server's start, setup, connect / disconnect, chatgpt):
 * commands that only read (clients, test, checkpoints, diagnostics, activity...) move nothing and
 * change no settings; they work from wherever the files are and can say the move is pending.
 */
function moveOnStart(quiet: boolean) {
  try {
    const r = moveFromLegacy();
    if (quiet) return;
    if (r.status === "migrated") console.error(`[${SERVER_NAME}] moved ~/.aemcp to ~/.surehand/ae${r.repointed.length ? ` and updated ${r.repointed.join(", ")}` : ""} (log: ${r.log})`);
    else if (r.status === "failed") console.error(`[${SERVER_NAME}] could not move ~/.aemcp to ~/.surehand/ae (${r.error}); working from ~/.aemcp. Log: ${r.log}`);
    else if (r.late?.merged.length || r.late?.adopted.length) console.error(`[${SERVER_NAME}] merged what an older version still wrote into ~/.aemcp (log: ${migrationLog()})`);
  } catch (e) {
    if (!quiet) console.error(`[${SERVER_NAME}] moving ~/.aemcp failed:`, e);
  }
}

async function main() {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);
  if (process.argv.includes("--version")) return void console.log(VERSION);
  if (process.argv.includes("--help") || cmd === "help") return void console.log(HELP);
  const json = rest.includes("--json");
  // the server itself (no command, or only options) and the commands that set things up; install and
  // update move (and report) it themselves; --json output stays clean
  if (movesLegacyBeforeRunning(cmd, rest)) moveOnStart(json);
  const print = (o: unknown, text: string) => console.log(json ? JSON.stringify(o) : text);
  switch (cmd) {
    case "clients": {
      const list = listClients();
      // read-only: a pending move is only reported (the server's next start, or install, does it)
      const pending = migrationPending();
      if (pending && !json) console.log(`(Your files are still in ~/.aemcp: the move to ~/.surehand/ae happens at the server's next start. Log: ${migrationLog()})`);
      return print({ ...clientsJson(), ...(pending ? { migrationPending: true } : {}) }, list.map((c) => `${c.name.padEnd(24)} ${c.id === "chatgpt-web" ? "see `surehand-ae chatgpt`" : !c.installed ? "not installed" : c.configured ? "connected" : "not connected"}${c.note ? ` (${c.note})` : ""}`).join("\n"));
    }
    case "connect":
    case "disconnect": {
      const id = rest.find((a) => !a.startsWith("--"));
      const r = id ? (cmd === "connect" ? connectClient(id) : disconnectClient(id)) : { ok: false, message: `usage: surehand-ae ${cmd} <${CLIENT_IDS.join("|")}> [--json]`, restartHint: null };
      const message = `${r.message}${r.restartHint ? ` ${r.restartHint}` : ""}`;
      print({ ok: r.ok, message }, message);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case "checkpoints":
      process.exitCode = await checkpointsCommand(rest);
      return;
    case "checkpoint-diff":
      process.exitCode = await checkpointDiffCommand(rest);
      return;
    case "checkpoint-save":
      process.exitCode = await checkpointSaveCommand(rest);
      return;
    case "install":
      return install(rest);
    case "uninstall":
      return uninstall(rest);
    case "selftest":
    case "test":
      process.exitCode = json ? await selftestJson() : await selftest(rest.includes("--full"));
      return;
    case "activity": {
            const n = Number(rest[0]) || 30;
      const list = readActivity(n).reverse();
      if (!list.length) return void console.log(`No activity yet (${activityFile()}).`);
      for (const e of list)
        console.log(`${e.at}  ${e.ok ? "ok " : "ERR"}  ${String(e.ms).padStart(6)}ms  ${e.tool}${e.client ? `  [${e.client}]` : ""}  ${e.summary ?? ""}`);
      return void console.log(`\nFull log with arguments and code: ${activityFile()}`);
    }
    case "diagnostics":
      return void console.log(await diagnostics());
    case "chatgpt":
      return chatgpt(rest);
    case "chat":
      process.exitCode = await chatCommand(rest);
      return;
    case "update":
      return updateCommand(rest);
    case "setup": {
      // `update` runs the new server's setup: the skills are updated with it
      const r = ensureAeSetup({ forceExtension: rest.includes("--force") });
      console.log(JSON.stringify({ ...r, skills: installSkills() }, null, 2));
      return;
    }
    case "skills": {
      const sub = rest.find((a) => !a.startsWith("--"));
      if (sub === "install") {
        const r = installSkills();
        if (json) console.log(JSON.stringify({ ok: !r.zipError && !r.targets.some((t) => t.error), ...r }));
        else reportSkills(r);
        process.exitCode = r.zipError || r.targets.some((t) => t.error) ? 1 : 0;
        return;
      }
      if (sub === "uninstall") {
        const removed = uninstallSkills();
        return print({ ok: true, removed }, removed.length ? `Removed:\n${removed.map((p) => `  ${p}`).join("\n")}` : "No Surehand skills were installed.");
      }
      if (sub) {
        print({ ok: false, error: `usage: surehand-ae skills [install|uninstall] [--json]` }, "usage: surehand-ae skills [install|uninstall] [--json]");
        process.exitCode = 2;
        return;
      }
      const s = skillsStatus();
      return print(
        s,
        [
          ...s.targets.map((t) => `${t.dir}  ${t.installed.length ? `${t.installed.length} of ${s.skills.length} installed${t.outdated.length ? ` (${t.outdated.length} outdated)` : ""}` : "not installed"}  (${t.apps.join(", ")})`),
          `${s.zips.dir}  ${s.zips.files.length} of ${s.skills.length} zips (Claude Desktop chat: Customize › Skills › Upload a skill)`,
        ].join("\n"),
      );
    }
  }
  // anything else that isn't an option is a mistake: never start the server (the panel spawns commands and would wait)
  if (cmd && !cmd.startsWith("-")) {
    const error = `Unknown command "${cmd}". Run surehand-ae --help for the list.`;
    if (json) console.log(JSON.stringify({ ok: false, error }));
    else console.error(error);
    process.exitCode = 2;
    return;
  }
  autoSetup();
  recordRuntime();
  void checkForUpdate(); // background, cached for a day, silent when offline
  if (process.argv.includes("--http")) return startHttp();
  const server = createMcpServer();
  trackSession(server);
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
