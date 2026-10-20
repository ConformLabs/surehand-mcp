import { build } from "esbuild";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { readCepFiles } from "./scripts/cep-files.mjs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Embed the After Effects (CEP) extension so the single-file server can install/update it itself.
// The files include the extension's signature (scripts/sign-extension.mjs), so they are written
// byte for byte as signed.
// Text files go in as strings, binary ones (the panel's fonts) as base64.
const cepFiles = readCepFiles(pkg.version);
const cepText = {}, cepBinary = {};
for (const [rel, content] of Object.entries(cepFiles)) {
  if (typeof content === "string") cepText[rel] = content;
  else cepBinary[rel] = content.toString("base64");
}
const cepHash = createHash("sha1").update(JSON.stringify(cepText)).update(JSON.stringify(cepBinary)).digest("hex").slice(0, 12);

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: "dist/surehand-ae.mjs",
  loader: { ".jsxinc": "text" },
  // Babel (modern JS -> ExtendScript) is the biggest dependency: use its minified build
  alias: { "@babel/standalone": "@babel/standalone/babel.min.js" },
  define: {
    __AEMCP_VERSION__: JSON.stringify(pkg.version),
    __AEMCP_CEP_FILES__: JSON.stringify(cepText),
    __AEMCP_CEP_BINARY__: JSON.stringify(cepBinary),
    __AEMCP_CEP_HASH__: JSON.stringify(cepHash),
  },
  banner: {
    js:
      "#!/usr/bin/env node\nimport { createRequire as __aemcpCreateRequire } from 'module'; const require = __aemcpCreateRequire(import.meta.url);\n" +
      // Babel probes globalThis.localStorage, which makes Node 25+ print an ExperimentalWarning into the AI apps' logs
      "try { Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true }); } catch {}",
  },
  legalComments: "none",
  // keeps the single file well under the 5 MiB limit for Claude Desktop extensions (names are kept, so
  // stack traces still name the function; ExtendScript bodies are string literals and stay as written)
  minifyWhitespace: true,
});
chmodSync("dist/surehand-ae.mjs", 0o755);
// up to 1.3 the bundle was dist/ae-mcp.mjs (releases still carry that name too: scripts/release.mjs)
rmSync("dist/ae-mcp.mjs", { force: true });
console.log(`built dist/surehand-ae.mjs v${pkg.version} (extension ${Object.keys(cepFiles).length} files, ${cepHash})`);
