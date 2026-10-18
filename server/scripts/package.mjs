// Builds the shareable release: dist-zip/AE-MCP/ (+ AE-MCP-<version>.zip), organised as
//   START HERE.txt, "1. Claude Desktop (easiest)/AE-MCP.mcpb", "2. Mac/", "3. Windows/", "Support files/".
// Usage: npm run package
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// list every tool (the extension's "Enable all tools" setting exposes them all)
await client.connect(new StdioClientTransport({ command: process.execPath, args: [bundle, "--tools", "full"], env: { ...process.env, AEMCP_NO_AUTOSETUP: "1", AEMCP_NO_ACTIVITY_LOG: "1" } }));
const { tools } = await client.listTools();
await client.close();
// every tool carries all four hints (the expected values are in test/annotations.test.ts)
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
const unhinted = tools.filter((t) => HINTS.some((h) => typeof t.annotations?.[h] !== "boolean")).map((t) => t.name);
if (unhinted.length) throw new Error(`Tools without explicit hints: ${unhinted.join(", ")}`);

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
  author: { name: "Ron Yitzhaki", url: "https://github.com/ronyitzhaki" },
  repository: { type: "git", url: "https://github.com/ronyitzhaki/after-effects-mcp" },
  homepage: "https://github.com/ronyitzhaki/after-effects-mcp",
  support: "https://github.com/ronyitzhaki/after-effects-mcp/issues",
  icon: "icon.png",
  server: {
    type: "node",
    entry_point: "server/ae-mcp.mjs",
    mcp_config: { command: "node", args: ["${__dirname}/server/ae-mcp.mjs"], env: { AEMCP_TOOLS: "${user_config.full_toolset}" } },
  },
  user_config: {
    full_toolset: {
      type: "boolean",
      title: "Enable all tools",
      description:
        "Off (recommended): a fast core set of ~20 tools; everything else is still possible through scripts. " +
        "On: all ~60 tools (uses more of Claude's context). Can also be switched in After Effects: Window > Extensions > AE MCP.",
      default: false,
      required: false,
    },
  },
  tools: tools.map((t) => ({ name: t.name, description: (t.description || "").split("\n")[0].slice(0, 300) })),
  keywords: ["after effects", "adobe", "extendscript", "jsx", "motion graphics", "animation", "video"],
  license: "MIT",
  compatibility: { platforms: ["darwin", "win32"], runtimes: { node: ">=18.0.0" } },
};
writeFileSync(join(STAGE, "manifest.json"), JSON.stringify(manifest, null, 2));
const mcpbCli = join(SERVER, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
run(process.execPath, [mcpbCli, "validate", join(STAGE, "manifest.json")]);
// --- folder layout ---
const DIRS = {
  claude: join(OUT, "1. Claude Desktop (easiest)"),
  mac: join(OUT, "2. Mac"),
  win: join(OUT, "3. Windows"),
  support: join(OUT, "Support files"),
};
for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });
run(process.execPath, [mcpbCli, "pack", STAGE, join(DIRS.claude, "AE-MCP.mcpb")]);
rmSync(STAGE, { recursive: true, force: true });

// launchers: one per command and platform, all calling the scripts in "Support files"
const LAUNCHERS = [
  ["1. Install", "install", "Installs AE MCP and connects your AI apps."],
  ["2. Test Installation", "selftest", "Checks that AE MCP is installed and can talk to After Effects."],
  ["3. Connect ChatGPT", "chatgpt", "Connects ChatGPT (local server + secure tunnel). Keep the window open while you use it."],
  ["4. Uninstall", "uninstall", "Removes AE MCP."],
];
for (const [name, cmd, desc] of LAUNCHERS) {
  const mac = join(DIRS.mac, `${name}.command`);
  writeFileSync(mac, `#!/bin/bash\n# ${desc}\nbash "$(dirname "$0")/../Support files/run.sh" ${cmd} "$@"\necho\nread -r -p "Press Enter to close..." || true\n`);
  chmodSync(mac, 0o755);
  writeFileSync(
    join(DIRS.win, `${name}.bat`),
    ["@echo off", `REM ${desc}`, `powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\\Support files\\run.ps1" ${cmd} %*`, "echo.", "pause", ""].join("\r\n"),
  );
}

copyFileSync(join(ROOT, "installer", "run.sh"), join(DIRS.support, "run.sh"));
chmodSync(join(DIRS.support, "run.sh"), 0o755);
copyFileSync(join(ROOT, "installer", "run.ps1"), join(DIRS.support, "run.ps1"));
copyFileSync(bundle, join(DIRS.support, "ae-mcp.mjs"));
copyFileSync(join(ROOT, "README.md"), join(DIRS.support, "README (technical).md"));
copyFileSync(join(ROOT, "installer", "START HERE.txt"), join(OUT, "START HERE.txt"));

// --- zip (keeps the executable bits on the macOS launchers) ---
const zip = `AE-MCP-${pkg.version}.zip`;
if (process.platform === "darwin") run("ditto", ["-c", "-k", "--norsrc", "--noextattr", "--noqtn", "--noacl", "--keepParent", "AE-MCP", zip], OUT_BASE); // no ._ AppleDouble files (they show up on Windows)
else if (process.platform === "win32")
  run("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path AE-MCP -DestinationPath ${zip} -Force`], OUT_BASE);
else run("zip", ["-qr", zip, "AE-MCP"], OUT_BASE);
console.log(`\nRelease ready:\n  ${OUT}\n  ${join(OUT_BASE, zip)}`);
