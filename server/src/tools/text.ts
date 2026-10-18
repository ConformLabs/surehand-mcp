import { z } from "zod";
import { colorSchema, compRef, layerRef, type JsxTool } from "./registry.js";

const charStyle = z
  .object({
    font: z.string().optional().describe("PostScript name (see ae_get_fonts)."),
    fontSize: z.number().optional(),
    fillColor: colorSchema.optional(),
    strokeColor: colorSchema.optional(),
    strokeWidth: z.number().optional(),
    applyFill: z.boolean().optional(),
    applyStroke: z.boolean().optional(),
    tracking: z.number().optional(),
    leading: z.number().optional(),
    baselineShift: z.number().optional(),
    horizontalScale: z.number().optional().describe("Percent."),
    verticalScale: z.number().optional().describe("Percent."),
    fauxBold: z.boolean().optional(),
    fauxItalic: z.boolean().optional(),
    allCaps: z.boolean().optional(),
    smallCaps: z.boolean().optional(),
    superscript: z.boolean().optional(),
    subscript: z.boolean().optional(),
  })
  .describe("Character style to apply.");

export const textTools: JsxTool[] = [
  {
    name: "ae_style_text_range",
    title: "Style part of a text",
    description:
      "Apply character styling to part of a text layer: by character range (start/end) or every occurrence of a word or phrase (match). " +
      "Font, size, fill/stroke color, tracking, leading, baseline shift, scale, faux bold/italic, caps, super/subscript. Needs After Effects 24.0+.",
    input: {
      comp: compRef,
      layer: layerRef,
      start: z.number().int().min(0).optional().describe("First character (0-based)."),
      end: z.number().int().optional().describe("End character, exclusive (default: end of text)."),
      match: z.string().optional().describe("Style every occurrence of this text instead of a range."),
      caseSensitive: z.boolean().optional(),
      style: charStyle,
      time: z.number().optional().describe("Apply at this time (Source Text keyframe) when the text is animated."),
    },
    idempotent: true,
    jsx: `
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer);
var tp = l.property("ADBE Text Properties"); if (!tp) aemcp.fail("'" + l.name + "' is not a text layer");
var src = tp.property("ADBE Text Document");
var td = args.time !== undefined ? src.valueAtTime(args.time, false) : src.value;
if (typeof td.characterRange !== "function") aemcp.fail("Per-character styling needs After Effects 24.0 or newer");
var text = td.text, ranges = [];
if (args.match) {
  var hay = args.caseSensitive ? text : text.toLowerCase(), needle = args.caseSensitive ? args.match : args.match.toLowerCase();
  var at = hay.indexOf(needle);
  while (at >= 0 && needle.length) { ranges.push([at, at + needle.length]); at = hay.indexOf(needle, at + needle.length); }
  if (!ranges.length) aemcp.fail("'" + args.match + "' not found in the text");
} else ranges.push([args.start || 0, args.end === undefined ? text.length : args.end]);
var st = args.style, keys = ["font", "fontSize", "strokeWidth", "applyFill", "applyStroke", "tracking", "leading", "baselineShift", "horizontalScale", "verticalScale", "fauxBold", "fauxItalic", "allCaps", "smallCaps", "superscript", "subscript"];
for (var r = 0; r < ranges.length; r++) {
  var cr = td.characterRange(ranges[r][0], ranges[r][1]);
  for (var k = 0; k < keys.length; k++) if (st[keys[k]] !== undefined) {
    if (keys[k] === "leading") { try { cr.autoLeading = false; } catch (e) {} }
    cr[keys[k]] = st[keys[k]];
  }
  if (st.fillColor !== undefined) { cr.applyFill = true; cr.fillColor = aemcp.color3(st.fillColor); }
  if (st.strokeColor !== undefined) { cr.applyStroke = true; cr.strokeColor = aemcp.color3(st.strokeColor); }
}
if (args.time !== undefined || src.numKeys) src.setValueAtTime(args.time !== undefined ? args.time : c.time, td); else src.setValue(td);
return { layer: l.name, text: text, styled: ranges };`,
  },
  {
    name: "ae_set_paragraph",
    title: "Paragraph settings",
    description:
      "Paragraph formatting of a text layer (all paragraphs or one): justification, indents, space before/after, plus paragraph text box size. " +
      "Needs After Effects 24.0+ for per-paragraph settings.",
    input: {
      comp: compRef,
      layer: layerRef,
      paragraph: z.number().int().min(0).optional().describe("0-based paragraph index (default: all)."),
      justification: z.enum(["LEFT_JUSTIFY", "CENTER_JUSTIFY", "RIGHT_JUSTIFY", "FULL_JUSTIFY_LASTLINE_LEFT", "FULL_JUSTIFY_LASTLINE_CENTER", "FULL_JUSTIFY_LASTLINE_RIGHT", "FULL_JUSTIFY_LASTLINE_FULL"]).optional(),
      firstLineIndent: z.number().optional(),
      startIndent: z.number().optional(),
      endIndent: z.number().optional(),
      spaceBefore: z.number().optional(),
      spaceAfter: z.number().optional(),
      boxSize: z.array(z.number()).length(2).optional().describe("Paragraph (box) text only: [width, height]."),
    },
    idempotent: true,
    jsx: `
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer);
var tp = l.property("ADBE Text Properties"); if (!tp) aemcp.fail("'" + l.name + "' is not a text layer");
var src = tp.property("ADBE Text Document"), td = src.value;
var target = td;
if (typeof td.paragraphRange === "function") {
  var count = td.paragraphCount || 1;
  target = args.paragraph === undefined ? td.paragraphRange(0, count) : td.paragraphRange(args.paragraph, args.paragraph + 1);
} else if (args.paragraph !== undefined) aemcp.fail("Per-paragraph settings need After Effects 24.0 or newer");
if (args.justification) target.justification = ParagraphJustification[args.justification];
var keys = ["firstLineIndent", "startIndent", "endIndent", "spaceBefore", "spaceAfter"];
for (var i = 0; i < keys.length; i++) if (args[keys[i]] !== undefined) target[keys[i]] = args[keys[i]];
if (args.boxSize) { if (!td.boxText) aemcp.fail("boxSize only applies to paragraph (box) text"); td.boxTextSize = args.boxSize; }
if (src.numKeys) src.setValueAtTime(c.time, td); else src.setValue(td);
return { layer: l.name, text: aemcp.textInfo(src.value) };`,
  },
  {
    name: "ae_add_text_animator",
    title: "Add text animator",
    description:
      "Add a text animator to a text layer: the properties it changes (position, scale, rotation, opacity, fill/stroke color, tracking, blur, skew, " +
      "anchor point, character offset...) and a selector (range, wiggly or expression) with its settings. Animate the selector afterwards with " +
      'ae_set_keyframes on paths like "Text/Animators/Animator 1/Selectors/Range Selector 1/Offset" (use ae_get_properties to see the exact names).',
    input: {
      comp: compRef,
      layer: layerRef,
      name: z.string().optional(),
      properties: z
        .object({
          position: z.array(z.number()).min(2).max(3).optional(),
          anchorPoint: z.array(z.number()).min(2).max(3).optional(),
          scale: z.array(z.number()).min(2).max(3).optional(),
          rotation: z.number().optional(),
          opacity: z.number().optional(),
          skew: z.number().optional(),
          tracking: z.number().optional(),
          lineSpacing: z.array(z.number()).length(2).optional(),
          blur: z.array(z.number()).length(2).optional(),
          fillColor: colorSchema.optional(),
          fillOpacity: z.number().optional(),
          strokeColor: colorSchema.optional(),
          strokeWidth: z.number().optional(),
          characterOffset: z.number().optional(),
        })
        .describe("Animator properties and their values (at full selection)."),
      selector: z
        .object({
          type: z.enum(["range", "wiggly", "expression"]).optional().describe("Default range."),
          start: z.number().optional().describe("Percent (or index with units: index)."),
          end: z.number().optional(),
          offset: z.number().optional(),
          units: z.enum(["percentage", "index"]).optional(),
          basedOn: z.enum(["characters", "charactersExcludingSpaces", "words", "lines"]).optional(),
          mode: z.enum(["add", "subtract", "intersect", "min", "max", "difference"]).optional(),
          shape: z.enum(["square", "rampUp", "rampDown", "triangle", "round", "smooth"]).optional(),
          smoothness: z.number().optional(),
          easeHigh: z.number().optional(),
          easeLow: z.number().optional(),
          randomizeOrder: z.boolean().optional(),
          amountExpression: z.string().optional().describe('For type "expression": the Amount expression, e.g. "textIndex * 10".'),
          maxAmount: z.number().optional().describe("Wiggly: max amount %."),
          minAmount: z.number().optional(),
          wigglesPerSecond: z.number().optional(),
        })
        .optional(),
    },
    jsx: `
var c = aemcp.findComp(args.comp), l = aemcp.findLayer(c, args.layer);
var tp = l.property("ADBE Text Properties"); if (!tp) aemcp.fail("'" + l.name + "' is not a text layer");
var an = tp.property("ADBE Text Animators").addProperty("ADBE Text Animator");
if (args.name) an.name = args.name;
var props = an.property("ADBE Text Animator Properties"), P = args.properties || {};
var map = { position: "ADBE Text Position 3D", anchorPoint: "ADBE Text Anchor Point 3D", scale: "ADBE Text Scale 3D", rotation: "ADBE Text Rotation",
  opacity: "ADBE Text Opacity", skew: "ADBE Text Skew", tracking: "ADBE Text Tracking Amount", lineSpacing: "ADBE Text Line Spacing", blur: "ADBE Text Blur",
  fillColor: "ADBE Text Fill Color", fillOpacity: "ADBE Text Fill Opacity", strokeColor: "ADBE Text Stroke Color", strokeWidth: "ADBE Text Stroke Width",
  characterOffset: "ADBE Text Character Offset" };
var added = [];
for (var k in P) {
  if (!P.hasOwnProperty(k) || P[k] === undefined) continue;
  if (!map[k]) aemcp.fail("Unknown animator property " + k);
  var ap = props.addProperty(map[k]);
  var v = P[k];
  if (k === "fillColor" || k === "strokeColor") v = aemcp.color3(v);
  if ((k === "position" || k === "anchorPoint") && v.length === 2) v = [v[0], v[1], 0];
  if (k === "scale" && v.length === 2) v = [v[0], v[1], 100];
  ap.setValue(v);
  if (k === "tracking") { try { props.property("ADBE Text Track Type").setValue(1); } catch (e) {} }
  added.push(ap.name);
}
var S = args.selector || {}, type = S.type || "range";
var sel = an.property("ADBE Text Selectors").addProperty(type === "wiggly" ? "ADBE Text Wiggly Selector" : (type === "expression" ? "ADBE Text Expressible Selector" : "ADBE Text Selector"));
var adv = sel.property("ADBE Text Range Advanced");
function setIf(group, mn, val) { if (val === undefined) return; var q = group ? group.property(mn) : null; if (!q) { log("selector property " + mn + " not available"); return; } q.setValue(val); }
var units = { percentage: 1, index: 2 }, based = { characters: 1, charactersExcludingSpaces: 2, words: 3, lines: 4 };
var modes = { add: 1, subtract: 2, intersect: 3, min: 4, max: 5, difference: 6 }, shapes = { square: 1, rampUp: 2, rampDown: 3, triangle: 4, round: 5, smooth: 6 };
if (type === "range") {
  if (S.units) setIf(adv, "ADBE Text Range Units", units[S.units]);
  setIf(sel, "ADBE Text Percent Start", S.start);
  setIf(sel, "ADBE Text Percent End", S.end);
  setIf(sel, "ADBE Text Percent Offset", S.offset);
  if (S.units === "index") { setIf(sel, "ADBE Text Index Start", S.start); setIf(sel, "ADBE Text Index End", S.end); setIf(sel, "ADBE Text Index Offset", S.offset); }
  if (S.shape) setIf(adv, "ADBE Text Range Shape", shapes[S.shape]);
  setIf(adv, "ADBE Text Selector Smoothness", S.smoothness);
  setIf(adv, "ADBE Text Levels Max Ease", S.easeHigh);
  setIf(adv, "ADBE Text Levels Min Ease", S.easeLow);
  if (S.randomizeOrder !== undefined) setIf(adv, "ADBE Text Randomize Order", S.randomizeOrder ? 1 : 0);
} else if (type === "wiggly") {
  setIf(sel, "ADBE Text Wiggly Max Amount", S.maxAmount);
  setIf(sel, "ADBE Text Wiggly Min Amount", S.minAmount);
  setIf(sel, "ADBE Text Temporal Freq", S.wigglesPerSecond);
} else if (S.amountExpression) {
  sel.property("ADBE Text Expressible Amount").expression = S.amountExpression;
}
if (S.basedOn) setIf(adv || sel, "ADBE Text Range Type2", based[S.basedOn]); // wiggly selectors keep these at the top level
if (S.mode) setIf(adv || sel, "ADBE Text Selector Mode", modes[S.mode]);
return { layer: l.name, animator: an.name, properties: added, selector: sel.name, tree: aemcp.propInfo(an, { depth: 3 }) };`,
  },
];

