import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerCoreTools } from "../src/tools/core.js";
import { registerRenderJobs } from "../src/tools/renderjobs.js";
import { registerWorkflowTools } from "../src/tools/workflow.js";
import { registerProveTools } from "../src/tools/prove.js";
import { registerHistoryTools } from "../src/tools/history.js";
import { registerPreflightTools } from "../src/tools/preflight.js";
import { registerOnDemandTools } from "../src/tools/ondemand.js";
import { registerJsxTools } from "../src/tools/registry.js";
import { ALL_JSX_TOOLS } from "../src/tools/all.js";
import { applyProfile, CORE_TOOLS } from "../src/tools/profile.js";

// Mirrors the registration order in src/index.ts (createMcpServer), minus the server transport.
function registeredTools(): Set<string> {
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
  stub.registerTool("ae_get_scripting_guide", {}, async () => ({}));
  registerOnDemandTools(stub, catalog);
  return names;
}

const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");

describe("README tool counts match the registry", () => {
  const total = registeredTools().size;

  it("registers a plausible number of tools", () => {
    expect(total).toBeGreaterThan(50);
  });

  it("every 'N ready-made tools' / 'all N' claim equals the registry size", () => {
    const claims = [...README.matchAll(/(?:up to|all)\s+(\d+)(?:\s+ready-made)?(?:\s+tools)?/gi)].map((m) => Number(m[1]));
    expect(claims.length).toBeGreaterThan(0);
    for (const n of claims) expect(n).toBe(total);
  });

  it("the core-set size claim equals CORE_TOOLS", () => {
    const m = README.match(/core set of\s+(\d+)\s+tools/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(CORE_TOOLS.size);
  });
});
