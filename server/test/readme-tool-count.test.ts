import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CORE_TOOLS } from "../src/tools/profile.js";
import { registeredTools } from "./registered-tools.js";

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
