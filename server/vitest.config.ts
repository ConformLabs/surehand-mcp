import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

export default defineConfig({
  define: { __AEMCP_VERSION__: JSON.stringify("test") },
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
