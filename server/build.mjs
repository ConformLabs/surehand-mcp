import { build } from "esbuild";
import { createHash } from "node:crypto";
import { chmodSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Embed the After Effects (CEP) extension so the single-file server can install/update it itself.
const cepRoot = new URL("../cep-panel/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const cepFiles = {};
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (name.startsWith(".")) continue;
    if (statSync(p).isDirectory()) walk(p);
    else cepFiles[relative(cepRoot, p).split(sep).join("/")] = readFileSync(p, "utf8");
  }
})(cepRoot);
const cepHash = createHash("sha1").update(JSON.stringify(cepFiles)).digest("hex").slice(0, 12);

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: "dist/ae-mcp.mjs",
  loader: { ".jsxinc": "text" },
  define: {
    __AEMCP_VERSION__: JSON.stringify(pkg.version),
    __AEMCP_CEP_FILES__: JSON.stringify(cepFiles),
    __AEMCP_CEP_HASH__: JSON.stringify(cepHash),
  },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __aemcpCreateRequire } from 'module'; const require = __aemcpCreateRequire(import.meta.url);",
  },
  legalComments: "none",
});
chmodSync("dist/ae-mcp.mjs", 0o755);
console.log(`built dist/ae-mcp.mjs v${pkg.version} (extension ${Object.keys(cepFiles).length} files, ${cepHash})`);
