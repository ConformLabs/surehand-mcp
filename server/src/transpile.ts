// Modern JavaScript -> ES3-compatible code for After Effects' ExtendScript engine.
// Babel keeps line numbers (retainLines), so error lines still match the code the AI wrote.
// Runtime built-ins the output needs (map, bind, Object.defineProperty...) are polyfilled by
// the aemcp helper library inside After Effects.
import * as Babel from "@babel/standalone";

export interface TranspileResult {
  /** Function-expression source to eval in AE: "(function(args, log){ ... })" */
  source: string;
  transpiled: boolean;
  /** Babel's syntax error (with a code frame) when the code could not be parsed */
  syntaxError?: string;
  /** ES3 reserved words used as names that aren't declared in the code, so they can't be renamed */
  reservedGlobals?: string[];
}

const PREFIX = "(function(args, log){";

/** ExtendScript-only syntax that a standard JS parser rejects; such code is passed through untouched. */
function extendScriptOnly(code: string): boolean {
  return /^\s*#(include|target|targetengine|strict|script|includepath)\b/m.test(code) || /<[A-Za-z][\w:.-]*[\s>][\s\S]*<\/[A-Za-z]/.test(code) && /=\s*<[A-Za-z]/.test(code);
}

export function transpileUserCode(code: string, enabled = true): TranspileResult {
  const plain = PREFIX + code + "\n})";
  if (!enabled || extendScriptOnly(code)) return { source: plain, transpiled: false };
  try {
    const out = Babel.transform(plain, {
      presets: [["env", { targets: { ie: "11" }, modules: false }]],
      assumptions: {
        iterableIsArray: true, // for...of / spread over arrays -> plain index loops
        objectRestNoSymbols: true,
        setSpreadProperties: true,
        noClassCalls: true,
        constantSuper: true,
        setPublicClassFields: true,
        privateFieldsAsProperties: true,
      },
      sourceType: "script",
      retainLines: true,
      comments: false,
      compact: false,
      babelrc: false,
      configFile: false,
    } as any).code as string;
    const es3 = es3Pass(out);
    const result: TranspileResult = { source: es3.code.replace(/;\s*$/, ""), transpiled: true };
    if (es3.reservedGlobals.length) result.reservedGlobals = es3.reservedGlobals;
    return result;
  } catch (e: any) {
    // Not valid modern JS: run it as written (ExtendScript may still accept it) and keep
    // Babel's much clearer message in case AE rejects it too.
    return { source: plain, transpiled: false, syntaxError: cleanSyntaxError(String(e?.message || e)) };
  }
}

/** Hint for a failed script that uses reserved words as undeclared globals (see TranspileResult.reservedGlobals). */
export function reservedGlobalsHint(names: string[] | undefined): string | null {
  if (!names?.length) return null;
  const list = names.map((n) => `"${n}"`).join(", ");
  return `Reserved in After Effects' ExtendScript (ES3) and used without a declaration, so not renamed automatically: ${list}. Declare these names with let/const/var (declared names are renamed) or use other names.`;
}

/**
 * Fixes for what ExtendScript's ES3 parser rejects in otherwise valid ES5 code. Runs as a separate
 * pass so it also covers code that preset-env generates (e.g. conditionals for ?. and ??).
 * - ExtendScript nests conditionals left-to-right (`a ? x : b ? y : z` runs as `(a ? x : b) ? y : z`),
 *   so every conditional inside another one gets explicit parentheses.
 * - ES3 reserves words that later versions allow as names (int, short, char, float...): variables,
 *   functions and parameters with those names are renamed (`int` -> `_int`), and keyword property
 *   names become string keys (`o.default` -> `o["default"]`, `{ class: 1 }` -> `{ "class": 1 }`).
 *   A reserved-word global that the code doesn't declare can't be renamed; it is reported instead.
 */
function es3Pass(code: string): { code: string; reservedGlobals: string[] } {
  const globals = new Set<string>();
  const parenthesize = ({ types: t }: any) => ({
    visitor: {
      ConditionalExpression(path: any) {
        for (const key of ["test", "consequent", "alternate"]) {
          const child = path.node[key];
          if (child && child.type === "ConditionalExpression") path.node[key] = t.parenthesizedExpression(child);
        }
      },
    },
  });
  const findReservedGlobals = ({ types: t }: any) => ({
    visitor: {
      "ReferencedIdentifier|BindingIdentifier"(path: any) {
        const name = path.node.name;
        if (!t.isValidES3Identifier(name) && !path.scope.hasBinding(name)) globals.add(name);
      },
    },
  });
  const out = Babel.transform(code, {
    plugins: [parenthesize, "transform-reserved-words", "transform-member-expression-literals", "transform-property-literals", findReservedGlobals],
    sourceType: "script",
    retainLines: true,
    comments: false,
    compact: false,
    babelrc: false,
    configFile: false,
    parserOpts: { createParenthesizedExpressions: true },
  } as any).code as string;
  return { code: out, reservedGlobals: [...globals] };
}

/** Babel's message refers to our wrapped source: hide the wrapper from the line-1 column and the code frame. */
function cleanSyntaxError(msg: string): string {
  const pre = PREFIX.length;
  let m = msg.replace(/^unknown file:\s*/, "").replace(/^\/?[^:\n]*: /, "");
  m = m.replace(/\((\d+):(\d+)\)/, (_, l, c) => `(line ${l}, column ${l === "1" ? Math.max(0, Number(c) - pre) + 1 : Number(c) + 1})`);
  const lines = m.split("\n").filter((l) => !/^\s*\d+\s*\|\s*\}\)\s*$/.test(l)); // drop the closing "})" line
  return (
    lines
      .map((l) => (/^[ >]\s*1\s*\|/.test(l) ? l.replace(PREFIX, "") : l))
      .join("\n")
      // when the error is on line 1, the caret line also has to move left by the wrapper length
      .replace(/(\n\s*\|\s)( *)\^/, (all, a, sp) => (m.includes("> 1 |") ? a + sp.slice(Math.min(sp.length, pre)) + "^" : all))
  );
}
