// `surehand-ae update` against a local stand-in for the GitHub releases API, in a temporary home folder.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// the running version (the build's is "test"): a channel test sets a beta
const ver = vi.hoisted(() => ({ v: "test" }));
vi.mock("../src/config.js", async (orig) => {
  const real: any = await orig();
  return { ...real, get VERSION() { return ver.v; } };
});

let home = mkdtempSync(join(tmpdir(), "surehand-update-"));
const installed = () => join(home, ".surehand", "ae", "server", "surehand-ae.mjs");
// a stand-in "release": reports its version, and pretends `setup` updated the AE extension
// (an ES module, like the real bundle: Node refuses those under unknown file extensions)
const fake = (v: string) =>
  `import { argv } from "node:process";\nif (argv.includes("--version")) console.log("${v}"); else console.log(JSON.stringify({ extensionInstalled: true }));\n`;
let release: any;
// /releases (the beta channel's list); null: the same as the latest release alone
let releases: any[] | null = null;
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
  releases = null;
};
/**
 * GitHub's release list: a pre-release has a "-" in its tag. The latest release (/latest) is the newest one
 * that isn't a pre-release, as on GitHub. Each release's files under /<tag>/.
 */
const publishAll = (list: { tag: string; digest?: string; sidecar?: boolean; draft?: boolean }[]) => {
  files = {};
  releases = list.map((r) => {
    const v = r.tag.replace(/^v/, "");
    const body = fake(v);
    const assets: any[] = [];
    for (const name of ["surehand-ae.mjs", "ae-mcp.mjs"]) {
      files[`/${r.tag}/${name}`] = body;
      assets.push({ name, browser_download_url: `${base}/${r.tag}/${name}`, digest: r.sidecar ? null : `sha256:${r.digest ?? sha(body)}` });
      if (r.sidecar) {
        files[`/${r.tag}/${name}.sha256`] = `${r.digest ?? sha(body)}  ${name}\n`;
        assets.push({ name: `${name}.sha256`, browser_download_url: `${base}/${r.tag}/${name}.sha256` });
      }
    }
    return { tag_name: r.tag, html_url: `${base}/release/${r.tag}`, body: null, prerelease: r.tag.includes("-"), draft: !!r.draft, assets };
  });
  release = releases.find((r) => !r.prerelease && !r.draft) ?? null;
};

const newHome = () => {
  home = mkdtempSync(join(tmpdir(), "surehand-update-"));
  process.env.HOME = process.env.USERPROFILE = home;
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.APPDATA = join(home, "AppData", "Roaming");
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/latest") return release ? res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(release)) : res.writeHead(404).end();
    if (req.url === "/releases") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(releases ?? [release]));
    if (files[req.url!] !== undefined) return res.writeHead(200).end(files[req.url!]);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.SUREHAND_AE_RELEASES_API = `${base}/latest`;
  process.env.SUREHAND_AE_RELEASES_LIST_API = `${base}/releases`;
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
    expect(c).toEqual({ current: "test", latest: "99.0.0", updateAvailable: true, notes: ["### What's new", "things"], url: `${base}/release/v99.0.0`, checkedAt: expect.any(String), channel: "stable" });
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
    expect(out).toEqual({ current: "test", latest: "99.0.0", updateAvailable: true, url: `${base}/release/v99.0.0`, checkedAt: expect.any(String), channel: "stable" });
    expect(readFileSync(installed(), "utf8")).toBe(fake("0.0.1")); // nothing installed
    expect(process.exitCode).toBe(0);
  });
});

