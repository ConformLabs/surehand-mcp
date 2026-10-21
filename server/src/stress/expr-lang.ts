// ae_stress_test: expressions that break in After Effects in another language. Display names are translated (a
// German After Effects shows "Schieberegler" for "Slider Control" and "Deckkraft" for "Opacity"), so an expression
// that reaches an effect, a parameter or a property by its English display name stops working there; match names,
// indexes, attributes (.transform.opacity) and names the user gave are the same in every language. Parsed with Babel
// (as precomp surgery does: strings, comments and scopes are real), with X-ray's lenient reader for legacy ExtendScript
// expressions Babel can't parse. The facts (expressions, effects and whether an effect still has its default name)
// come from Project X-ray's collector. Unit-tested in test/stress.test.ts.
import { Babel } from "../transpile.js";
import type { XData, XLayer } from "../tools/xray-analyze.js";
import { looksLikeMatchName, parseExpression } from "../tools/xray-expr.js";
import { applyEdits, type Edit } from "../surgery/expr.js";

export type RiskCode = "effectDefaultName" | "paramName" | "propertyName" | "layerStyleName" | "shapeDefaultName" | "maskDefaultName";

export interface LangRisk {
  comp: string;
  compId: number;
  layer: string;
  layerIndex: number;
  /** the property whose expression it is ("Transform/Opacity") */
  property: string;
  /** the reference as written */
  ref: string;
  code: RiskCode;
  severity: "fail" | "warn";
  message: string;
  /** the language-safe way, in words */
  fix: string;
  /** the reference rewritten, where it can be done without a rename ("thisLayer.transform.opacity") */
  suggestion?: string;
}

/** Display name -> expression attribute (the same in every language). */
export const ATTRIBUTES: Record<string, string> = {
  Transform: "transform", "Anchor Point": "anchorPoint", Position: "position", "X Position": "xPosition", "Y Position": "yPosition", "Z Position": "zPosition",
  Scale: "scale", Rotation: "rotation", "Z Rotation": "zRotation", "X Rotation": "xRotation", "Y Rotation": "yRotation", Orientation: "orientation", Opacity: "opacity",
  Text: "text", "Source Text": "sourceText", Effects: "effect", Masks: "mask", "Mask Path": "maskPath", "Mask Feather": "maskFeather", "Mask Opacity": "maskOpacity",
  "Mask Expansion": "maskExpansion", "Time Remap": "timeRemap", "Audio Levels": "audioLevels", Marker: "marker", Contents: "content", "Layer Styles": "layerStyle",
  "Drop Shadow": "dropShadow", "Inner Shadow": "innerShadow", "Outer Glow": "outerGlow", "Inner Glow": "innerGlow", "Bevel and Emboss": "bevelAndEmboss",
  Satin: "satin", "Color Overlay": "colorOverlay", "Gradient Overlay": "gradientOverlay", Stroke: "stroke", "Blending Options": "blendingOption",
  "Point of Interest": "pointOfInterest", Zoom: "zoom",
};
/** Expression controls: the parameter display name every one of them has as its first parameter. */
const CONTROL_PARAMS: Record<string, string> = {
  "ADBE Slider Control": "Slider", "ADBE Point Control": "Point", "ADBE Point3D Control": "3D Point", "ADBE Angle Control": "Angle", "ADBE Checkbox Control": "Checkbox",
  "ADBE Color Control": "Color", "ADBE Layer Control": "Layer", "ADBE Dropdown Control": "Menu",
};
/** Shape and mask names After Effects gives new items (in the language it runs in). */
const SHAPE_DEFAULT = /^(Rectangle|Ellipse|Polystar|Group|Shape|Path|Fill|Stroke|Gradient Fill|Gradient Stroke|Merge Paths|Offset Paths|Pucker & Bloat|Repeater|Round Corners|Trim Paths|Twist|Wiggle Paths|Wiggle Transform|Zig Zag|Rectangle Path|Ellipse Path|Polystar Path)( \d+)?$/;
const MASK_DEFAULT = /^Mask \d+$/;
/** Shape and layer-style property display names (translated); a name the user gave a group never is. */
const PROPERTY_NAMES = new Set([...Object.keys(ATTRIBUTES), "Size", "Roundness", "Color", "Stroke Width", "Path", "Fill Rule", "Line Cap", "Line Join", "Copies", "Offset", "Start", "End", "Distance", "Softness", "Angle", "Opacity", "Width", "Height"]);

