import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "dbg", version: "1" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/ae-mcp.mjs"], stderr: "ignore", env: { ...process.env, AEMCP_NO_ACTIVITY_LOG: "1" } }));
const r = await c.callTool({ name: "ae_run_script", arguments: { report: false, undoGroup: "AE MCP debug", code: process.argv[2] } });
console.log(r.content.map((x) => x.text).join("\n"));
await c.close();
