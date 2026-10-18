// The MCP server itself: every tool, resource and prompt (no transport; see index.ts).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "./config.js";
import { EXTENDSCRIPT_DOC, INSTRUCTIONS } from "./docs.js";
import { registerCoreTools } from "./tools/core.js";
import { registerRenderJobs } from "./tools/renderjobs.js";
import { registerWorkflowTools } from "./tools/workflow.js";
import { registerOnDemandTools } from "./tools/ondemand.js";
import { registerJsxTools } from "./tools/registry.js";
import { ALL_JSX_TOOLS } from "./tools/all.js";
import { applyProfile, resolveProfile, type ToolProfile } from "./tools/profile.js";

export function createMcpServer(profile: ToolProfile = resolveProfile()): McpServer {
  const instructions =
    INSTRUCTIONS +
    (profile.name === "full"
      ? ""
      : "\n- This chat has the core tools loaded. Many more (3D, audio, text styling, footage, render settings, masks, Essential Graphics, " +
        "project management...) are available on demand: ae_tools lists them, ae_tools {describe: [...]} gives parameters, ae_call runs them. " +
        "ae_run_script can do anything else.");
  const server = new McpServer({ name: "after-effects", title: "Adobe After Effects", version: VERSION }, { instructions });
  const catalog = applyProfile(server, profile);
  registerCoreTools(server);
  registerJsxTools(server, ALL_JSX_TOOLS);
  registerRenderJobs(server);
  registerWorkflowTools(server);
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: "text", text: EXTENDSCRIPT_DOC }] }),
  );
  registerOnDemandTools(server, catalog); // last: the catalog is complete by now
  server.registerPrompt(
    "after-effects-assistant",
    { title: "After Effects assistant", description: "Primes the model with how to work with this server." },
    async () => ({ messages: [{ role: "user", content: { type: "text", text: INSTRUCTIONS + "\n\n" + EXTENDSCRIPT_DOC } }] }),
  );
  return server;
}
