import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { packViews } from "./scripts/views.mjs";
import { readSkillFiles } from "./scripts/skill-files.mjs";

export default defineConfig({
  define: {
    __AEMCP_VERSION__: JSON.stringify("test"),
    __AEMCP_CEP_FILES__: JSON.stringify({ "CSXS/manifest.xml": "<x/>" }),
    __AEMCP_CEP_BINARY__: JSON.stringify({}),
    __AEMCP_CEP_HASH__: JSON.stringify("testhash"),
    // the real views, built as for the bundle
    __SUREHAND_VIEWS__: JSON.stringify(packViews()),
    // the real skills (skills/ in the repo)
    __AEMCP_SKILLS__: JSON.stringify(readSkillFiles()),
  },
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
