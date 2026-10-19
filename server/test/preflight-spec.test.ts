import { describe, expect, it } from "vitest";
import { areaMargins, loadSpec } from "../src/preflight/spec.js";

describe("preflight spec", () => {
  it("accepts a full spec and an empty one", () => {
    expect(loadSpec({})).toEqual({});
    const s = loadSpec({
      name: "Broadcast",
      video: { width: 1920, height: 1080, frameRate: 25, duration: { min: 29.9, max: 30 }, codec: ["prores"], bitDepth: 10 },
      safeAreas: { action: 0.035, title: { x: 0.1, y: 0.05 }, layersMustBeIn: [{ layer: "Logo*", area: "action" }] },
      legalRange: { luma: { min: 16, max: 235 } },
      audio: { integratedLUFS: -23, maxTruePeakDBTP: -1 },
      flash: { check: true },
    });
    expect(areaMargins(s, "title")).toEqual({ x: 0.1, y: 0.05 });
    expect(areaMargins(s, "action")).toEqual({ x: 0.035, y: 0.035 });
    expect(areaMargins(s, "frame")).toEqual({ x: 0, y: 0 });
  });

  it("names the wrong field", () => {
    expect(() => loadSpec({ video: { widht: 1920 } })).toThrow(/video/);
    expect(() => loadSpec({ safeAreas: { title: 0.9 } })).toThrow(/safeAreas\.title/);
    expect(() => loadSpec("/nonexistent/spec.json")).toThrow(/Could not read the spec file/);
  });
});
