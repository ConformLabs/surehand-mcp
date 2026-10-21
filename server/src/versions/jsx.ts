// Versions from data: the ExtendScript side. VALIDATE_JSX only reads (the dry run, and the check before building);
// BUILD_JSX makes every version in one undo group and reads each value back where it renders (valueAtTime with
// expressions, so an expression that overrides the value shows up as a mismatch). The values were already worked out
// in TypeScript (src/versions/data.ts); the measuring is Preflight's (src/preflight/project.ts).
//
// Two modes:
// - "duplicate": the template comp is duplicated per row (CompItem.duplicate) and the mapped layers of the copy are
//   set. Duplicating a comp does not duplicate the precomps inside it: they are shared by every version, so targets
//   must be layers of the template comp itself (a layer inside a precomp would change in every version at once).
// - "essentialGraphics": per row a new comp holds the template as one precomp layer, and the row's values are set on
//   that layer's Essential Properties (its Essential Graphics controllers), the way After Effects keeps per-instance
//   values. The template's own layers stay as they are, so scripts can't measure a row's layout there.

/** One mapping as the JSX sees it (index into args.map). */
export interface JsxMap {
  layer?: string | number;
  egp?: string;
  kind: "text" | "number" | "color" | "footage" | "value" | "size";
  property?: string | (string | number)[];
  /** size: 0 = width, 1 = height */
  axis?: number;
}

/** What VALIDATE_JSX returns. */
export interface VTemplate {
  comp: { id: number; name: string; w: number; h: number; fps: number; dur: number; fd: number; dst?: number; df?: boolean };
  /** per mapping: the resolved target, or the problem */
  t: { err?: string; li?: number; ln?: string; pt?: string; ex?: 1; td?: 1; rect?: number[] }[];
  /** Essential Graphics controller names of the template */
  egp?: string[];
  /** version names that are already project items */
  clash: string[];
  ae?: string;
}

/** What BUILD_JSX returns. */
export interface VBuilt {
  folder: string;
  rows: {
    /** row number in the data */
    n: number;
    id: number;
    name: string;
    /** [mapping index, error] for values that could not be set */
    err: [number, string][];
    /** mapping index -> value read back at checkAt */
    rb: Record<string, unknown>;
    /** size: mapping index -> the value written to the driving property */
    drv?: Record<string, unknown>;
    rq?: { file: string | null; i?: number; exists?: 1; error?: string };
  }[];
  fatal?: string;
  rollback?: boolean;
}