describe("update channel", () => {
  const cfgFile = () => join(home, ".surehand", "ae", "config.json");
  const cfg = () => JSON.parse(readFileSync(cfgFile(), "utf8"));
  const setChannel = (c: string | null) => writeFileSync(cfgFile(), JSON.stringify({ token: "t".repeat(48), bridgePort: 8765, httpPort: 8766, ...(c ? { updateChannel: c } : {}) }));
  beforeEach(() => {
    newHome();
    mkdirSync(join(home, ".surehand", "ae", "server"), { recursive: true });
    ver.v = "1.3.4";
    writeFileSync(installed(), fake("1.3.4"));
    setChannel(null);
  });
  afterAll(() => {
    ver.v = "test";
  });

  it("stable (the default) ignores pre-releases", async () => {
    publishAll([{ tag: "v1.4.0-beta.3" }, { tag: "v1.3.4" }]);
    expect(await mod.checkUpdate()).toMatchObject({ channel: "stable", latest: "1.3.4", updateAvailable: false });
    const r = await mod.runUpdate();
    expect(r).toMatchObject({ ok: true, updated: false });
    expect(readFileSync(installed(), "utf8")).toBe(fake("1.3.4"));
  });

  it("beta offers and installs a newer pre-release, checked against its sha256", async () => {
    setChannel("beta");
    publishAll([{ tag: "v1.4.0-beta.3" }, { tag: "v1.4.0-beta.2" }, { tag: "v1.3.4" }]);
    expect(await mod.checkUpdate()).toMatchObject({ channel: "beta", latest: "1.4.0-beta.3", updateAvailable: true, url: `${base}/release/v1.4.0-beta.3` });
    const r = await mod.runUpdate();
    expect(r).toMatchObject({ ok: true, updated: true, to: "1.4.0-beta.3" });
    expect(r.message).toMatch(/Restart After Effects and your AI apps to finish\./);
    expect(readFileSync(installed(), "utf8")).toBe(fake("1.4.0-beta.3"));
  });

  it("beta takes a stable release that is newer than the betas, and never a draft", async () => {
    setChannel("beta");
    ver.v = "1.4.0-beta.3";
    writeFileSync(installed(), fake("1.4.0-beta.3"));
    publishAll([{ tag: "v1.5.0-beta.1", draft: true }, { tag: "v1.4.0" }, { tag: "v1.4.0-beta.3" }]);
    expect(await mod.checkUpdate()).toMatchObject({ latest: "1.4.0", updateAvailable: true });
    expect(await mod.runUpdate()).toMatchObject({ ok: true, updated: true, to: "1.4.0" });
    expect(readFileSync(installed(), "utf8")).toBe(fake("1.4.0"));
  });

  it("back on stable, a newer beta stays (and says so) until a newer stable release is out", async () => {
    ver.v = "1.4.0-beta.3";
    writeFileSync(installed(), fake("1.4.0-beta.3"));
    publishAll([{ tag: "v1.4.0-beta.4" }, { tag: "v1.4.0-beta.3" }, { tag: "v1.3.4" }]);
    const c = await mod.checkUpdate();
    expect(c).toMatchObject({ channel: "stable", latest: "1.3.4", updateAvailable: false });
    expect(c.keptBeta).toBe("You have a beta (v1.4.0-beta.3), newer than the latest stable release (v1.3.4): it stays until a newer stable release is out.");
    const r = await mod.runUpdate();
    expect(r).toMatchObject({ ok: true, updated: false });
    expect(r.message).toMatch(/up to date \(v1\.4\.0-beta\.3\)\. You have a beta/);
    expect(readFileSync(installed(), "utf8")).toBe(fake("1.4.0-beta.3")); // never downgraded, beta.4 not taken either
    // the stable release comes out: it is newer than the beta
    publishAll([{ tag: "v1.4.0" }, { tag: "v1.4.0-beta.4" }]);
    expect(await mod.runUpdate()).toMatchObject({ ok: true, updated: true, to: "1.4.0" });
  });

  it("a pre-release's download is still refused when its checksum doesn't match (digest or .sha256 file)", async () => {
    setChannel("beta");
    for (const sidecar of [false, true]) {
      publishAll([{ tag: "v1.4.0-beta.3", digest: "0".repeat(64), sidecar }, { tag: "v1.3.4" }]);
      const r = await mod.runUpdate();
      expect(r).toMatchObject({ ok: false, updated: false });
      expect(r.message).toMatch(/checksum mismatch.*Nothing was changed/);
      expect(readFileSync(installed(), "utf8")).toBe(fake("1.3.4"));
    }
    // and a pre-release without any checksum isn't installed
    publishAll([{ tag: "v1.4.0-beta.3" }]);
    releases![0].assets = releases![0].assets.map((a: any) => ({ ...a, digest: null }));
    expect((await mod.runUpdate()).message).toMatch(/no checksum/);
    expect(readFileSync(installed(), "utf8")).toBe(fake("1.3.4"));
  });

  it("--channel saves the channel in config.json (keeping the rest), then checks on it", async () => {
    publishAll([{ tag: "v1.4.0-beta.3" }, { tag: "v1.3.4" }]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await mod.updateCommand(["--check", "--channel", "beta", "--json"]);
    expect(cfg()).toMatchObject({ updateChannel: "beta", token: "t".repeat(48), bridgePort: 8765 });
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ channel: "beta", latest: "1.4.0-beta.3", updateAvailable: true });
    await mod.updateCommand(["--check", "--channel=stable", "--json"]);
    expect(cfg().updateChannel).toBeUndefined();
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ channel: "stable", latest: "1.3.4", updateAvailable: false });
    // a wrong value changes nothing
    await mod.updateCommand(["--check", "--channel", "nightly", "--json"]);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ ok: false, message: expect.stringMatching(/--channel beta\|stable/) });
    expect(process.exitCode).toBe(2);
    await mod.updateCommand(["--channel"]);
    expect(process.exitCode).toBe(2);
    log.mockRestore();
    expect(cfg().updateChannel).toBeUndefined();
    expect(readFileSync(installed(), "utf8")).toBe(fake("1.3.4")); // --check installs nothing
    process.exitCode = 0;
  });

  it("an unreadable config.json is left alone", async () => {
    writeFileSync(cfgFile(), "{ not json");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await mod.updateCommand(["--check", "--channel", "beta", "--json"]);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ ok: false, message: expect.stringMatching(/Could not save the update channel/) });
    log.mockRestore();
    expect(readFileSync(cfgFile(), "utf8")).toBe("{ not json");
    process.exitCode = 0;
  });

  it("the cached check (the panel's banner) records its channel; one from the other channel is not used", async () => {
    const upd = await import("../src/update.js");
    delete process.env.AEMCP_NO_UPDATE_CHECK;
    try {
      publishAll([{ tag: "v1.4.0-beta.3" }, { tag: "v1.3.4" }]);
      setChannel("beta");
      await mod.checkUpdate();
      const cache = () => JSON.parse(readFileSync(join(home, ".surehand", "ae", "update-check.json"), "utf8"));
      expect(cache()).toMatchObject({ channel: "beta", latest: "1.4.0-beta.3", updateAvailable: true });
      expect(upd.knownUpdate()).toMatchObject({ latest: "1.4.0-beta.3", updateAvailable: true });
      setChannel(null);
      expect(upd.knownUpdate()).toBeNull(); // stale: checked on beta
      // the background check (cached for a day) checks again on the new channel
      expect(await upd.checkForUpdate()).toMatchObject({ channel: "stable", latest: "1.3.4", updateAvailable: false });
      expect(cache()).toMatchObject({ channel: "stable", latest: "1.3.4" });
    } finally {
      process.env.AEMCP_NO_UPDATE_CHECK = "1";
    }
  });
});

describe("keptBetaNote", () => {
  it("only on stable, with a beta installed that is newer than the latest stable release", async () => {
    const { keptBetaNote } = await import("../src/update.js");
    expect(keptBetaNote("stable", "1.3.4", "1.4.0-beta.3")).toMatch(/it stays until a newer stable release is out/);
    expect(keptBetaNote("beta", "1.3.4", "1.4.0-beta.3")).toBeNull();
    expect(keptBetaNote("stable", "1.4.0", "1.4.0-beta.3")).toBeNull(); // the stable release is newer: offered
    expect(keptBetaNote("stable", "1.3.4", "1.3.4")).toBeNull();
    expect(keptBetaNote("stable", null, "1.4.0-beta.3")).toBeNull();
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
