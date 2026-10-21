// Text Surehand writes is left to right unless it has right-to-left characters, whatever the user's AE type preference
// (After Effects can make new text right to left with the Universal composer). Runs the real tool JSX in the fake AE.
import { describe, expect, it } from "vitest";
import { fakeProject } from "./fake-ae.js";
import { layerTools } from "../src/tools/layer.js";

const jsx = (name: string) => layerTools.find((t) => t.name === name)!.jsx;
const doc = (fp: ReturnType<typeof fakeProject>, i: number) => fp.comps[0].layer(i).property("ADBE Text Properties").property("ADBE Text Document").value;
const LTR = 7612, RTL = 7613, LATIN = 7812, UNIVERSAL = 7813;

describe("ae_add_layer text with the user's right-to-left default", () => {
  const project = (o: { noRtlApi?: boolean } = {}) =>
    fakeProject({ comps: [{ name: "Main", layers: [{ name: "Old", type: "text", text: "Keep me", direction: "DIRECTION_RIGHT_TO_LEFT", composer: "UNIVERSAL_TYPE_ENGINE" }] }], newTextRtl: true, ...o });

  it("Latin text becomes left to right; other text layers keep theirs", () => {
    const fp = project();
    const res = fp.run(jsx("ae_add_layer"), { comp: "Main", type: "text", text: "Hello, world." });
    expect(res.ok).toBe(true);
    expect(doc(fp, 2).direction).toBe(LTR);
    expect(doc(fp, 1).direction).toBe(RTL);
    expect(doc(fp, 1)._ce).toBe(UNIVERSAL);
  });

  it("asks for the Latin composer only where AE allows it, without failing", () => {
    const fp = project();
    expect(fp.run(jsx("ae_add_layer"), { comp: "Main", type: "text", text: "Title" }).ok).toBe(true);
    // the fake (like AE 24+) only lets scripts write the Universal engine: the attempt is caught, the direction is still set
    expect([LATIN, UNIVERSAL]).toContain(doc(fp, 2)._ce);
    expect(doc(fp, 2).direction).toBe(LTR);
  });

  it("an empty new text layer and paragraph text are left to right too", () => {
    const fp = project();
    expect(fp.run(jsx("ae_add_layer"), { comp: "Main", type: "text" }).ok).toBe(true);
    expect(fp.run(jsx("ae_add_layer"), { comp: "Main", type: "text", text: "Box", boxSize: [400, 200] }).ok).toBe(true);
    expect(doc(fp, 2).direction).toBe(LTR);
    expect(doc(fp, 3).direction).toBe(LTR);
  });

  it("Hebrew or Arabic text is left to After Effects", () => {
    const fp = project();
    fp.run(jsx("ae_add_layer"), { comp: "Main", type: "text", text: "שלום עולם" });
    fp.run(jsx("ae_add_layer"), { comp: "Main", type: "text", text: "Sale מבצע 50%" });
    fp.run(jsx("ae_add_layer"), { comp: "Main", type: "text", text: "مرحبا" });
    for (const i of [2, 3, 4]) expect(doc(fp, i).direction).toBe(RTL);
  });

  it("an asked-for direction wins", () => {
    const fp = project();
    fp.run(jsx("ae_add_layer"), { comp: "Main", type: "text", text: "Hello", direction: "RIGHT_TO_LEFT" });
    expect(doc(fp, 2).direction).toBe(RTL);
  });

  it("After Effects before 24.0 (no ParagraphDirection) still adds the layer", () => {
    const fp = project({ noRtlApi: true });
    const res = fp.run(jsx("ae_add_layer"), { comp: "Main", type: "text", text: "Hello" });
    expect(res.ok).toBe(true);
    expect(doc(fp, 2).direction).toBeUndefined();
  });
});

describe("ae_set_text", () => {
  const project = () => fakeProject({ comps: [{ name: "Main", layers: [{ name: "T", type: "text", text: "שלום", direction: "DIRECTION_RIGHT_TO_LEFT", composer: "UNIVERSAL_TYPE_ENGINE" }] }] });

  it("new Latin content is left to right (the composer is not touched on an existing layer)", () => {
    const fp = project();
    const res = fp.run(jsx("ae_set_text"), { comp: "Main", layer: 1, text: "Hello" });
    expect(res.ok).toBe(true);
    expect(doc(fp, 1).direction).toBe(LTR);
    expect(doc(fp, 1)._ce).toBe(UNIVERSAL);
    expect(res.result.direction).toBe("LEFT_TO_RIGHT");
  });

  it("styling without new text keeps the layer's direction", () => {
    const fp = project();
    fp.run(jsx("ae_set_text"), { comp: "Main", layer: 1, fontSize: 80 });
    expect(doc(fp, 1).direction).toBe(RTL);
  });

  it("new Hebrew content keeps right to left", () => {
    const fp = project();
    fp.run(jsx("ae_set_text"), { comp: "Main", layer: 1, text: "תודה" });
    expect(doc(fp, 1).direction).toBe(RTL);
  });

  it("a Source Text value set as a plain string (ae_set_property) follows the same rule", () => {
    const fp = project();
    const res = fp.run(`var p = aemcp.findLayer(aemcp.findComp("Main"), 1).property("ADBE Text Properties").property("ADBE Text Document"); p.setValue(aemcp.toAEValue(p, "Hi")); return 1;`, {});
    expect(res.ok).toBe(true);
    expect(doc(fp, 1).direction).toBe(LTR);
  });
});