const COMMON = `
function vfLayer(c, ref) {
  if (typeof ref === "string") {
    var n = 0;
    for (var j = 1; j <= c.numLayers; j++) if (c.layer(j).name === ref) n++;
    if (n > 1) aemcp.fail(n + " layers are named '" + ref + "' in '" + c.name + "': rename one, or give the layer's index");
  }
  return aemcp.findLayer(c, ref);
}
function vfType(p) { return String(aemcp.enumName(PropertyValueType, p.propertyValueType)); }
function vfKeyed(p) { try { return p.numKeys > 0; } catch (e) { return false; } }
function vfExpr(p) { try { return p.expressionEnabled && p.expression !== ""; } catch (e) { return false; } }
function vfIsText(L) { return L instanceof TextLayer; }
function vfSourceText(L) { return L.property("ADBE Text Properties").property("ADBE Text Document"); }
// a mapping's target in a comp (duplicate mode): { L, p, sub } (sub "fill": the text's fill colour)
function vfTarget(c, m) {
  var L = vfLayer(c, m.layer), p = null, sub = null;
  if (m.property !== undefined && m.property !== null) {
    p = aemcp.resolveProp(L, m.property);
    if (p.propertyType !== PropertyType.PROPERTY) aemcp.fail("'" + p.name + "' on layer '" + L.name + "' is a group, not a property");
  }
  if (m.kind === "text" || m.kind === "number") {
    if (!p) { if (!vfIsText(L)) aemcp.fail("layer '" + L.name + "' is not a text layer (give property: the property to set)"); p = vfSourceText(L); }
    var ty = vfType(p);
    if (m.kind === "text" && ty !== "TEXT_DOCUMENT") aemcp.fail("'" + p.name + "' on layer '" + L.name + "' holds " + ty + ", not text");
    if (m.kind === "number" && ty !== "TEXT_DOCUMENT" && ty !== "OneD") aemcp.fail("'" + p.name + "' on layer '" + L.name + "' holds " + ty + "; a number goes into text or a one-value property");
  } else if (m.kind === "color") {
    if (!p) { if (!vfIsText(L)) aemcp.fail("layer '" + L.name + "' is not a text layer: give property, the colour property to set (e.g. Contents/Rectangle 1/Fill 1/Color, or an effect's colour)"); p = vfSourceText(L); sub = "fill"; }
    else if (vfType(p) !== "COLOR") aemcp.fail("'" + p.name + "' on layer '" + L.name + "' is not a colour property (" + vfType(p) + ")");
  } else if (m.kind === "footage") {
    var src = null;
    try { src = L.source; } catch (e) {}
    if (!(L instanceof AVLayer) || !src || L.nullLayer || L.adjustmentLayer) aemcp.fail("layer '" + L.name + "' has no footage source to replace");
  } else if (m.kind === "value") {
    if (!p) aemcp.fail("kind \\"value\\" needs property: the property to set on layer '" + L.name + "'");
    var t2 = vfType(p);
    if (t2 === "NO_VALUE" || t2 === "CUSTOM_VALUE" || t2 === "SHAPE" || t2 === "MARKER") aemcp.fail("'" + p.name + "' on layer '" + L.name + "' holds " + t2 + ", which can't be set from a data cell");
  } else if (m.kind === "size") {
    if (!p) p = L.property("ADBE Transform Group").property("ADBE Scale");
    else { var t3 = vfType(p); if (t3 !== "OneD" && t3 !== "TwoD" && t3 !== "ThreeD" && t3 !== "TwoD_SPATIAL" && t3 !== "ThreeD_SPATIAL") aemcp.fail("'" + p.name + "' on layer '" + L.name + "' holds " + t3 + "; a size goes into a number or a [w, h] property"); }
  }
  if (p && vfKeyed(p)) aemcp.fail("'" + p.name + "' on layer '" + L.name + "' has keyframes: a version's value can't replace an animation (map a property without keyframes, e.g. a Slider the animation reads)");
  return { L: L, p: p, sub: sub };
}
function vfEgpNames(c) {
  var o = [];
  try { for (var k = 1; k <= c.motionGraphicsTemplateControllerCount; k++) o.push(c.getMotionGraphicsTemplateControllerName(k)); } catch (e) {}
  return o;
}
`;

export const VALIDATE_JSX =
  COMMON +
  `
var c = aemcp.findComp(args.template), P = app.project;
var D = { comp: { id: c.id, name: c.name, w: c.width, h: c.height, fps: c.frameRate, dur: c.duration, fd: c.frameDuration }, t: [], clash: [] };
try { D.ae = app.version; } catch (e) {}
try { D.comp.dst = c.displayStartTime; } catch (e) {}
try { D.comp.df = c.dropFrame; } catch (e) {}
var t = args.checkAt === undefined ? c.duration - c.frameDuration : args.checkAt;
if (args.mode === "essentialGraphics") D.egp = vfEgpNames(c);
for (var i = 0; i < args.map.length; i++) {
  var m = args.map[i], o = {};
  D.t.push(o);
  if (args.mode === "essentialGraphics") {
    var hit = false;
    for (var e1 = 0; e1 < D.egp.length; e1++) if (D.egp[e1] === m.egp) hit = true;
    if (!hit) o.err = "no Essential Graphics controller named '" + m.egp + "' in '" + c.name + "'" + (D.egp.length ? " (it has: " + D.egp.join(", ") + ")" : " (it has none)");
    continue;
  }
  try {
    var g = vfTarget(c, m);
    o.li = g.L.index; o.ln = g.L.name;
    if (g.p) { o.pt = vfType(g.p); if (vfExpr(g.p)) o.ex = 1; }
    if (vfIsText(g.L)) { try { if (vfSourceText(g.L).value.boxText) o.td = 1; } catch (e) {} }
    if (m.kind === "size") {
      var r = g.L.sourceRectAtTime(t, false);
      o.rect = [aemcp.round(r.left), aemcp.round(r.top), aemcp.round(r.width), aemcp.round(r.height)];
    }
  } catch (e) { o.err = e.message || String(e); }
}
var names = {};
for (var n = 0; n < (args.names || []).length; n++) names["n:" + args.names[n]] = true;
for (var k = 1; k <= P.numItems; k++) { var it = P.item(k); if (names["n:" + it.name] && !(it instanceof FolderItem)) D.clash.push(it.name); }
return D;`;

