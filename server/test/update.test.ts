// `surehand-ae update` against a local stand-in for the GitHub releases API, in a temporary home folder.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home = mkdtempSync(join(tmpdir(), "surehand-update-"));
const installed = () => join(home, ".surehand", "ae", "server", "surehand-ae.mjs");
// a stand-in "release": reports its version, and pretends `setup` updated the AE extension
// (an ES module, like the real bundle: Node refuses those under unknown file extensions)
const fake = (v: string) =>
  `import { argv } from "node:process";\nif (argv.includes("--version")) console.log("${v}"); else console.log(JSON.stringify({ extensionInstalled: true }));\n`;
let release: any;
let files: Record<string, string> = {};
let server: Server;
let mod: typeof import("../src/cli/update-cmd.js");
let base = "";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** names: which server assets the release carries (1.3 releases: only ae-mcp.mjs). */
const publish = (tag: string, body: string | null, o: { digest?: string; names?: string[]; sidecar?: boolean; notes?: string } = {}) => {
  files = {};
  const assets: any[] = [];
  if (body !== null) {
    for (const name of o.names ?? ["surehand-ae.mjs", "ae-mcp.mjs"]) {
      files[`/${name}`] = body;
      assets.push({ name, browser_download_url: `${base}/${name}`, digest: o.sidecar ? null : `sha256:${o.digest ?? sha(body)}` });
      if (o.sidecar) {
        files[`/${name}.sha256`] = `${o.digest ?? sha(body)}  ${name}\n`;
        assets.push({ name: `${name}.sha256`, browser_download_url: `${base}/${name}.sha256` });
      }
    }
  }
  release = { tag_name: tag, html_url: `${base}/release/${tag}`, body: o.notes ?? null, assets };
};

const newHome = () => {
  home = mkdtempSync(join(tmpdir(), "surehand-update-"));
  process.env.HOME = process.env.USERPROFILE = home;
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.APPDATA = join(home, "AppData", "Roaming");
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/latest") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(release));
    if (files[req.url!] !== undefined) return res.writeHead(200).end(files[req.url!]);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.SUREHAND_AE_RELEASES_API = `${base}/latest`;
  process.env.AEMCP_NO_UPDATE_CHECK = "1";
  newHome();
  mod = await import("../src/cli/update-cmd.js");
});

afterAll(() => server?.close());