export const egpTools: JsxTool[] = [
  {
    name: "ae_essential_graphics",
    title: "Essential Graphics",
    description:
      "Work with a composition's Essential Graphics panel (Motion Graphics template): list its controllers, add a property as a controller " +
      "(with a display name), and set the template name. Export the result with ae_export_mogrt.",
    input: {
      comp: compRef,
      add: z.array(z.object({ layer: layerRef, path: z.string(), name: z.string() })).optional().describe("Properties to add as controllers."),
      templateName: z.string().optional(),
    },
    jsx: `
var c = aemcp.findComp(args.comp), added = [];
if (args.templateName) c.motionGraphicsTemplateName = args.templateName;
for (var i = 0; i < (args.add || []).length; i++) {
  var a = args.add[i], p = aemcp.resolveProp(aemcp.findLayer(c, a.layer), a.path);
  if (!p.canAddToMotionGraphicsTemplate(c)) aemcp.fail("'" + a.path + "' can't be added to the Essential Graphics panel");
  p.addToMotionGraphicsTemplateAs(c, a.name);
  added.push(a.name);
}
var names = [];
for (var k = 0; k < c.motionGraphicsTemplateControllerCount; k++) names.push(c.getMotionGraphicsTemplateControllerName(k + 1));
return { comp: c.name, templateName: c.motionGraphicsTemplateName, controllers: names, added: added };`,
  },
  {
    name: "ae_export_mogrt",
    title: "Export Motion Graphics template",
    description: "Export a composition as a Motion Graphics template (.mogrt) for Premiere Pro, to a folder (default: the user's Essential Graphics templates folder).",
    input: {
      comp: compRef,
      folder: z.string().optional().describe("Absolute output folder (default: the Essential Graphics local templates folder)."),
      overwrite: z.boolean().optional(),
    },
    destructive: true,
    idempotent: true,
    noUndo: true,
    jsx: `
var c = aemcp.findComp(args.comp);
if (!c.motionGraphicsTemplateControllerCount) log("Note: the template has no Essential Graphics controllers");
// read everything first: After Effects invalidates the comp object during the export
var info = { comp: c.name, templateName: c.motionGraphicsTemplateName || c.name, controllers: c.motionGraphicsTemplateControllerCount };
var ok = args.folder ? c.exportAsMotionGraphicsTemplate(!!args.overwrite, args.folder) : c.exportAsMotionGraphicsTemplate(!!args.overwrite);
if (!ok) aemcp.fail("Export failed (does the file exist already? pass overwrite: true)");
info.exported = true;
info.file = (args.folder ? args.folder : "the Essential Graphics templates folder") + "/" + info.templateName + ".mogrt";
return info;`,
  },
];

