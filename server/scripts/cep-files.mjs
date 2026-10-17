// The After Effects (CEP) extension files exactly as they are installed: every file under
// extension/ with the release version stamped in. Shared by build.mjs (which embeds them) and
// sign-extension.mjs (which signs them), so the signature always covers the same bytes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const CEP_ROOT = new URL("../../extension/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Files the signing tool adds; everything else is signed. */
export const SIGNATURE_FILES = ["META-INF/signatures.xml", "mimetype"];

export function readCepFiles(version) {
  const files = {};
  (function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (name.startsWith(".")) continue;
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(CEP_ROOT, p).split(sep).join("/")] = readFileSync(p, "utf8").replaceAll("__AEMCP_VERSION__", version);
    }
  })(CEP_ROOT);
  return files;
}