describe("surehand-ae update", () => {
  beforeEach(() => {
    newHome();
    mkdirSync(join(home, ".surehand", "ae", "server"), { recursive: true });
    writeFileSync(installed(), fake("0.0.1"));
  });

  it("says up to date when the latest release is not newer", async () => {
    publish("v0.0.0", fake("0.0.0"));
    const r = await mod.runUpdate();
    expect(r).toMatchObject({ ok: true, updated: false });
    expect(r.message).toMatch(/up to date/);
  });

  it("refuses a download whose checksum doesn't match, and changes nothing", async () => {
    publish("v99.0.0", fake("99.0.0"), { digest: "0".repeat(64) });
    const before = readFileSync(installed(), "utf8");
    const r = await mod.runUpdate();
    expect(r).toMatchObject({ ok: false, updated: false });
    expect(r.message).toMatch(/checksum mismatch.*Nothing was changed/);
    expect(readFileSync(installed(), "utf8")).toBe(before);
    expect(existsSync(installed().replace(/\.mjs$/, ".download.mjs"))).toBe(false);
  });

  it("refuses a download that doesn't report the release's version", async () => {
    publish("v99.0.0", fake("98.0.0"));
    const r = await mod.runUpdate();
    expect(r).toMatchObject({ ok: false, updated: false });
    expect(r.message).toMatch(/did not start correctly/);
  });

  it("points to the release page when a release has no server file", async () => {
    publish("v99.0.0", null);
    const r = await mod.runUpdate();
    expect(r).toMatchObject({ ok: false, updated: false, url: `${base}/release/v99.0.0` });
  });

  it("installs a newer release, keeps the previous file and reports the extension update", async () => {
    const before = readFileSync(installed(), "utf8");
    publish("v99.0.0", fake("99.0.0"));
    const r = await mod.runUpdate();
    expect(r).toMatchObject({ ok: true, updated: true, to: "99.0.0", restartAfterEffects: true });
    expect(r.message).toMatch(/Restart After Effects and your AI apps/);
    expect(readFileSync(installed(), "utf8")).toBe(fake("99.0.0"));
    expect(readFileSync(`${installed()}.previous`, "utf8")).toBe(before);
  });

  it("takes ae-mcp.mjs from a release that only has the 1.3 name, checked with its .sha256 file", async () => {
    publish("v99.0.0", fake("99.0.0"), { names: ["ae-mcp.mjs"], sidecar: true });
    const r = await mod.runUpdate();
    expect(r).toMatchObject({ ok: true, updated: true });
    expect(readFileSync(installed(), "utf8")).toBe(fake("99.0.0"));
  });

  it("--check reports without installing anything", async () => {
    publish("v99.0.0", fake("99.0.0"), { notes: "## What's new\n- things" });
    const c = await mod.checkUpdate();
    expect(c).toEqual({ ok: true, current: "test", latest: "99.0.0", updateAvailable: true, notes: "## What's new\n- things", url: `${base}/release/v99.0.0` });
    expect(readFileSync(installed(), "utf8")).toBe(fake("0.0.1"));
    publish("v0.0.0", fake("0.0.0"));
    expect(await mod.checkUpdate()).toMatchObject({ updateAvailable: false, latest: "0.0.0" });
  });

  it("--check --json prints one JSON object", async () => {
    publish("v99.0.0", fake("99.0.0"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await mod.updateCommand(["--check", "--json"]);
    const out = JSON.parse(log.mock.calls[0][0]);
    log.mockRestore();
    expect(out).toMatchObject({ current: "test", latest: "99.0.0", updateAvailable: true });
    expect(process.exitCode).toBe(0);
  });
});

describe("chooseAsset", () => {
  const a = (name: string) => ({ name, browser_download_url: `x/${name}` });
  it("prefers surehand-ae.mjs, falls back to ae-mcp.mjs, and never takes a checksum file", () => {
    expect(mod.chooseAsset({ assets: [a("ae-mcp.mjs"), a("surehand-ae.mjs")] })?.name).toBe("surehand-ae.mjs");
    expect(mod.chooseAsset({ assets: [a("ae-mcp.mjs.sha256"), a("ae-mcp.mjs")] })?.name).toBe("ae-mcp.mjs");
    expect(mod.chooseAsset({ assets: [a("surehand-ae.mjs.sha256"), a("Surehand-MCP.mcpb")] })).toBeNull();
  });
});

describe("updating a 1.3 installation", () => {
  it("ends in the new layout, and AI app settings that named ~/.aemcp point at the new server", async () => {
    newHome();
    const L = join(home, ".aemcp");
    mkdirSync(join(L, "server"), { recursive: true });
    mkdirSync(join(L, "checkpoints", "p-1"), { recursive: true });
    writeFileSync(join(L, "server", "ae-mcp.mjs"), fake("1.3.4"));
    writeFileSync(join(L, "config.json"), JSON.stringify({ token: "t".repeat(48), bridgePort: 8765, httpPort: 8766 }));
    writeFileSync(join(L, "checkpoints", "p-1", "v1.aep"), "aep");
    const cursor = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(cursor, JSON.stringify({ mcpServers: { "after-effects": { command: "/usr/local/bin/node", args: [join(L, "server", "ae-mcp.mjs")] } } }));

    publish("v99.0.0", fake("99.0.0"));
    const r = await mod.runUpdate();
    expect(r).toMatchObject({ ok: true, updated: true });
    expect(readFileSync(installed(), "utf8")).toBe(fake("99.0.0"));
    expect(readFileSync(`${installed()}.previous`, "utf8")).toBe(fake("1.3.4"));
    expect(readFileSync(join(home, ".surehand", "ae", "checkpoints", "p-1", "v1.aep"), "utf8")).toBe("aep");
    expect(existsSync(join(L, "MOVED.txt"))).toBe(true);
    const servers = JSON.parse(readFileSync(cursor, "utf8")).mcpServers;
    expect(servers["after-effects"]).toBeUndefined();
    expect(servers["surehand-ae"]).toEqual({ command: "/usr/local/bin/node", args: [installed()] });
  });
});
