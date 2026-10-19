import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/preflight/ffmpeg.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    ensureFfmpeg: vi.fn(async (o: { allowDownload?: boolean }) => {
      throw o.allowDownload ? new Error("Downloading FFmpeg 9.0.2 failed: offline. Nothing was installed.") : new real.FfmpegMissingError("ffmpeg / ffprobe were not found (install hint).");
    }),
  };
});

const { checkFile } = await import("../src/preflight/media.js");
const { loadSpec } = await import("../src/preflight/spec.js");

describe("no ffmpeg", () => {
  const f = join(mkdtempSync(join(tmpdir(), "aemcp-noff-")), "out.mov");
  writeFileSync(f, "x");
  const spec = loadSpec({ video: { width: 1920 }, legalRange: {}, black: { maxSeconds: 0 }, flash: { check: true } });

  it("skips every file check with the install hint", async () => {
    const r = await checkFile(f, spec);
    expect(r.findings).toEqual([]);
    expect(r.skipped).toEqual([
      "video properties: ffmpeg / ffprobe were not found (install hint).",
      "legalRange: ffmpeg / ffprobe were not found (install hint).",
      "black: ffmpeg / ffprobe were not found (install hint).",
      "flash: ffmpeg / ffprobe were not found (install hint).",
    ]);
  });

  it("a failed download is reported the same way", async () => {
    const r = await checkFile(f, loadSpec({ audio: { integratedLUFS: -23 } }), { allowDownload: true });
    expect(r.skipped).toEqual(["audio: Downloading FFmpeg 9.0.2 failed: offline. Nothing was installed."]);
  });
});