export const BUILD_JSX =
  COMMON +
  `
var c = aemcp.findComp(args.template), P = app.project, t = args.checkAt, EG = args.mode === "essentialGraphics";
var out = { folder: "", rows: [] }, imported = {};
function folderNamed(name) {
  for (var k = 1; k <= P.numItems; k++) { var it = P.item(k); if (it instanceof FolderItem && it.name === name) return it; }
  return P.items.addFolder(name);
}
function at(p) { try { return p.valueAtTime(t, false); } catch (e) { return p.value; } }
function footageItem(path) {
  if (imported["f:" + path]) return imported["f:" + path];
  var f = new File(path), hit = null;
  for (var k = 1; k <= P.numItems && !hit; k++) {
    var it = P.item(k);
    try { if (it instanceof FootageItem && it.file && it.file.fsName === f.fsName) hit = it; } catch (e) {}
  }
  if (!hit) { hit = P.importFile(new ImportOptions(f)); try { hit.parentFolder = fold; } catch (e) {} }
  imported["f:" + path] = hit;
  return hit;
}
function nums(v, n) {
  if (typeof v === "number") return [v];
  var s = String(v).replace(/^\\s*\\[|\\]\\s*$/g, ""), parts = s.split(/[\\s,;]+/), o = [];
  for (var k = 0; k < parts.length; k++) if (parts[k] !== "") { var x = Number(parts[k]); if (isNaN(x)) aemcp.fail("'" + v + "' is not a list of numbers"); o.push(x); }
  if (n && o.length !== n) aemcp.fail("'" + v + "' has " + o.length + " numbers; this property takes " + n);
  return o;
}
// a cell (kind "value") as this property's value
function asValue(p, v) {
  var ty = vfType(p);
  if (ty === "TEXT_DOCUMENT") { var td = p.value; td.text = String(v); return aemcp.textDirection(td, td.text); }
  if (ty === "COLOR") return aemcp.color(typeof v === "string" && v.charAt(0) !== "#" && /,/.test(v) ? nums(v, 0) : v);
  if (ty === "OneD" || ty === "LAYER_INDEX" || ty === "MASK_INDEX") { var x = typeof v === "number" ? v : Number(String(v).replace(/^\\s+|\\s+$/g, "")); if (String(v).replace(/\\s/g, "") === "" || isNaN(x)) aemcp.fail("'" + v + "' is not a number"); return x; }
  if (ty === "TwoD" || ty === "TwoD_SPATIAL") return nums(v, 2);
  if (ty === "ThreeD" || ty === "ThreeD_SPATIAL") { var a = nums(v, 0); if (a.length === 2) a.push(p.value[2]); if (a.length !== 3) aemcp.fail("'" + v + "' needs 2 or 3 numbers"); return a; }
  aemcp.fail("'" + p.name + "' holds " + ty + ", which can't be set from a data cell");
}
function setText(p, s) { var td = p.value; td.text = s; aemcp.textDirection(td, s); p.setValue(td); }
// writes one value; returns what the size driver got (size only)
function apply(g, m, s) {
  var p = g.p, ty = p ? vfType(p) : "";
  if (m.kind === "text") setText(p, s.v);
  else if (m.kind === "number") { if (ty === "TEXT_DOCUMENT") setText(p, s.v); else p.setValue(s.n); }
  else if (m.kind === "color") {
    if (g.sub === "fill") { var td = p.value; td.applyFill = true; td.fillColor = s.v; p.setValue(td); }
    else p.setValue([s.v[0], s.v[1], s.v[2], 1]);
  } else if (m.kind === "footage") g.L.replaceSource(footageItem(s.v), false);
  else if (m.kind === "value") p.setValue(asValue(p, s.v));
  else if (m.kind === "size") {
    var ax = m.axis || 0, L = g.L;
    if (p.matchName === "ADBE Scale") {
      // the scale that makes the layer's box s.v px wide (or high) in the comp, through its parents' scale
      var r = L.sourceRectAtTime(t, false), w = ax === 0 ? r.width : r.height, f = 1;
      for (var A = L.parent; A; A = A.parent) f *= Math.abs(at(A.property("ADBE Transform Group").property("ADBE Scale"))[ax]) / 100;
      if (!(w > 0) || !(f > 0)) aemcp.fail("layer '" + L.name + "' has no " + (ax === 0 ? "width" : "height") + " at " + t + " s to scale (its content or a parent's scale is 0)");
      var sc = p.value, sign = sc[ax] < 0 ? -1 : 1;
      sc[ax] = sign * (s.v / (w * f)) * 100;
      p.setValue(sc);
      return aemcp.round(sc[ax]);
    }
    if (ty === "OneD") { p.setValue(s.v); return s.v; }
    var arr = p.value; arr[ax] = s.v; p.setValue(arr); return s.v;
  }
}
function readBack(g, m) {
  var p = g.p;
  if (m.kind === "footage") {
    var src = g.L.source, o = { name: src.name, file: null };
    try { if (src.file) { o.file = src.file.fsName; o.exists = src.file.exists; } } catch (e) {}
    try { o.missing = !!src.footageMissing; } catch (e) {}
    return o;
  }
  if (m.kind === "size") return null;
  var v = at(p);
  if (g.sub === "fill") { try { return v.applyFill === false ? null : aemcp.valueOf(v.fillColor); } catch (e) { return null; } }
  if (vfType(p) === "TEXT_DOCUMENT") return String(v.text);
  return aemcp.valueOf(v);
}
var fold = folderNamed(args.folder);
out.folder = fold.name;
try {
  for (var r = 0; r < args.rows.length; r++) {
    var row = args.rows[r], v, L0 = null;
    if (EG) {
      v = P.items.addComp(row.name, c.width, c.height, c.pixelAspect, c.duration, c.frameRate);
      try { v.bgColor = c.bgColor; } catch (e) {}
      try { v.displayStartTime = c.displayStartTime; } catch (e) {}
      try { v.workAreaStart = c.workAreaStart; v.workAreaDuration = c.workAreaDuration; } catch (e) {}
      L0 = v.layers.add(c);
    } else {
      v = c.duplicate();
      v.name = row.name;
    }
    v.parentFolder = fold;
    var rec = { n: row.n, id: v.id, name: v.name, err: [], rb: {}, drv: {} };
    out.rows.push(rec);
    // text before colour: a text's fill is set on the text it will show
    for (var pass = 0; pass < 2; pass++) {
      for (var s = 0; s < row.sets.length; s++) {
        var st = row.sets[s], m = args.map[st.i];
        if ((m.kind === "color") !== (pass === 1)) continue;
        try {
          var g;
          if (EG) {
            var ep = L0.essentialProperty.property(m.egp);
            if (!ep) aemcp.fail("no Essential Property '" + m.egp + "'");
            g = { L: L0, p: ep, sub: null };
            var ety = vfType(ep);
            if (m.kind === "color" && ety === "TEXT_DOCUMENT") g.sub = "fill";
            if ((m.kind === "text" && ety !== "TEXT_DOCUMENT") || (m.kind === "color" && ety !== "COLOR" && ety !== "TEXT_DOCUMENT")) aemcp.fail("Essential Property '" + m.egp + "' holds " + ety);
          } else g = vfTarget(v, m);
          var d = apply(g, m, st);
          if (d !== undefined) rec.drv[String(st.i)] = d;
          rec.rb[String(st.i)] = readBack(g, m);
        } catch (e) { rec.err.push([st.i, e.message || String(e)]); }
      }
    }
    if (row.out !== undefined) {
      var q = aemcp.addToRenderQueue(v, { renderSettingsTemplate: args.queue.renderSettingsTemplate, outputModuleTemplate: args.queue.outputModuleTemplate, outputPath: row.out });
      var f = q.om.file ? q.om.file.fsName : null;
      // never replaces a file: an output that exists (after the template set its extension) is not queued
      if (f && !args.overwrite && new File(f).exists) { q.item.remove(); rec.rq = { file: f, exists: 1 }; }
      else rec.rq = { file: f, i: P.renderQueue.numItems };
    }
  }
} catch (e) {
  // not a value of one row (those are caught above): e.g. an output module template that doesn't exist
  return { folder: out.folder, rows: out.rows, fatal: e.message || String(e), rollback: true };
}
return out;`;
