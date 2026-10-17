// `ae-mcp update` against a local stand-in for the GitHub releases API, in a temporary home folder.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aemcp-update-"));
const installed = join(home, ".aemcp", "server", "ae-mcp.mjs");
// a stand-in "release": reports its version, and pretends `setup` updated the AE extension
const fake = (v: string) => `if (process.argv.includes("--version")) console.log("${v}"); else console.log(JSON.stringify({ extensionInstalled: true }));\n`;
let release: any;
let files: Record<string, string> = {};
let server: Server;
let runUpdate: typeof import("../src/cli/update-cmd.js").runUpdate;
let base = "";

const publish = (tag: string, body: string | null, digest?: string) => {
  files = {};
  const assets: any[] = [];
  if (body !== null) {
    files["/ae-mcp.mjs"] = body;
    assets.push({ name: "ae-mcp.mjs", browser_download_url: `${base}/ae-mcp.mjs`, digest: `sha256:${digest ?? createHash("sha256").update(body).digest("hex")}` });
  }
  release = { tag_name: tag, html_url: `${base}/release/${tag}`, assets };
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/latest") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(release));
    if (files[req.url!] !== undefined) return res.writeHead(200).end(files[req.url!]);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.HOME = process.env.USERPROFILE = home;
  process.env.AEMCP_RELEASES_API = `${base}/latest`;
  process.env.AEMCP_NO_UPDATE_CHECK = "1";
  mkdirSync(join(home, ".aemcp", "server"), { recursive: true });
  writeFileSync(installed, fake("0.0.1"));
  ({ runUpdate } = await import("../src/cli/update-cmd.js"));
});

afterAll(() => server?.close());

describe("ae-mcp update", () => {
  it("says up to date when the latest release is not newer", async () => {
    publish("v0.0.0", fake("0.0.0"));
    const r = await runUpdate();
    expect(r).toMatchObject({ ok: true, updated: false });
    expect(r.message).toMatch(/up to date/);
  });

  it("refuses a download whose checksum doesn't match, and changes nothing", async () => {
    publish("v99.0.0", fake("99.0.0"), "0".repeat(64));
    const before = readFileSync(installed, "utf8");
    const r = await runUpdate();
    expect(r).toMatchObject({ ok: false, updated: false });
    expect(r.message).toMatch(/checksum mismatch.*Nothing was changed/);
    expect(readFileSync(installed, "utf8")).toBe(before);
    expect(existsSync(`${installed}.download`)).toBe(false);
  });

  it("refuses a download that doesn't report the release's version", async () => {
    publish("v99.0.0", fake("98.0.0"));
    const r = await runUpdate();
    expect(r).toMatchObject({ ok: false, updated: false });
    expect(r.message).toMatch(/did not start correctly/);
  });

  it("points to the release page when a release has no server file", async () => {
    publish("v99.0.0", null);
    const r = await runUpdate();
    expect(r).toMatchObject({ ok: false, updated: false, url: `${base}/release/v99.0.0` });
  });

  it("installs a newer release, keeps the previous file and reports the extension update", async () => {
    const before = readFileSync(installed, "utf8");
    publish("v99.0.0", fake("99.0.0"));
    const r = await runUpdate();
    expect(r).toMatchObject({ ok: true, updated: true, to: "99.0.0", restartAfterEffects: true });
    expect(r.message).toMatch(/Restart After Effects and your AI apps/);
    expect(readFileSync(installed, "utf8")).toBe(fake("99.0.0"));
    expect(readFileSync(`${installed}.previous`, "utf8")).toBe(before);
  });
});
