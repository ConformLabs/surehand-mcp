// Precomp surgery's expression reader and rewriter (src/surgery/expr.ts) as pure functions: strings in, references and
// rewritten strings out. Quotes, escapes, comments, template literals, local variables that shadow After Effects'
// globals, computed references, and legacy ExtendScript expressions.
import { describe, expect, it } from "vitest";
import { analyzeExpression, applyEdits, literal, snippet } from "../src/surgery/expr.js";

const refs = (src: string) => analyzeExpression(src).comps.map((c) => ({ self: c.self, name: c.name, use: c.use.kind === "layer" ? `layer:${c.use.by}:${c.use.by === "name" ? c.use.name : c.use.by === "index" ? c.use.index : c.use.text}` : c.use.kind === "member" ? `member:${c.use.name}` : `escape:${c.use.text}` }));

describe("what an expression refers to", () => {
  it("thisComp.layer by name and by index, with exact positions", () => {
    const src = 'thisComp.layer("Logo").transform.position + thisComp.layer(3).transform.position';
    const f = analyzeExpression(src);
    expect(f.ok).toBe(true);
    expect(refs(src)).toEqual([
      { self: true, name: null, use: "layer:name:Logo" },
      { self: true, name: null, use: "layer:index:3" },
    ]);
    const [a, b] = f.comps;
    expect(src.slice(...(a.use as any).argRange)).toBe('"Logo"');
    expect(src.slice(...(b.use as any).argRange)).toBe("3");
    expect(src.slice(...a.range)).toBe("thisComp");
  });

  it("comp(\"X\") with every quote style, escapes and template literals without substitutions", () => {
    expect(refs(`comp("A \\"B\\"").layer('C\\'s').opacity`)).toEqual([{ self: false, name: 'A "B"', use: "layer:name:C's" }]);
    expect(refs("comp(`Logo`).layer(`Title`)")).toEqual([{ self: false, name: "Logo", use: "layer:name:Title" }]);
    // a template with a substitution is computed
    expect(refs("comp(`Logo ${n}`).width")).toEqual([{ self: false, name: null, use: "member:width" }]);
    // a comp's name in brackets: comp("X")["layer"]("Y") is still a layer by name
    expect(refs('comp("X")["layer"]("Y")')).toEqual([{ self: false, name: "X", use: "layer:name:Y" }]);
  });

  it("ignores comments, strings and regex literals", () => {
    const src = '// thisComp.layer("A")\n/* comp("B").layer(1) */ var s = "thisComp.layer(\'C\')"; var r = /comp\\("D"\\)/; 5';
    expect(analyzeExpression(src).comps).toEqual([]);
  });

  it("computed references are computed: variables, arithmetic, two-argument layer()", () => {
    expect(refs("var n = 'A'; thisComp.layer(n)")).toEqual([{ self: true, name: null, use: "layer:dynamic:thisComp.layer(n)" }]);
    expect(refs("thisComp.layer(index + 1)")).toEqual([{ self: true, name: null, use: "layer:dynamic:thisComp.layer(index + 1)" }]);
    expect(refs("thisComp.layer(thisLayer, -1)")).toEqual([{ self: true, name: null, use: "layer:dynamic:thisComp.layer(thisLayer, -1)" }]);
    expect(refs('comp(name + " 2").layer(1)')).toEqual([{ self: false, name: null, use: "layer:index:1" }]);
    expect(refs("var c = thisComp; c.layer(1)")).toEqual([{ self: true, name: null, use: "escape:c = thisComp" }]);
    expect(refs("thisComp[k]")).toEqual([{ self: true, name: null, use: "escape:thisComp[k]" }]);
    expect(refs("var L = thisComp.layer; L(1)")[0].use).toBe("escape:thisComp.layer");
  });

  it("After Effects' globals only: a local variable or parameter of the same name is not one", () => {
    const f = analyzeExpression("function f(time, index) { return time * index } var thisComp = 3; f(time, index) + thisComp");
    expect(f.time).toHaveLength(1);
    expect(f.index).toHaveLength(1);
    expect(f.comps).toEqual([]);
    const g = analyzeExpression("var comp = function (x) { return x }; comp('A')");
    expect(g.comps).toEqual([]);
  });

  it("index, time, random seeds, comp-space conversions, parent and source", () => {
    const f = analyzeExpression("seedRandom(index, true); wiggle(2, 30) + random(5) + thisLayer.index + toComp([0,0]) + transform.position.wiggle(1,1) + thisLayer.fromWorld([0,0]) + (hasParent ? parent.index : 0) + source.width + time");
    expect(f.index).toHaveLength(2);
    expect(f.time).toHaveLength(1);
    expect(f.random.sort()).toEqual(["random", "seedRandom", "wiggle", "wiggle"]);
    expect(f.space.sort()).toEqual(["fromWorld", "toComp"]);
    expect(f.parent).toBe(true);
    expect(f.source).toBe(true);
  });

  it("legacy names: this_comp and this_layer", () => {
    expect(refs('this_comp.layer("A").position')).toEqual([{ self: true, name: null, use: "layer:name:A" }]);
    expect(analyzeExpression("this_layer.index").index).toHaveLength(1);
  });

  it("legacy ExtendScript syntax Babel can't parse: fine when it mentions nothing that matters, refused otherwise", () => {
    expect(analyzeExpression("if (value[0] > 5) [1, 2] else [3, 4]")).toMatchObject({ ok: true, lenient: true, comps: [] });
    const bad = analyzeExpression('if (a) thisComp.layer("X").opacity else 0');
    expect(bad.ok).toBe(false);
    expect(bad.parseError).toMatch(/semicolon|Unexpected/i);
  });

  it("eval is reported", () => {
    expect(analyzeExpression("eval('thisComp.layer(1)')").evalUsed).toBe(true);
  });

  it("optional chaining and parentheses", () => {
    expect(refs('(thisComp).layer("A")?.opacity')).toEqual([{ self: true, name: null, use: "layer:name:A" }]);
    expect(refs('comp("A")?.layer(2)')).toEqual([{ self: false, name: "A", use: "layer:index:2" }]);
  });
});

