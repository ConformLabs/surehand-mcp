// Every tool name the server registers (core and on demand), without After Effects.
import { registerCoreTools } from "../src/tools/core.js";
import { registerRenderJobs } from "../src/tools/renderjobs.js";
import { registerWorkflowTools } from "../src/tools/workflow.js";
import { registerProveTools } from "../src/tools/prove.js";
import { registerHistoryTools } from "../src/tools/history.js";
import { registerPreflightTools } from "../src/tools/preflight.js";
import { registerReformatTools } from "../src/tools/reformat.js";
import { registerFileTools } from "../src/tools/files.js";
import { registerOnDemandTools } from "../src/tools/ondemand.js";
import { registerJsxTools } from "../src/tools/registry.js";
import { ALL_JSX_TOOLS } from "../src/tools/all.js";
import { applyProfile } from "../src/tools/profile.js";

// Mirrors the registration order in src/index.ts (createMcpServer), minus the server transport.
export function registeredTools(): Set<string> {
  const names = new Set<string>();
  const stub: any = {
    registerTool: (name: string) => void names.add(name),
    registerResource: () => undefined,
    registerPrompt: () => undefined,
  };
  const catalog = applyProfile(stub, { name: "full", allows: () => true });
  registerCoreTools(stub);
  registerJsxTools(stub, ALL_JSX_TOOLS);
  registerRenderJobs(stub);
  registerWorkflowTools(stub);
  registerProveTools(stub);
  registerHistoryTools(stub);
  registerPreflightTools(stub);
  registerReformatTools(stub);
  registerFileTools(stub);
  stub.registerTool("ae_get_scripting_guide", {}, async () => ({}));
  registerOnDemandTools(stub, catalog);
  return names;
}
