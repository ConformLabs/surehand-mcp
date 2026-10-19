import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG_BUILDS, ffmpegNotFoundMessage, installFfmpeg, locateFfmpeg, type FfmpegBuild } from "../src/preflight/ffmpeg.js";

const tmp = () => mkdtempSync(join(tmpdir(), "aemcp-ff-"));
const touch = (p: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "");
  return p;
};

describe("finding ffmpeg", () => {
  it("config override first, then ~/.aemcp/ffmpeg, then PATH", () => {
    const root = tmp();
    const cfgFf = touch(join(root, "cfg", "ffmpeg"));
    touch(join(root, "cfg", "ffprobe"));
    const priv = join(root, "private");
    touch(join(priv, "ffmpeg"));
    touch(join(priv, "ffprobe"));
    const onPath = join(root, "bin");
    touch(join(onPath, "ffmpeg"));
    touch(join(onPath, "ffprobe"));
    const o = { dir: priv, pathEnv: onPath, platform: "linux" as const };
    expect(locateFfmpeg({ ...o, config: { ffmpegPath: cfgFf } }).found).toEqual({ ffmpeg: cfgFf, ffprobe: join(root, "cfg", "ffprobe"), source: "config" });
    expect(locateFfmpeg({ ...o, config: {} }).found).toMatchObject({ ffmpeg: join(priv, "ffmpeg"), source: "private" });
    expect(locateFfmpeg({ ...o, dir: join(root, "none"), config: {} }).found).toMatchObject({ ffmpeg: join(onPath, "ffmpeg"), source: "path" });
  });

  it("a wrong config path is named in the not-found message", () => {
    const root = tmp();
    const r = locateFfmpeg({ dir: join(root, "none"), pathEnv: join(root, "nothing"), platform: "linux", config: { ffmpegPath: "/nowhere/ffmpeg" } });
    expect(r.found).toBeNull();
    expect(r.notes[0]).toMatch(/config\.json sets ffmpegPath "\/nowhere\/ffmpeg", but ffmpeg is not there/);
    const msg = ffmpegNotFoundMessage(r.notes, "darwin-arm64");
    expect(msg).toMatch(/ffmpeg \/ ffprobe were not found/);
    expect(msg).toMatch(/download FFmpeg 9\.0\.2 once into ~\/\.aemcp\/ffmpeg/);
    expect(msg).toMatch(/brew install ffmpeg/);
  });

  it("needs both ffmpeg and ffprobe in the same place", () => {
    const root = tmp();
    touch(join(root, "a", "ffmpeg"));
    touch(join(root, "b", "ffprobe"));
    expect(locateFfmpeg({ dir: join(root, "none"), pathEnv: `${join(root, "a")}:${join(root, "b")}`, platform: "linux", config: {} }).found).toBeNull();
  });

  it("Windows names", () => {
    const root = tmp();
    touch(join(root, "ffmpeg.exe"));
    touch(join(root, "ffprobe.exe"));
    expect(locateFfmpeg({ dir: root, pathEnv: "", platform: "win32", config: {} }).found).toMatchObject({ ffmpeg: join(root, "ffmpeg.exe"), source: "private" });
  });

  it("every pinned build is HTTPS with a SHA-256", () => {
    for (const k of ["darwin-arm64", "darwin-x64", "win32-x64"]) {
      const b = FFMPEG_BUILDS[k];
      expect(b, k).toBeDefined();
      const programs = b.archives.flatMap((a) => a.programs).sort();
      expect(programs).toEqual(["ffmpeg", "ffprobe"]);
      for (const a of b.archives) {
        expect(a.url).toMatch(/^https:\/\//);
        expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

describe("the one-time download", () => {
  let server: Server;
  let base = "";
  const files: Record<string, Buffer> = {};
  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = files[req.url ?? ""];
      if (!body) return res.writeHead(404).end();
      res.writeHead(200, { "content-length": body.length }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => server.close());

  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  /** a zip with fake ffmpeg / ffprobe scripts that print a version line */
  function fakeZip(version: string): Buffer {
    const d = tmp();
    const src = join(d, "src", "bin");
    mkdirSync(src, { recursive: true });
    for (const p of ["ffmpeg", "ffprobe"]) {
      writeFileSync(join(src, p), `#!/bin/sh\necho "${p} version ${version} Copyright (c) the FFmpeg developers"\n`);
      chmodSync(join(src, p), 0o755);
    }
    const zip = join(d, "a.zip");
    const r = spawnSync("/usr/bin/tar", ["-a", "-cf", zip, "-C", join(d, "src"), "bin"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return readFileSync(zip);
  }

  const build = (url: string, sha256: string): FfmpegBuild => ({ version: "9.0.2", publisher: "test", licence: "test", archives: [{ url, sha256, maxBytes: 1_000_000, programs: ["ffmpeg", "ffprobe"] }] });

  it("refuses a download whose SHA-256 doesn't match; nothing is installed", async () => {
    files["/bad.zip"] = Buffer.from("this is not the pinned archive");
    const dir = tmp();
    await expect(installFfmpeg(build(`${base}/bad.zip`, "0".repeat(64)), dir)).rejects.toThrow(/checksum mismatch.*Nothing was installed/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses an oversized download", async () => {
    files["/big.zip"] = Buffer.alloc(2_000_000);
    const dir = tmp();
    await expect(installFfmpeg(build(`${base}/big.zip`, sha(files["/big.zip"])), dir)).rejects.toThrow(/larger than expected/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses plain HTTP to anything but this machine", async () => {
    await expect(installFfmpeg(build("http://example.com/ffmpeg.zip", "0".repeat(64)), tmp())).rejects.toThrow(/non-HTTPS/);
  });

  // bsdtar (macOS, Windows) unpacks zips; GNU tar on Linux doesn't, and the download is only for macOS / Windows
  it.skipIf(process.platform !== "darwin")("installs a verified build that reports the pinned version", async () => {
    files["/good.zip"] = fakeZip("9.0.2");
    const dir = tmp();
    const p = await installFfmpeg(build(`${base}/good.zip`, sha(files["/good.zip"])), dir);
    expect(p).toEqual({ ffmpeg: join(dir, "ffmpeg"), ffprobe: join(dir, "ffprobe"), source: "private" });
    expect(readdirSync(dir).sort()).toEqual(["SOURCE.json", "ffmpeg", "ffprobe"]);
    expect(JSON.parse(readFileSync(join(dir, "SOURCE.json"), "utf8"))).toMatchObject({ version: "9.0.2", archives: [{ sha256: sha(files["/good.zip"]) }] });
    expect(locateFfmpeg({ dir, pathEnv: "", config: {} }).found?.source).toBe("private");
  });

  it.skipIf(process.platform !== "darwin")("refuses a build that reports another version", async () => {
    files["/old.zip"] = fakeZip("4.4");
    const dir = tmp();
    await expect(installFfmpeg(build(`${base}/old.zip`, sha(files["/old.zip"])), dir)).rejects.toThrow(/did not start correctly/);
    expect(existsSync(join(dir, "ffmpeg"))).toBe(false);
  });
});