export const healthTools: JsxTool[] = [
  {
    name: "ae_project_health",
    title: "Project health check",
    description:
      "Check the whole project for problems: missing footage, missing or substituted fonts, effects whose plug-in is not installed, " +
      "expressions with errors, unused footage, empty comps and folders, duplicate comp names. Read-only.",
    input: { maxLayers: z.number().int().min(100).max(100000).optional().describe("Stop scanning after this many layers (default 5000).") },
    readOnly: true,
    timeoutMs: 300_000,
    jsx: `
var p = app.project, R = { missingFootage: [], missingFonts: [], missingEffects: [], expressionErrors: [], unusedFootage: [], emptyComps: [], emptyFolders: [], duplicateCompNames: [] };
var installed = {}, all = app.effects;
for (var e = 0; e < all.length; e++) installed["m:" + all[e].matchName] = true;
var names = {}, layersSeen = 0, lim = args.maxLayers || 5000, truncated = false;
// a plain function declaration: ExtendScript mishandles recursive named function expressions inside loops
function scanExpressions(g, path, comp, layer) {
  for (var q = 1; q <= g.numProperties; q++) {
    var pr = g.property(q), pp = path ? path + "/" + pr.name : pr.name;
    if (pr.propertyType === PropertyType.PROPERTY) { try { if (pr.canSetExpression && pr.expression && pr.expressionEnabled && pr.expressionError) R.expressionErrors.push({ comp: comp.name, layer: layer.name, property: pp, error: pr.expressionError }); } catch (x) {} }
    else scanExpressions(pr, pp, comp, layer);
  }
}
for (var i = 1; i <= p.numItems; i++) {
  var it = p.item(i);
  if (it instanceof FootageItem) {
    if (it.footageMissing) R.missingFootage.push({ id: it.id, name: it.name, file: it.file ? it.file.fsName : null });
    else if (it.usedIn.length === 0 && !(it.mainSource instanceof PlaceholderSource)) R.unusedFootage.push({ id: it.id, name: it.name });
  } else if (it instanceof FolderItem) {
    if (it.numItems === 0) R.emptyFolders.push(it.name);
  } else if (it instanceof CompItem) {
    var nk = "n:" + it.name; // prefixed: ExtendScript objects have built-in members (reflect, watch, toSource...)
    names[nk] = (names[nk] || 0) + 1;
    if (names[nk] === 2) R.duplicateCompNames.push(it.name);
    if (it.numLayers === 0) R.emptyComps.push(it.name);
    for (var j = 1; j <= it.numLayers; j++) {
      if (layersSeen++ >= lim) { truncated = true; break; }
      var L = it.layer(j), fx = L.property("ADBE Effect Parade");
      if (fx) for (var f = 1; f <= fx.numProperties; f++) { var ef = fx.property(f); if (!installed["m:" + ef.matchName]) R.missingEffects.push({ comp: it.name, layer: L.name, effect: ef.name, matchName: ef.matchName }); }
      scanExpressions(L, "", it, L);
    }
  }
}
try {
  var mf = app.fonts.missingOrSubstitutedFonts;
  for (var m = 0; m < mf.length; m++) R.missingFonts.push({ postScriptName: mf[m].postScriptName, family: mf[m].familyName, style: mf[m].styleName, substitute: mf[m].isSubstitute });
} catch (x) { R.missingFonts = "requires After Effects 24.0+"; }
var cap = function (a) { return a instanceof Array && a.length > 100 ? a.slice(0, 100).concat(["... " + (a.length - 100) + " more"]) : a; };
var summary = {};
for (var key in R) if (R.hasOwnProperty(key)) { summary[key] = R[key] instanceof Array ? R[key].length : R[key]; R[key] = cap(R[key]); }
return { summary: summary, layersScanned: layersSeen, truncated: truncated, details: R };`,
  },
];