const isMember = (n: any) => n && (n.type === "MemberExpression" || n.type === "OptionalMemberExpression");
const isCall = (n: any) => n && (n.type === "CallExpression" || n.type === "OptionalCallExpression");
function str(n: any): string | null {
  if (n?.type === "StringLiteral") return n.value;
  if (n?.type === "TemplateLiteral" && !n.expressions.length && n.quasis.length === 1) return n.quasis[0].value.cooked ?? null;
  return null;
}
function memberName(m: any): string | null {
  if (!m.computed) return m.property.type === "Identifier" ? m.property.name : null;
  return str(m.property);
}

type Seg = { k: "id"; name: string; node: any } | { k: "member"; name: string | null; node: any } | { k: "call"; args: any[]; node: any };

/** A member/call chain from its root identifier: thisComp.layer("X").effect("Y")("Z") */
function chainOf(node: any): Seg[] | null {
  const out: Seg[] = [];
  let n = node;
  for (;;) {
    if (isCall(n)) {
      out.push({ k: "call", args: n.arguments, node: n });
      n = n.callee;
    } else if (isMember(n)) {
      out.push({ k: "member", name: memberName(n), node: n });
      n = n.object;
    } else if (n?.type === "Identifier") {
      out.push({ k: "id", name: n.name, node: n });
      return out.reverse();
    } else return null;
  }
}

interface Found {
  code: RiskCode;
  ref: string;
  name: string;
  /** the literal's call to rewrite as an attribute, or the literal to replace */
  edit?: Edit;
  effect?: string;
  /** the whole reference rewritten with the language-safe form, when every risk in it can be rewritten */
  suggestion?: string;
}

type Ctx = { k: "layer"; layer: string | null } | { k: "effect"; fx?: { m: string; n: string; d?: 1 } } | { k: "group"; kind: "content" | "mask" | "style" | "prop" } | { k: "comp" } | null;

