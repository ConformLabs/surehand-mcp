// The After Effects extension ships signed (scripts/sign-extension.mjs). After Effects refuses a
// signed extension whose files changed, so any edit in extension/ (or a version bump, which is
// stamped into the files) must be followed by `npm run sign`.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readCepFiles } from "../scripts/cep-files.mjs";
import { checkSignature } from "../src/cli/signature.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

describe("extension signature", () => {
  it("covers every extension file as built, byte for byte (run `npm run sign` if this fails)", () => {
    const r = checkSignature(readCepFiles(version));
    expect(r.signed).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("stamps the release version into the manifest (what ZXP installers and Adobe show)", () => {
    // CEP manifest versions are numeric: a pre-release (1.4.0-beta.1) is stamped as 1.4.0 there
    const v = version.replace(/[-+].*$/, "");
    const manifest = readCepFiles(version)["CSXS/manifest.xml"] as string;
    expect(manifest).toContain(`ExtensionBundleVersion="${v}"`);
    expect(manifest.match(/<Extension Id="[^"]+" Version="([^"]+)"/g)).toEqual([
      `<Extension Id="com.aemcp.bridge" Version="${v}"`,
      `<Extension Id="com.aemcp.panel" Version="${v}"`,
      `<Extension Id="com.aemcp.approval" Version="${v}"`,
    ]);
    expect(readCepFiles("1.4.0-beta.1")["CSXS/manifest.xml"]).toContain('ExtensionBundleVersion="1.4.0"');
  });

  it("keeps the panel's fonts as bytes (never read as text, so they install byte for byte)", () => {
    const files = readCepFiles(version);
    const fonts = Object.keys(files).filter((f) => f.startsWith("fonts/") && f.endsWith(".woff2"));
    expect(fonts.sort()).toEqual([
      "fonts/ibm-plex-mono-latin-400-normal.woff2",
      "fonts/ibm-plex-mono-latin-500-normal.woff2",
      "fonts/ibm-plex-sans-latin-400-normal.woff2",
      "fonts/ibm-plex-sans-latin-600-normal.woff2",
      "fonts/space-grotesk-latin-600-normal.woff2",
    ]);
    for (const f of fonts) {
      expect(Buffer.isBuffer(files[f]), f).toBe(true);
      expect((files[f] as Buffer).subarray(0, 4).toString("latin1"), f).toBe("wOF2");
    }
    expect(typeof files["fonts/OFL-IBM-Plex.txt"]).toBe("string");
  });

  it("detects changed, extra and missing files", () => {
    const files = readCepFiles(version);
    expect(checkSignature({ ...files, "js/panel.js": files["js/panel.js"] + " " }).problems).toEqual(["js/panel.js changed since it was signed"]);
    expect(checkSignature({ ...files, ".aemcp-hash": "x" }).problems).toEqual([".aemcp-hash is not covered by the signature"]);
    const { ["bridge.html"]: _, ...rest } = files;
    expect(checkSignature(rest).problems).toEqual(["bridge.html is missing"]);
    const { ["META-INF/signatures.xml"]: __, ...unsigned } = files;
    expect(checkSignature(unsigned).signed).toBe(false);
  });
});
