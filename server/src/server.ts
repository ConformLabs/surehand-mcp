// The MCP server itself: every tool, resource and prompt (no transport; see index.ts).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "./config.js";
import { EXTENDSCRIPT_DOC, serverInstructions } from "./docs.js";
import { registerCoreTools } from "./tools/core.js";
import { registerRenderJobs } from "./tools/renderjobs.js";
import { registerWorkflowTools } from "./tools/workflow.js";
import { registerProveTools } from "./tools/prove.js";
import { registerRenderProfileTools } from "./tools/renderprofile.js";
import { registerSurgeryTools } from "./tools/surgery.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerPreflightTools } from "./tools/preflight.js";
import { registerReformatTools } from "./tools/reformat.js";
import { registerVersionsTools } from "./tools/versions.js";
import { registerLocalizeTools } from "./tools/localize.js";
import { registerStressTools } from "./tools/stress.js";
import { registerFileTools } from "./tools/files.js";
import { registerHandoffTools } from "./tools/handoff.js";
import { registerFarmTools } from "./tools/farm.js";
import { registerOnDemandTools } from "./tools/ondemand.js";
import { registerViews, watchViewClient } from "./tools/views.js";
import { registerJsxTools } from "./tools/registry.js";
import { ALL_JSX_TOOLS } from "./tools/all.js";
import { applyProfile, resolveProfile, type ToolProfile } from "./tools/profile.js";
import { SERVER_NAME } from "./paths.js";

export function createMcpServer(profile: ToolProfile = resolveProfile()): McpServer {
  // with only some tools loaded, the instructions say how to reach the others (ae_tools / ae_call)
  const instructions = serverInstructions(profile.name !== "full");
  const server = new McpServer({ name: SERVER_NAME, title: "Surehand MCP for Adobe After Effects", version: VERSION }, { instructions });
  const catalog = applyProfile(server, profile);
  registerCoreTools(server);
  registerJsxTools(server, ALL_JSX_TOOLS);
  registerRenderJobs(server);
  registerWorkflowTools(server);
  registerProveTools(server);
  registerRenderProfileTools(server);
  registerSurgeryTools(server);
  registerHistoryTools(server);
  registerPreflightTools(server);
  registerReformatTools(server);
  registerVersionsTools(server);
  registerLocalizeTools(server);
  registerStressTools(server);
  registerFileTools(server);
  registerHandoffTools(server);
  registerFarmTools(server);
  registerViews(server); // in-chat views and their app-only tools (on only where the AI app shows views)
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
  watchViewClient(server);
  server.registerPrompt(
    "after-effects-assistant",
    { title: "After Effects assistant", description: "Primes the model with how to work with this server." },
    async () => ({ messages: [{ role: "user", content: { type: "text", text: instructions + "\n\n" + EXTENDSCRIPT_DOC } }] }),
  );
  return server;
}
