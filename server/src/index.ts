import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { loadConfig, VERSION } from "./config.js";
import { EXTENDSCRIPT_DOC, INSTRUCTIONS } from "./docs.js";
import { appTools } from "./tools/app.js";
import { compTools } from "./tools/comp.js";
import { registerCoreTools } from "./tools/core.js";
import { effectTools } from "./tools/effects.js";
import { layerTools } from "./tools/layer.js";
import { inspectTools } from "./tools/inspect.js";
import { keyframeTools } from "./tools/keyframes.js";
import { footageTools } from "./tools/footage.js";
import { egpTools, healthTools, textTools } from "./tools/text.js";
import { registerRenderJobs } from "./tools/renderjobs.js";
import { projectTools } from "./tools/project.js";
import { propertyTools } from "./tools/property.js";
import { registerJsxTools } from "./tools/registry.js";
import { renderTools } from "./tools/render.js";
import { ensureAeSetup } from "./cli/setup.js";
import { applyProfile, resolveProfile } from "./tools/profile.js";
import { checkForUpdate } from "./update.js";
// CLI commands are imported statically: lazily imported modules made esbuild initialize shared
// dependencies (zod) too late for the MCP SDK, crashing the bundle at startup.
import { ACTIVITY_FILE, readActivity } from "./activity.js";
import { chatgpt } from "./cli/chatgpt.js";
import { diagnostics } from "./cli/diagnostics.js";
import { install } from "./cli/install.js";
import { selftest } from "./cli/selftest.js";
import { uninstall } from "./cli/uninstall.js";

export function createMcpServer(): McpServer {
  const profile = resolveProfile();
  const instructions =
    INSTRUCTIONS +
    (profile.name === "full"
      ? ""
      : "\n- This is the core tool set. Anything else (render queue, import, project/folder management, masks, markers, fonts, menu commands...) " +
        "is done with ae_run_script. The user can enable every tool by setting \"toolProfile\": \"full\" (AE MCP panel or ~/.aemcp/config.json).");
  const server = new McpServer({ name: "after-effects", title: "Adobe After Effects", version: VERSION }, { instructions });
  applyProfile(server, profile);
  registerCoreTools(server);
  registerJsxTools(server, [...projectTools, ...compTools, ...layerTools, ...propertyTools, ...effectTools, ...renderTools, ...appTools, ...inspectTools, ...keyframeTools, ...footageTools, ...textTools, ...egpTools, ...healthTools]);
  registerRenderJobs(server);
  server.registerResource(
    "extendscript-cheatsheet",
    "aemcp://docs/extendscript",
    { title: "After Effects ExtendScript cheat sheet", description: "API reference and ES3 rules for writing scripts for ae_run_script.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: EXTENDSCRIPT_DOC }] }),
  );
  // Some clients (e.g. ChatGPT) don't surface resources, so expose the doc as a tool too.
  server.registerTool(
    "ae_get_scripting_guide",
    {
      title: "ExtendScript guide",
      description: "Returns the After Effects ExtendScript cheat sheet (ES3 rules, helpers, common match names). Read before writing complex ae_run_script code.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: "text", text: EXTENDSCRIPT_DOC }] }),
  );
  server.registerPrompt(
    "after-effects-assistant",
    { title: "After Effects assistant", description: "Primes the model with how to work with this server." },
    async () => ({ messages: [{ role: "user", content: { type: "text", text: INSTRUCTIONS + "\n\n" + EXTENDSCRIPT_DOC } }] }),
  );
  return server;
}

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
  const token = process.env.AEMCP_HTTP_TOKEN || cfg.token;
  const noAuth = process.argv.includes("--no-auth");
  if (!token && !noAuth) {
    console.error("No token configured (~/.aemcp/config.json). Run the installer, set AEMCP_HTTP_TOKEN, or pass --no-auth (NOT recommended with a tunnel).");
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
    console.error(`AE MCP (HTTP) v${VERSION} listening on http://${host}:${port}/mcp`);
    if (!noAuth) console.error(`Auth: header "Authorization: Bearer <token>" or URL http://${host}:${port}/mcp/<token> (token in ~/.aemcp/config.json)`);
  });
}

const HELP = `ae-mcp v${VERSION} - MCP server for Adobe After Effects

Usage:
  ae-mcp                 run the MCP server over stdio (Claude Desktop, Claude Code, Cursor...)
  ae-mcp [--tools core|full]   core (default, ~20 tools) or every tool
  ae-mcp --http [--port 8766] [--host 127.0.0.1] [--no-auth]
                         run over Streamable HTTP at /mcp (ChatGPT via a tunnel)
  ae-mcp install [--skip-clients] [--no-claude-desktop|--no-claude-code|--no-cursor|--no-codex]
                         install the server + After Effects extension and connect AI apps
  ae-mcp uninstall [--keep-config]
  ae-mcp selftest [--full]  check the installation and the connection to After Effects;
                         --full also runs every major tool and saves a compatibility report
  ae-mcp diagnostics     print a report to paste into a bug report (no secrets)
  ae-mcp activity [n]    the last n tool calls (default 30); full log in ~/.aemcp/activity.jsonl
  ae-mcp chatgpt [--local]
                         HTTP server + public tunnel for ChatGPT
  ae-mcp setup           only install/update the After Effects extension and config

Config: ~/.aemcp/config.json  (env: AEMCP_CONFIG, AEMCP_BRIDGE_PORT, AEMCP_TOKEN, AEMCP_HTTP_PORT, AEMCP_HTTP_TOKEN)`;

/** Make sure the After Effects side is installed/up to date (cheap no-op when it already is). */
function autoSetup() {
  if (process.env.AEMCP_NO_AUTOSETUP) return;
  try {
    const r = ensureAeSetup();
    if (r.extensionInstalled) console.error(`[ae-mcp] After Effects extension ${r.extensionUpdated ? "updated" : "installed"}; restart After Effects to load it.`);
    if (r.errors.length) console.error(`[ae-mcp] setup problems: ${r.errors.join("; ")}`);
  } catch (e) {
    console.error("[ae-mcp] setup failed:", e);
  }
}

async function main() {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);
  if (process.argv.includes("--version")) return void console.log(VERSION);
  if (process.argv.includes("--help") || cmd === "help") return void console.log(HELP);
  switch (cmd) {
    case "install":
      return install(rest);
    case "uninstall":
      return uninstall(rest);
    case "selftest":
    case "test":
      process.exitCode = await selftest(rest.includes("--full"));
      return;
    case "activity": {
            const n = Number(rest[0]) || 30;
      const list = readActivity(n).reverse();
      if (!list.length) return void console.log(`No activity yet (${ACTIVITY_FILE}).`);
      for (const e of list)
        console.log(`${e.at}  ${e.ok ? "ok " : "ERR"}  ${String(e.ms).padStart(6)}ms  ${e.tool}${e.client ? `  [${e.client}]` : ""}  ${e.summary ?? ""}`);
      return void console.log(`\nFull log with arguments and code: ${ACTIVITY_FILE}`);
    }
    case "diagnostics":
      return void console.log(await diagnostics());
    case "chatgpt":
      return chatgpt(rest);
    case "setup": {
      const r = ensureAeSetup({ forceExtension: rest.includes("--force") });
      console.log(JSON.stringify(r, null, 2));
      return;
    }
  }
  autoSetup();
  void checkForUpdate(); // background, cached for a day, silent when offline
  if (process.argv.includes("--http")) return startHttp();
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