describe("rewriting by position", () => {
  it("literal keeps the quote style and escapes what it must", () => {
    expect(literal('Say "hi"', '"')).toBe('"Say \\"hi\\""');
    expect(literal("It's", "'")).toBe("'It\\'s'");
    expect(literal("a`b${c}\\", "`")).toBe("`a\\`b\\${c}\\\\`");
    expect(literal("two\nlines", '"')).toBe('"two\\nlines"');
    // the literal reads back as the same value
    for (const [v, qq] of [['x"y\\z', '"'], ["x'y", "'"], ["a`${b}", "`"]] as const) expect(eval(literal(v, qq))).toBe(v);
  });

  it("applyEdits replaces exact ranges, right to left, and refuses overlaps", () => {
    const src = 'thisComp.layer("A").position + thisComp.layer("A").scale';
    const f = analyzeExpression(src);
    const edits = f.comps.map((c) => ({ range: (c.use as any).argRange, text: literal("A 2", (c.use as any).quote) }));
    expect(applyEdits(src, edits)).toBe('thisComp.layer("A 2").position + thisComp.layer("A 2").scale');
    expect(() => applyEdits("abc", [{ range: [0, 2], text: "x" }, { range: [1, 3], text: "y" }])).toThrow(/overlapping/);
  });

  it("a name inside a comment next to the reference is left alone", () => {
    const src = '// was "A"\nthisComp.layer("A") // "A"';
    const c = analyzeExpression(src).comps[0];
    expect(applyEdits(src, [{ range: (c.use as any).argRange, text: '"A 2"' }])).toBe('// was "A"\nthisComp.layer("A 2") // "A"');
  });

  it("snippet shows before and after around the edit", () => {
    const src = 'var p = thisComp.layer("Logo").transform.position;\np + [10, 0]';
    const c = analyzeExpression(src).comps[0];
    expect(snippet(src, [{ range: (c.use as any).argRange, text: '"Logo 2"' }], 8)).toBe('…thisComp.layer("Logo").transform… → …thisComp.layer("Logo 2").transform…');
  });
});
