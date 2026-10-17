import { describe, expect, it } from "vitest";
import { HELPER_VERSION, helperSource, parseResult, toJsLiteral, userCodeBody, wrapBody, NEED_HELPERS } from "../src/jsx.js";
import { projectTools } from "../src/tools/project.js";
import { compTools } from "../src/tools/comp.js";
import { layerTools } from "../src/tools/layer.js";
import { propertyTools } from "../src/tools/property.js";
import { effectTools } from "../src/tools/effects.js";
import { renderTools } from "../src/tools/render.js";
import { appTools } from "../src/tools/app.js";
import { inspectTools } from "../src/tools/inspect.js";

const allTools = [...projectTools, ...compTools, ...layerTools, ...propertyTools, ...effectTools, ...renderTools, ...appTools, ...inspectTools];

/** Rough ES3 lint: things ExtendScript cannot parse. */
function es3Problems(src: string): string[] {
  const stripped = src.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""').replace(/\/\/.*$/gm, "");
  const probs: string[] = [];
  if (/\b(let|const)\s/.test(stripped)) probs.push("let/const");
  if (/=>/.test(stripped)) probs.push("arrow function");
  if (/`/.test(stripped)) probs.push("template literal");
  if (/\.(map|filter|forEach|reduce|includes|indexOf)\(/.test(stripped) && /\.(map|filter|forEach|reduce|includes)\(/.test(stripped)) probs.push("ES5 array method");
  if (/\bJSON\./.test(stripped)) probs.push("JSON object");
  // ES3 reserves these (ExtendScript fails with e.g. "Expected: (" on `function short(...)`)
  const reserved = "abstract|boolean|byte|char|class|const|debugger|double|enum|export|extends|final|float|goto|implements|import|int|interface|long|native|package|private|protected|public|short|static|super|synchronized|throws|transient|volatile";
  const decl = new RegExp(`\\b(?:var|function)\\s+(${reserved})\\b|[(,]\\s*(${reserved})\\s*[,)]|\\.(${reserved})\\b(?!\\s*:)|(?<![.\\w])(${reserved})\\s*\\(`);
  const m = stripped.match(decl);
  if (m) probs.push(`reserved word: ${m[1] || m[2] || m[3] || m[4]}`);
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
    // the library itself defines the JSON polyfill, so allow JSON references there
    expect(es3Problems(helperSource).filter((p) => p !== "JSON object")).toEqual([]);
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

describe("update check", () => {
  it("compares versions", async () => {
    const { compareVersions } = await import("../src/update.js");
    expect(compareVersions("1.1.0", "1.0.9")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.10.0")).toBe(-1);
  });
});

describe("tool profiles", () => {
  it("resolves core, full, extras and the .mcpb checkbox values", async () => {
    const { resolveProfile } = await import("../src/tools/profile.js");
    const saved = process.env.AEMCP_TOOLS;
    process.env.AEMCP_CONFIG = "/nonexistent/config.json";
    delete process.env.AEMCP_TOOLS;
    expect(resolveProfile([]).name).toBe("core");
    expect(resolveProfile(["--tools", "full"]).allows("ae_import_files")).toBe(true);
    const custom = resolveProfile(["--tools", "core,ae_import_files"]);
    expect(custom.allows("ae_import_files") && custom.allows("ae_run_script") && !custom.allows("ae_purge")).toBe(true);
    process.env.AEMCP_TOOLS = "true";
    expect(resolveProfile([]).name).toBe("full");
    process.env.AEMCP_TOOLS = "false"; // checkbox off -> falls through to config (default core)
    expect(resolveProfile([]).name).toBe("core");
    if (saved === undefined) delete process.env.AEMCP_TOOLS;
    else process.env.AEMCP_TOOLS = saved;
  });

  it("every core tool exists", async () => {
    const { CORE_TOOLS } = await import("../src/tools/profile.js");
    const names = new Set(allTools.map((t) => t.name));
    for (const n of ["ae_status", "ae_run_script", "ae_get_scripting_guide", "ae_render_frame", "ae_render_contact_sheet"]) names.add(n);
    for (const t of CORE_TOOLS) expect(names.has(t), t).toBe(true);
  });
});

describe("modern JavaScript support", () => {
  const sample = `
const items = [1, 2, 3, 4];
const doubled = items.filter((n) => n % 2 === 0).map((n) => n * 2);
const { a = 5, ...rest } = args;
const label = \`total \${doubled.reduce((s, n) => s + n, 0)}\`;
class Box { constructor(w, h = 2) { this.w = w; this.h = h; } area() { return this.w * this.h; } }
let sum = 0;
for (const n of items) sum += n;
const maybe = args.missing?.deep ?? "fallback";
return { doubled, a, rest, label, area: new Box(3).area(), sum, maybe, spread: [...items, 5], obj: { ...rest, x: 1 } };`;

  it("converts modern syntax to ES3-style code that keeps working", async () => {
    const { transpileUserCode } = await import("../src/transpile.js");
    const t = transpileUserCode(sample);
    expect(t.transpiled).toBe(true);
    const stripped = t.source.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
    expect(/\b(let|const)\s/.test(stripped)).toBe(false);
    expect(/=>/.test(stripped)).toBe(false);
    expect(/`/.test(stripped)).toBe(false);
    expect(/\?\.|\?\?/.test(stripped)).toBe(false);
    expect(/\bclass\s/.test(stripped)).toBe(false);
    const fn = (0, eval)(t.source);
    expect(fn({ a: 1, b: 2, c: 3 }, () => {})).toEqual({
      doubled: [4, 8], a: 1, rest: { b: 2, c: 3 }, label: "total 12", area: 6, sum: 10, maybe: "fallback",
      spread: [1, 2, 3, 4, 5], obj: { b: 2, c: 3, x: 1 },
    });
  });

  it("keeps line numbers aligned with the original code", async () => {
    const { transpileUserCode } = await import("../src/transpile.js");
    const code = "const a = 1;\nconst b = 2;\nnull.boom();";
    const t = transpileUserCode(code);
    // the user's line 3 is still line 3 of the source AE evaluates
    expect(t.source.split("\n")[2]).toContain("boom");
  });

  it("reports syntax errors with Babel's code frame and passes ExtendScript-only code through", async () => {
    const { transpileUserCode } = await import("../src/transpile.js");
    const bad = transpileUserCode("const x = ;\nreturn x;");
    expect(bad.transpiled).toBe(false);
    expect(bad.syntaxError).toMatch(/Unexpected token/);
    expect(transpileUserCode('#include "lib.jsx"\nreturn 1;').transpiled).toBe(false);
    expect(transpileUserCode("return 1;", false).transpiled).toBe(false);
  });

  it("formats code excerpts and hints", async () => {
    const { codeExcerpt, errorHint } = await import("../src/jsx.js");
    expect(codeExcerpt("a\nb\nc\nd\ne", 3)).toBe("  1 | a\n  2 | b\n> 3 | c\n  4 | d\n  5 | e");
    expect(errorHint("After Effects error: Object is invalid")).toMatch(/no longer exists/);
    expect(errorHint("index out of range")).toMatch(/1-based/);
  });
});

describe("helper loader", () => {
  it("defines aemcp globally when evaluated inside the loader function", async () => {
    const { helperLoader } = await import("../src/jsx.js");
    const g: any = globalThis as any;
    const saved = { aemcp: g.aemcp, $: g.$, app: g.app };
    g.$ = { global: {} };
    g.app = {};
    try {
      expect((0, eval)(helperLoader)).toMatch(/^aemcp loaded test-/);
      expect(typeof g.aemcp.run).toBe("function");
    } finally {
      g.aemcp = saved.aemcp; g.$ = saved.$; g.app = saved.app;
    }
  });
});

/**
 * ExtendScript parses chained conditionals left-associatively: `a ? x : b ? y : z` runs as
 * `(a ? x : b) ? y : z`. Any conditional nested in another one must be parenthesized.
 */
function unparenthesizedNestedTernaries(ast: any, src: string): string[] {
  const found: string[] = [];
  const visit = (node: any) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "ConditionalExpression") {
      for (const k of ["test", "consequent", "alternate"]) {
        if (node[k]?.type === "ConditionalExpression") found.push(src.slice(node.start, Math.min(node.end, node.start + 90)));
      }
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object" && typeof v.type === "string") visit(v);
    }
  };
  visit(ast);
  return found;
}

describe("strict ES3 parse (what After Effects' engine accepts)", () => {
  const parseES3 = async (src: string) => {
    const { parse } = await import("acorn");
    const ast = parse(src, { ecmaVersion: 3, sourceType: "script", allowReserved: false, preserveParens: true } as any);
    expect(unparenthesizedNestedTernaries(ast, src), "nested ?: must be parenthesized for ExtendScript").toEqual([]);
  };
  it("helper library", async () => {
    const { helperSource } = await import("../src/jsx.js");
    await parseES3(helperSource);
  });
  it("loader and wrapper", async () => {
    const { helperLoader, wrapBody } = await import("../src/jsx.js");
    await parseES3(helperLoader);
    await parseES3(wrapBody("return 1;", { a: 1 }));
  });
  for (const t of allTools) {
    it(`tool ${t.name}`, async () => {
      await parseES3(`(function(args, log){${t.jsx}\n})`);
    });
  }
  it("preview tools (frame, contact sheet)", async () => {
    const { RENDER_FRAME_JSX, CONTACT_SHEET_JSX } = await import("../src/tools/core.js");
    await parseES3(`(function(args, log){${RENDER_FRAME_JSX}\n})`);
    await parseES3(`(function(args, log){${CONTACT_SHEET_JSX}\n})`);
  });
  it("transpiled modern code", async () => {
    const { transpileUserCode } = await import("../src/transpile.js");
    const t = transpileUserCode("const a = [1, 2].map((x) => x * 2);\nclass K { m() { return a?.[0] ?? 0; } }\nconst { p = 1, ...r } = args;\nreturn [...a, new K().m(), p, r];");
    await parseES3(t.source);
    // chained conditionals / nullish chains, as AI-written code often has them
    const n = transpileUserCode("const v = args.a ? 1 : args.b ? 2 : 3;\nconst w = args.x?.y ?? args.z?.q ?? 0;\nreturn [v, w];");
    await parseES3(n.source);
    expect((0, eval)(n.source)({ b: true, z: { q: 7 } }, () => {})).toEqual([2, 7]);
  });
});
