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
import { projectTools } from "./tools/project.js";
import { propertyTools } from "./tools/property.js";
import { registerJsxTools } from "./tools/registry.js";
import { renderTools } from "./tools/render.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "after-effects", title: "Adobe After Effects", version: VERSION }, { instructions: INSTRUCTIONS });
  registerCoreTools(server);
  registerJsxTools(server, [...projectTools, ...compTools, ...layerTools, ...propertyTools, ...effectTools, ...renderTools, ...appTools]);
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

async function main() {
  if (process.argv.includes("--version")) return void console.log(VERSION);
  if (process.argv.includes("--help")) {
    console.log(`ae-mcp v${VERSION} - MCP server for Adobe After Effects

Usage:
  ae-mcp                 stdio transport (Claude Desktop, Claude Code, Cursor...)
  ae-mcp --http [--port 8766] [--host 127.0.0.1] [--no-auth]
                         Streamable HTTP transport at /mcp (ChatGPT via a tunnel)

Config: ~/.aemcp/config.json  (env: AEMCP_CONFIG, AEMCP_BRIDGE_PORT, AEMCP_TOKEN, AEMCP_HTTP_PORT, AEMCP_HTTP_TOKEN)`);
    return;
  }
  if (process.argv.includes("--http")) return startHttp();
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