/** The language risks in one expression. `fxOf(layerName | null)`: the effects of a layer (null: this layer), when known. */
export function scanExpression(src: string, fxOf: (layer: string | null) => XLayer["fx"] | undefined): Found[] {
  const found: Found[] = [];
  const seen = new Set<string>();
  const add = (f: Found) => {
    const key = f.code + f.name + (f.edit?.range.join(",") ?? f.ref);
    if (!seen.has(key)) seen.add(key), found.push(f);
  };
  const visit = (top: any) => {
    const before = found.length;
    walkChain(top);
    // the reference rewritten: only when every risk found in it has a rewrite
    const mine = found.slice(before);
    if (mine.length && mine.every((f) => f.edit)) {
      try {
        const shifted = mine.map((f) => ({ range: [f.edit!.range[0] - top.start, f.edit!.range[1] - top.start] as [number, number], text: f.edit!.text }));
        const s = applyEdits(src.slice(top.start, top.end), shifted).replace(/\s+/g, " ");
        for (const f of mine) f.suggestion = s;
      } catch {}
    }
  };
  const walkChain = (top: any) => {
    const segs = chainOf(top);
    if (!segs) return;
    const root = segs[0] as Extract<Seg, { k: "id" }>;
    let ctx: Ctx = null;
    let i = 1;
    const text = src.slice(top.start, top.end).replace(/\s+/g, " ");
    // layer methods called bare (effect("x") is thisLayer.effect("x"))
    if (root.name === "thisLayer" || root.name === "this_layer") ctx = { k: "layer", layer: null };
    else if (root.name === "thisComp" || root.name === "this_comp") ctx = { k: "comp" };
    else if (root.name === "comp" && segs[1]?.k === "call") (ctx = { k: "comp" }), (i = 2);
    else if (["effect", "content", "mask"].includes(root.name) || root.name === "layer") ctx = { k: "layer", layer: null }, (i = 0);
    else return;
    for (; i < segs.length && ctx; i++) {
      const s = segs[i];
      const next = segs[i + 1];
      const nameArg = (call: Seg | undefined) => (call?.k === "call" && call.args.length === 1 ? str(call.args[0]) : null);
      if (s.k === "id") {
        // bare layer method as the root
        const arg = nameArg(next);
        if (s.name === "layer" && ctx.k === "layer") {
          ctx = { k: "layer", layer: arg };
          i++;
        } else if (s.name === "effect") {
          ctx = effectCtx(arg, null, next);
          i++;
        } else if (s.name === "content" || s.name === "mask") {
          groupName(s.name, arg, next);
          ctx = { k: "group", kind: s.name };
          i++;
        } else return;
        continue;
      }
      if (ctx.k === "comp") {
        if (s.k === "member" && s.name === "layer" && next?.k === "call") {
          ctx = { k: "layer", layer: nameArg(next) };
          i++;
        } else ctx = null;
        continue;
      }
      if (ctx.k === "layer") {
        if (s.k === "member") {
          const m = s.name;
          if ((m === "effect" || m === "content" || m === "mask") && next?.k === "call") {
            const arg = nameArg(next);
            if (m === "effect") ctx = effectCtx(arg, ctx.layer, next);
            else groupName(m, arg, next), (ctx = { k: "group", kind: m });
            i++;
          } else if (m === "layerStyle") ctx = { k: "group", kind: "style" };
          else if (m && m in invertAttr) ctx = { k: "group", kind: "prop" };
          else if (m === "parent") ctx = { k: "layer", layer: "\u0000" };
          else ctx = null;
        } else if (s.k === "call") {
          // thisLayer("Transform"): a property group by display name
          propName(s, "prop");
          ctx = { k: "group", kind: "prop" };
        }
        continue;
      }
      if (ctx.k === "effect") {
        const fx = ctx.fx;
        if (s.k === "call" || (s.k === "member" && s.name === "param" && next?.k === "call")) {
          const call = (s.k === "call" ? s : next) as Extract<Seg, { k: "call" }>;
          const p = call.args.length === 1 ? str(call.args[0]) : null;
          if (p !== null && !looksLikeMatchName(p) && !(fx && /^Pseudo\//.test(fx.m))) {
            const lit = call.args[0];
            // an expression control's only parameter is its first: index 1 in every language
            const first = fx ? CONTROL_PARAMS[fx.m] : Object.values(CONTROL_PARAMS).includes(p) ? p : undefined;
            add({ code: "paramName", ref: text, name: p, effect: fx?.n, edit: first === p ? { range: [lit.start, lit.end], text: "1" } : undefined });
          }
        }
        ctx = null;
        continue;
      }
      if (ctx.k === "group") {
        const kind = ctx.kind;
        if (s.k === "call") {
          const arg = s.args.length === 1 ? str(s.args[0]) : null;
          if (arg !== null) {
            if (kind === "content" && SHAPE_DEFAULT.test(arg)) groupName("content", arg, s);
            else if (!looksLikeMatchName(arg) && (kind === "prop" || kind === "style" || PROPERTY_NAMES.has(arg))) propName(s, kind);
          }
        } else if (s.k === "member" && s.name === "content" && next?.k === "call") {
          groupName("content", nameArg(next), next);
          i++;
        } else if (s.k === "member" && s.name && kind === "prop" && !(s.name in invertAttr)) ctx = null;
        continue;
      }
    }

    function effectCtx(arg: string | null, layer: string | null, call: Seg | undefined): Ctx {
      const list = fxOf(layer);
      const fx = arg === null ? undefined : list?.find((f) => f.n === arg || f.m === arg);
      if (arg !== null && fx && fx.d && fx.m !== arg) add({ code: "effectDefaultName", ref: text, name: arg, effect: fx.m });
      // not known (another layer, a comp's layer by index): an effect's English default name is still a risk
      else if (arg !== null && !fx && !looksLikeMatchName(arg) && Object.values(CONTROL_PARAMS).some((p) => `${p} Control` === arg || arg === "3D Point Control"))
        add({ code: "effectDefaultName", ref: text, name: arg });
      void call;
      return { k: "effect", fx };
    }
    function groupName(kind: "content" | "mask", arg: string | null, call: Seg | undefined) {
      if (arg === null) return;
      if (kind === "content" && SHAPE_DEFAULT.test(arg)) add({ code: "shapeDefaultName", ref: text, name: arg });
      if (kind === "mask" && MASK_DEFAULT.test(arg)) add({ code: "maskDefaultName", ref: text, name: arg });
      void call;
    }
    function propName(call: Extract<Seg, { k: "call" }>, kind: string) {
      const arg = call.args.length === 1 ? str(call.args[0]) : null;
      if (arg === null || looksLikeMatchName(arg)) return;
      // a group the user named (not a display name After Effects translates) is fine
      if (!PROPERTY_NAMES.has(arg) && kind !== "style") return;
      const attr = ATTRIBUTES[arg];
      // obj("Opacity") -> obj.opacity: the call's callee end to the call end
      const callee = call.node.callee;
      add({ code: kind === "style" ? "layerStyleName" : "propertyName", ref: text, name: arg, edit: attr ? { range: [callee.end, call.node.end], text: `.${attr}` } : undefined });
    }
  };

  const visitor = {
    "CallExpression|OptionalCallExpression|MemberExpression|OptionalMemberExpression"(path: any) {
      // only the outermost node of a chain
      const p = path.parent;
      if ((isMember(p) && p.object === path.node) || (isCall(p) && p.callee === path.node)) return;
      visit(path.node);
    },
    // a bare effect("x") / content("x") root inside a longer chain is reached through its outermost node
  };
  try {
    Babel().transform(src, { ast: false, code: false, sourceType: "script", babelrc: false, configFile: false, parserOpts: { allowReturnOutsideFunction: true }, plugins: [() => ({ visitor })] } as any);
    // a rewrite per reference: the edits inside that reference's text
    return found;
  } catch {
    // legacy ExtendScript Babel can't read: X-ray's lenient reader (no rewrites)
    try {
      for (const r of parseExpression(src).refs) {
        if (r.kind === "param" && r.param.by === "name" && !looksLikeMatchName(r.param.v)) add({ code: "paramName", ref: r.text, name: r.param.v });
        else if (r.kind === "property" && r.path.some((p) => p.by === "name" && PROPERTY_NAMES.has(p.v))) add({ code: "propertyName", ref: r.text, name: (r.path.find((p) => p.by === "name") as { v: string }).v });
        else if (r.kind === "content" && r.path.some((p) => p.by === "name" && SHAPE_DEFAULT.test(p.v))) add({ code: "shapeDefaultName", ref: r.text, name: (r.path.find((p) => p.by === "name") as { v: string }).v });
        else if (r.kind === "mask" && r.path.some((p) => p.by === "name" && MASK_DEFAULT.test(p.v))) add({ code: "maskDefaultName", ref: r.text, name: (r.path.find((p) => p.by === "name") as { v: string }).v });
        else if (r.kind === "effect" && r.effect.by === "name") {
          const name = r.effect.v, fx = fxOf(null)?.find((f) => f.n === name && f.d);
          if (fx) add({ code: "effectDefaultName", ref: r.text, name: fx.n, effect: fx.m });
        }
      }
    } catch {}
    return found;
  }
}
const invertAttr: Record<string, string> = Object.fromEntries(Object.entries(ATTRIBUTES).map(([k, v]) => [v, k]));

const MESSAGE: Record<RiskCode, (f: Found) => { message: string; fix: string; severity: "fail" | "warn" }> = {
  effectDefaultName: (f) => ({
    severity: "fail",
    message: `effect "${f.name}" by its default name: After Effects in another language names it differently, so the expression can't find it`,
    fix: `rename the effect (a name you give it is the same in every language) and use that name${f.effect ? `, or its match name "${f.effect}"` : ""}`,
  }),
  paramName: (f) => ({
    severity: "fail",
    message: `parameter "${f.name}"${f.effect ? ` of "${f.effect}"` : ""} by its display name, which is translated in other After Effects languages`,
    fix: "use the parameter's index (expression controls: 1) or its match name",
  }),
  propertyName: (f) => ({
    severity: "fail",
    message: `property "${f.name}" by its display name, which is translated in other After Effects languages`,
    fix: ATTRIBUTES[f.name] ? `use the attribute .${ATTRIBUTES[f.name]} (or the match name)` : "use the property's match name or index",
  }),
  layerStyleName: (f) => ({
    severity: "fail",
    message: `layer style "${f.name}" by its display name, which is translated in other After Effects languages`,
    fix: ATTRIBUTES[f.name] ? `use layerStyle.${ATTRIBUTES[f.name]}` : "use the layerStyle attributes (layerStyle.dropShadow...) or match names",
  }),
  shapeDefaultName: (f) => ({
    severity: "warn",
    message: `shape item "${f.name}" by the default name After Effects gave it: a template made or edited in another language names it differently`,
    fix: "rename the shape group (your own name is the same in every language) or use its index, content(1)",
  }),
  maskDefaultName: (f) => ({
    severity: "warn",
    message: `mask "${f.name}" by its default name: After Effects in another language names masks differently`,
    fix: "rename the mask, or use its index, mask(1)",
  }),
};

/** Every language risk in the expressions X-ray collected (the comp and its precomps). */
export function languageRisks(x: XData): LangRisk[] {
  const out: LangRisk[] = [];
  for (const c of x.comps) {
    const layers = c.layers ?? [];
    for (const l of layers) {
      const fxOf = (name: string | null) => (name === null ? l.fx : name === "\u0000" ? undefined : layers.find((o) => o.n === name)?.fx);
      for (const [prop, src, , enabled] of l.ex ?? []) {
        if (!enabled) continue;
        for (const f of scanExpression(src, fxOf)) {
          const m = MESSAGE[f.code](f);
          const suggestion = f.suggestion;
          out.push({ comp: c.name, compId: c.id, layer: l.n, layerIndex: l.i, property: prop, ref: f.ref, code: f.code, severity: m.severity, message: m.message, fix: m.fix, ...(suggestion ? { suggestion } : {}) });
        }
      }
    }
  }
  return out;
}
