import { describe, expect, it } from "vitest";
import { HELPER_VERSION, helperSource, parseResult, toJsLiteral, userCodeBody, wrapBody, NEED_HELPERS } from "../src/jsx.js";
import { projectTools } from "../src/tools/project.js";
import { compTools } from "../src/tools/comp.js";
import { layerTools } from "../src/tools/layer.js";
import { propertyTools } from "../src/tools/property.js";
import { effectTools } from "../src/tools/effects.js";
import { renderTools } from "../src/tools/render.js";
import { appTools } from "../src/tools/app.js";

const allTools = [...projectTools, ...compTools, ...layerTools, ...propertyTools, ...effectTools, ...renderTools, ...appTools];

/** Rough ES3 lint: things ExtendScript cannot parse. */
function es3Problems(src: string): string[] {
  const stripped = src.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""').replace(/\/\/.*$/gm, "");
  const probs: string[] = [];
  if (/\b(let|const)\s/.test(stripped)) probs.push("let/const");
  if (/=>/.test(stripped)) probs.push("arrow function");
  if (/`/.test(stripped)) probs.push("template literal");
  if (/\.(map|filter|forEach|reduce|includes|indexOf)\(/.test(stripped) && /\.(map|filter|forEach|reduce|includes)\(/.test(stripped)) probs.push("ES5 array method");
  if (/\bJSON\./.test(stripped)) probs.push("JSON object");
  return probs;
}

describe("wrapper", () => {
  it("toJsLiteral escapes line separators", () => {
    expect(toJsLiteral("a b")).toBe('"a\\u2028b"');
    expect(toJsLiteral(undefined)).toBe("null");
  });

  it("wrapBody is valid JS and checks helper version", () => {
    const s = wrapBody("return 1;", { a: 1 }, { undoGroup: false });
    expect(() => new Function(s)).not.toThrow();
    expect(s).toContain(NEED_HELPERS);
    expect(s).toContain('{"a":1}');
  });

  it("wrapped script runs against a fake aemcp", () => {
    const s = wrapBody("log('x'); return args.a + 1;", { a: 41 }, {});
    const aemcp = {
      version: HELPER_VERSION,
      run: (fn: any, args: any) => {
        const logs: string[] = [];
        return JSON.stringify({ ok: true, result: fn(args, (m: string) => logs.push(m)), logs });
      },
    };
    const out = new Function("aemcp", "return " + s)(aemcp);
    expect(parseResult(out)).toEqual({ ok: true, result: 42, logs: ["x"] });
    // wrong helper version -> asks for helpers
    expect(new Function("aemcp", "return " + s)({ ...aemcp, version: "old" })).toBe(NEED_HELPERS);
  });

  it("userCodeBody compiles user code lazily so syntax errors are catchable", () => {
    const body = userCodeBody("return args.x * 2;");
    const fn = new Function("args", "log", body);
    expect(fn({ x: 21 }, () => {})).toBe(42);
    const bad = new Function("args", "log", userCodeBody("return {;"));
    expect(() => bad({}, () => {})).toThrow(SyntaxError);
  });

  it("parseResult handles AE's opaque error and plain strings", () => {
    expect(parseResult("EvalScript error.").ok).toBe(false);
    expect(parseResult("hello")).toEqual({ ok: true, result: "hello", logs: [] });
    expect(parseResult('{"ok":false,"error":{"message":"boom","line":3},"logs":[]}').error?.line).toBe(3);
  });
});

describe("ExtendScript sources", () => {
  it("helper library parses and defines aemcp", () => {
    expect(helperSource).toMatch(/A\.version = "test-[0-9a-f]{10}"/);
    const aemcp = new Function("$", "app", "var aemcp;\n" + helperSource + "\nreturn aemcp;")({ global: {} }, {});
    expect(aemcp.version).toMatch(/^test-/);
    expect(aemcp.stringify({ a: [1, "x\n", true, null], b: undefined })).toBe('{"a":[1,"x\\n",true,null]}');
  });

  it("helper library is ES3", () => {
    expect(es3Problems(helperSource)).toEqual([]);
  });

  it("tool names are unique", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const t of allTools) {
    it(`${t.name} JSX parses and is ES3`, () => {
      expect(() => new Function("args", "log", "aemcp", t.jsx)).not.toThrow();
      expect(es3Problems(t.jsx)).toEqual([]);
    });
  }
});
