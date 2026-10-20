// cloudflared for ChatGPT on the web (tunnel-install.ts, `chatgpt --install-tunnel`): the pinned download is checked
// against its SHA-256, goes in atomically, is a no-op the second time, never replaces a cloudflared that isn't ours,
// is found by tunnelTool(), and uninstall removes it only when Surehand put it there. A local HTTP server stands in
// for GitHub; a small script stands in for cloudflared. Temporary home only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "surehand-tunnel-"));
vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), homedir: () => home }));
vi.mock("../src/cli/util.js", async (orig) => ({ ...(await orig<typeof import("../src/cli/util.js")>()), findClaudeCli: () => null }));
process.env.CODEX_HOME = join(home, ".codex");
process.env.APPDATA = join(home, "AppData", "Roaming");

const T = await import("../src/cli/tunnel-install.js");
const { tunnelTool } = await import("../src/cli/chatgpt.js");
const { uninstall } = await import("../src/cli/uninstall.js");

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const posix = process.platform !== "win32";

// a .tgz holding a "cloudflared" that prints its version, like Cloudflare's macOS downloads
function fakeTgz(version: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "surehand-cf-src-"));
  writeFileSync(join(dir, "cloudflared"), `#!/bin/sh\necho "cloudflared version ${version} (built 2026-09-24)"\n`);
  chmodSync(join(dir, "cloudflared"), 0o755);
  const tgz = join(dir, "cf.tgz");
  spawnSync("tar", ["-czf", tgz, "-C", dir, "cloudflared"]);
  const b = readFileSync(tgz);
  rmSync(dir, { recursive: true, force: true });
  return b;
}

let server: Server, base = "";
const files: Record<string, Buffer> = {};
let hits = 0;
beforeAll(async () => {
  if (posix) {
    files["/good.tgz"] = fakeTgz(T.CLOUDFLARED_VERSION);
    files["/old.tgz"] = fakeTgz("2020.1.1");
  }
  files["/cloudflared.exe"] = Buffer.from("MZ stand-in");
  server = createServer((req, res) => {
    hits++;
    const b = files[req.url ?? ""];
    if (!b) return res.writeHead(404).end();
    res.writeHead(200, { "content-length": b.length }).end(b);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => {
  server?.close();
  rmSync(home, { recursive: true, force: true });
});

const tgz = (path: string, sum = sha(files[path])) => ({ url: `${base}${path}`, sha256: sum, maxBytes: 1e6, kind: "tgz" as const });
const fresh = () => mkdtempSync(join(tmpdir(), "surehand-bin-"));

describe("cloudflared download (pinned, verified, atomic)", () => {
  it("pins Cloudflare's GitHub release with a SHA-256 for every platform the installers support", () => {
    for (const key of ["win32-x64", "win32-arm64", "darwin-arm64", "darwin-x64"]) {
      const a = T.CLOUDFLARED_ASSETS[key];
      expect(a.url).toMatch(new RegExp(`^https://github\\.com/cloudflare/cloudflared/releases/download/${T.CLOUDFLARED_VERSION.replaceAll(".", "\\.")}/cloudflared-`));
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(T.cloudflaredPath()).toBe(join(home, ".surehand", "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared"));
  });

  it.skipIf(!posix)("installs into the folder, checks it starts, and leaves a marker; the second run does nothing", async () => {
    const dir = fresh();
    const r = await T.installCloudflared({ dir, platform: "darwin", asset: tgz("/good.tgz") });
    expect(r).toEqual({ ok: true, path: join(dir, "cloudflared"), version: T.CLOUDFLARED_VERSION });
    expect(readdirSync(dir).sort()).toEqual(["cloudflared", "cloudflared.surehand.json"]); // no staging left
    expect(JSON.parse(readFileSync(join(dir, "cloudflared.surehand.json"), "utf8"))).toMatchObject({ version: T.CLOUDFLARED_VERSION, sha256: sha(readFileSync(join(dir, "cloudflared"))) });
    expect(T.ownsCloudflared(dir, "darwin")).toBe(true);
    const before = hits;
    expect(await T.installCloudflared({ dir, platform: "darwin", asset: tgz("/good.tgz") })).toMatchObject({ ok: true, already: true });
    expect(hits).toBe(before); // nothing downloaded
  });

  it("refuses a download whose SHA-256 does not match, and leaves nothing behind", async () => {
    const dir = fresh();
    const r = await T.installCloudflared({ dir, platform: "win32", asset: { url: `${base}/cloudflared.exe`, sha256: "0".repeat(64), maxBytes: 1e6, kind: "exe" }, checkStarts: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/checksum mismatch/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.skipIf(!posix)("refuses a build that does not report the pinned version", async () => {
    const dir = fresh();
    const r = await T.installCloudflared({ dir, platform: "darwin", asset: tgz("/old.tgz") });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/did not start correctly/) });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses plain HTTP to anywhere but this computer", async () => {
    const r = await T.installCloudflared({ dir: fresh(), platform: "win32", asset: { url: "http://example.com/cloudflared.exe", sha256: "0".repeat(64), maxBytes: 1, kind: "exe" }, checkStarts: false });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/non-HTTPS/) });
  });

  it("never replaces a cloudflared Surehand did not put there", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "cloudflared.exe"), "the user's own");
    const before = hits;
    const r = await T.installCloudflared({ dir, platform: "win32", asset: { url: `${base}/cloudflared.exe`, sha256: sha(files["/cloudflared.exe"]), maxBytes: 1e6, kind: "exe" }, checkStarts: false });
    expect(r).toMatchObject({ ok: true, already: true, path: join(dir, "cloudflared.exe") });
    expect(hits).toBe(before);
    expect(readFileSync(join(dir, "cloudflared.exe"), "utf8")).toBe("the user's own");
  });

  it("removeOwnCloudflared removes only Surehand's copy (its marker matches), and the folder when empty", async () => {
    const dir = fresh();
    await T.installCloudflared({ dir, platform: "win32", asset: { url: `${base}/cloudflared.exe`, sha256: sha(files["/cloudflared.exe"]), maxBytes: 1e6, kind: "exe" }, checkStarts: false });
    expect(T.removeOwnCloudflared(dir, "win32")).toBe(true);
    expect(existsSync(dir)).toBe(false);
    // changed since (the user replaced it): kept
    const d2 = fresh();
    await T.installCloudflared({ dir: d2, platform: "win32", asset: { url: `${base}/cloudflared.exe`, sha256: sha(files["/cloudflared.exe"]), maxBytes: 1e6, kind: "exe" }, checkStarts: false });
    writeFileSync(join(d2, "cloudflared.exe"), "replaced by the user");
    expect(T.removeOwnCloudflared(d2, "win32")).toBe(false);
    expect(readFileSync(join(d2, "cloudflared.exe"), "utf8")).toBe("replaced by the user");
  });
});

