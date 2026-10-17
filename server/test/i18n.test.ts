// A simulated German After Effects: display names are translated, match names are not.
import { describe, expect, it } from "vitest";

function prop(name: string, matchName: string, children: any[] = []) {
  const p: any = { name, matchName, numProperties: children.length, propertyType: children.length ? 2 : 1 };
  p.property = (k: any) => {
    if (typeof k === "number") return children[k - 1] ?? null;
    return children.find((c) => c.name === k || c.matchName === k) ?? null;
  };
  return p;
}

async function loadHelpers() {
  const { helperSource } = await import("../src/jsx.js");
  const g: any = { aemcp: undefined };
  const fn = new Function("$", "app", "PropertyType", "var aemcp;\n" + helperSource + "\nreturn aemcp;");
  return fn({ global: g }, { effects: [] }, { PROPERTY: 1, NAMED_GROUP: 2, INDEXED_GROUP: 3 });
}

describe("English names in a translated After Effects", () => {
  const layer = prop("Ebene", "ADBE AV Layer", [
    prop("Transformieren", "ADBE Transform Group", [prop("Position", "ADBE Position"), prop("Deckkraft", "ADBE Opacity"), prop("Drehung", "ADBE Rotate Z")]),
    prop("Effekte", "ADBE Effect Parade", [prop("Gaußscher Weichzeichner", "ADBE Gaussian Blur 2", [prop("Stärke", "ADBE Gaussian Blur 2-0001")])]),
    prop("Masken", "ADBE Mask Parade"),
  ]);

  it("resolves English property paths through match-name aliases", async () => {
    const aemcp = await loadHelpers();
    expect(aemcp.resolveProp(layer, "Transform/Opacity").name).toBe("Deckkraft");
    expect(aemcp.resolveProp(layer, "Transform/Rotation").name).toBe("Drehung");
    expect(aemcp.resolveProp(layer, "transform/position").name).toBe("Position");
    // translated names still work, and match names always do
    expect(aemcp.resolveProp(layer, "Transformieren/Deckkraft").matchName).toBe("ADBE Opacity");
    expect(aemcp.resolveProp(layer, ["ADBE Transform Group", "ADBE Opacity"]).name).toBe("Deckkraft");
  });

  it("finds an applied effect by its English name, and its parameters by match name", async () => {
    const aemcp = await loadHelpers();
    expect(aemcp.resolveProp(layer, "Effects/Gaussian Blur").name).toBe("Gaußscher Weichzeichner");
    expect(aemcp.resolveProp(layer, "Effects/Gaussian Blur/ADBE Gaussian Blur 2-0001").name).toBe("Stärke");
  });

  it("maps common English menu commands to fixed command ids", async () => {
    const aemcp = await loadHelpers();
    expect(aemcp.commandId("Pre-compose...")).toBe(2071);
    expect(aemcp.commandId("Convert Audio to Keyframes")).toBe(4218);
    expect(aemcp.commandId("undo")).toBe(16);
    expect(aemcp.commandId(1234)).toBe(1234);
  });
});
