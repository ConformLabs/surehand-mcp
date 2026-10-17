import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

export default defineConfig({
  define: { __AEMCP_VERSION__: JSON.stringify("test"), __AEMCP_CEP_FILES__: JSON.stringify({ "CSXS/manifest.xml": "<x/>" }), __AEMCP_CEP_HASH__: JSON.stringify("testhash") },
  plugins: [
    {
      name: "jsxinc-raw",
      enforce: "pre",
      load(id) {
        if (id.endsWith(".jsxinc")) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
      },
    },
  ],
});