describe("cloudflared in ~/.surehand/bin is found and uninstalled", () => {
  const bin = join(home, ".surehand", "bin");
  const own = (content = "#!/bin/sh\n") => {
    mkdirSync(bin, { recursive: true });
    const f = T.cloudflaredPath();
    writeFileSync(f, content);
    chmodSync(f, 0o755);
    writeFileSync(T.cloudflaredMarker(), JSON.stringify({ version: T.CLOUDFLARED_VERSION, sha256: sha(Buffer.from(content)) }));
    return f;
  };

  it("tunnelTool() finds the copy in ~/.surehand/bin when cloudflared is not on the PATH", () => {
    const path = process.env.PATH;
    const only = process.env.SUREHAND_AE_TUNNEL_PATH_ONLY;
    try {
      process.env.PATH = fresh(); // nothing on the PATH
      delete process.env.SUREHAND_AE_TUNNEL_PATH_ONLY;
      delete process.env.AEMCP_TUNNEL_PATH_ONLY;
      const f = own();
      expect(tunnelTool()).toEqual({ kind: "cloudflared", path: f });
    } finally {
      process.env.PATH = path;
      if (only !== undefined) process.env.SUREHAND_AE_TUNNEL_PATH_ONLY = only;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("uninstall removes Surehand's cloudflared, never the user's", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const f = own();
    uninstall([]);
    expect(existsSync(f)).toBe(false);
    expect(existsSync(bin)).toBe(false);
    mkdirSync(bin, { recursive: true });
    writeFileSync(T.cloudflaredPath(), "the user's own");
    uninstall([]);
    expect(readFileSync(T.cloudflaredPath(), "utf8")).toBe("the user's own");
    rmSync(bin, { recursive: true, force: true });
  });

  it.skipIf(!posix)("run.sh's uninstall without Node.js does the same", () => {
    const run = () =>
      spawnSync("bash", [fileURLToPath(new URL("../../installer/run.sh", import.meta.url)), "uninstall"], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", HOME: home, SUREHAND_AE_FORCE_NODE_DOWNLOAD: "1" },
      });
    const f = own("#!/bin/sh\necho ours\n");
    expect(run().status).toBe(0);
    expect(existsSync(f)).toBe(false);
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "cloudflared"), "the user's own");
    writeFileSync(T.cloudflaredMarker(), JSON.stringify({ version: "x", sha256: "0".repeat(64) }));
    run();
    expect(readFileSync(join(bin, "cloudflared"), "utf8")).toBe("the user's own");
    rmSync(join(home, ".surehand"), { recursive: true, force: true });
  });

  it("run.ps1 removes it the same way (marker hash), and the shared bin folder is not an app", () => {
    const ps = readFileSync(new URL("../../installer/run.ps1", import.meta.url), "utf8");
    expect(ps).toMatch(/function Remove-OwnCloudflared[\s\S]*cloudflared\.surehand\.json[\s\S]*Get-FileHash -Algorithm SHA256/);
    expect(ps).toMatch(/Remove-Own \$legacyDir[\s\S]*Remove-OwnCloudflared/);
    for (const text of [ps, readFileSync(new URL("../../installer/run.sh", import.meta.url), "utf8"), readFileSync(new URL("../src/cli/uninstall.ts", import.meta.url), "utf8")])
      expect(text).toMatch(/node.{1,6}ffmpeg.{1,6}bin/);
  });
});
