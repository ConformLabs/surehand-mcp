import { build } from "esbuild";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import { readCepFiles } from "./scripts/cep-files.mjs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Embed the After Effects (CEP) extension so the single-file server can install/update it itself.
// The files include the extension's signature (scripts/sign-extension.mjs), so they are written
// byte for byte as signed.
const cepFiles = readCepFiles(pkg.version);
const cepHash = createHash("sha1").update(JSON.stringify(cepFiles)).digest("hex").slice(0, 12);

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: "dist/ae-mcp.mjs",
  loader: { ".jsxinc": "text" },
  // Babel (modern JS -> ExtendScript) is the biggest dependency: use its minified build
  alias: { "@babel/standalone": "@babel/standalone/babel.min.js" },
  define: {
    __AEMCP_VERSION__: JSON.stringify(pkg.version),
    __AEMCP_CEP_FILES__: JSON.stringify(cepFiles),
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
chmodSync("dist/ae-mcp.mjs", 0o755);
console.log(`built dist/ae-mcp.mjs v${pkg.version} (extension ${Object.keys(cepFiles).length} files, ${cepHash})`);
