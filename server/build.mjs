import { build } from "esbuild";
import { readFileSync, chmodSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: "dist/ae-mcp.mjs",
  loader: { ".jsxinc": "text" },
  define: { __AEMCP_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __aemcpCreateRequire } from 'module'; const require = __aemcpCreateRequire(import.meta.url);",
  },
  legalComments: "none",
});
chmodSync("dist/ae-mcp.mjs", 0o755);
console.log("built dist/ae-mcp.mjs v" + pkg.version);
