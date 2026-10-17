// Builds the shareable release: dist-zip/AE-MCP/ (+ AE-MCP-<version>.zip) containing the
// launchers, the single-file server, and AE-MCP.mcpb (one-click Claude Desktop extension).
// Usage: npm run package
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(SERVER, "..");
const pkg = JSON.parse(readFileSync(join(SERVER, "package.json"), "utf8"));
const OUT_BASE = join(ROOT, "dist-zip");
const OUT = join(OUT_BASE, "AE-MCP");
const STAGE = join(OUT_BASE, ".mcpb-stage");
const bundle = join(SERVER, "dist", "ae-mcp.mjs");
const run = (cmd, args, cwd = SERVER) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

run(process.execPath, ["build.mjs"]);

// tool list for the .mcpb manifest, straight from the server
const client = new Client({ name: "package", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [bundle], env: { ...process.env, AEMCP_NO_AUTOSETUP: "1" } }));
const { tools } = await client.listTools();
await client.close();

rmSync(OUT_BASE, { recursive: true, force: true });

// --- Claude Desktop extension (.mcpb) ---
mkdirSync(join(STAGE, "server"), { recursive: true });
copyFileSync(bundle, join(STAGE, "server", "ae-mcp.mjs"));
copyFileSync(join(SERVER, "assets", "icon.png"), join(STAGE, "icon.png"));
const manifest = {
  manifest_version: "0.3",
  name: "after-effects",
  display_name: "After Effects MCP",
  version: pkg.version,
  description: "Control Adobe After Effects: run ExtendScript, build comps, animate, apply effects and preview frames.",
  long_description:
    "Lets Claude drive a running Adobe After Effects on this computer. Claude can run any ExtendScript (JSX) and read the results, " +
    "and use 58 tools for projects, compositions, layers, keyframes, expressions, effects, shapes, masks, the render queue and frame previews it can look at.\n\n" +
    "**First run:** the extension installs a small companion extension into After Effects automatically. Restart After Effects once afterwards. " +
    "Everything runs locally; nothing is sent anywhere except to Claude.",
  author: { name: "Rony Itzhaki" },
  icon: "icon.png",
  server: {
    type: "node",
    entry_point: "server/ae-mcp.mjs",
    mcp_config: { command: "node", args: ["${__dirname}/server/ae-mcp.mjs"], env: {} },
  },
  tools: tools.map((t) => ({ name: t.name, description: (t.description || "").split("\n")[0].slice(0, 300) })),
  keywords: ["after effects", "adobe", "extendscript", "jsx", "motion graphics", "animation", "video"],
  license: "MIT",
  compatibility: { platforms: ["darwin", "win32"], runtimes: { node: ">=18.0.0" } },
};
writeFileSync(join(STAGE, "manifest.json"), JSON.stringify(manifest, null, 2));
const mcpbCli = join(SERVER, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
run(process.execPath, [mcpbCli, "validate", join(STAGE, "manifest.json")]);
mkdirSync(OUT, { recursive: true });
run(process.execPath, [mcpbCli, "pack", STAGE, join(OUT, "AE-MCP.mcpb")]);
rmSync(STAGE, { recursive: true, force: true });

// --- launchers + server for the script installer ---
for (const f of readdirSync(ROOT)) if (/\.(command|bat)$/.test(f)) copyFileSync(join(ROOT, f), join(OUT, f));
cpSync(join(ROOT, "installer"), join(OUT, "installer"), { recursive: true });
mkdirSync(join(OUT, "server", "dist"), { recursive: true });
copyFileSync(bundle, join(OUT, "server", "dist", "ae-mcp.mjs"));
copyFileSync(join(ROOT, "README.md"), join(OUT, "README.md"));
copyFileSync(join(ROOT, "INSTALL.txt"), join(OUT, "INSTALL.txt"));
for (const f of readdirSync(OUT)) if (f.endsWith(".command")) chmodSync(join(OUT, f), 0o755);
chmodSync(join(OUT, "installer", "run.sh"), 0o755);

// --- zip (keeps the executable bits on the macOS launchers) ---
const zip = `AE-MCP-${pkg.version}.zip`;
if (process.platform === "darwin") run("ditto", ["-c", "-k", "--keepParent", "AE-MCP", zip], OUT_BASE);
else if (process.platform === "win32")
  run("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path AE-MCP -DestinationPath ${zip} -Force`], OUT_BASE);
else run("zip", ["-qr", zip, "AE-MCP"], OUT_BASE);
console.log(`\nRelease ready:\n  ${OUT}\n  ${join(OUT_BASE, zip)}`);
