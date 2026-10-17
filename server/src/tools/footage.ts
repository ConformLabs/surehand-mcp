import { z } from "zod";
import { itemRef, type JsxTool } from "./registry.js";

const interpretation = `
function interp(it) {
  var s = it.mainSource, o = { item: it.name, id: it.id, file: it.file ? it.file.fsName : null, missing: it.footageMissing, pixelAspect: it.pixelAspect };
  try { o.isStill = s.isStill; } catch (e) {}
  try { o.nativeFrameRate = aemcp.round(s.nativeFrameRate); o.conformFrameRate = aemcp.round(s.conformFrameRate); o.displayFrameRate = aemcp.round(s.displayFrameRate); } catch (e) {}
  try { o.hasAlpha = s.hasAlpha; o.alphaMode = aemcp.enumName(AlphaMode, s.alphaMode); o.invertAlpha = s.invertAlpha; o.premulColor = s.premulColor; } catch (e) {}
  try { o.fieldSeparation = aemcp.enumName(FieldSeparationType, s.fieldSeparationType); o.highQualityFieldSeparation = s.highQualityFieldSeparation; o.removePulldown = aemcp.enumName(PulldownPhase, s.removePulldown); } catch (e) {}
  try { o.loop = s.loop; } catch (e) {}
  try { o.useProxy = it.useProxy; o.proxy = it.proxySource ? (it.proxySource.file ? it.proxySource.file.fsName : "placeholder") : null; } catch (e) {}
  return o;
}`;

export const footageTools: JsxTool[] = [
  {
    name: "ae_set_footage_interpretation",
    title: "Interpret footage",
    description:
      "Read or change how footage is interpreted (File > Interpret Footage): conform frame rate, alpha (ignore/straight/premultiplied, invert, " +
      "premultiplied color), field separation, pulldown removal, looping, pixel aspect ratio. With no settings it only reports the current interpretation.",
    input: {
      items: z.array(itemRef).min(1),
      conformFrameRate: z.number().min(0).optional().describe("0 = use the file's native rate."),
      alphaMode: z.enum(["IGNORE", "STRAIGHT", "PREMULTIPLIED"]).optional(),
      invertAlpha: z.boolean().optional(),
      premulColor: z.union([z.string(), z.array(z.number())]).optional(),
      fieldSeparation: z.enum(["OFF", "UPPER_FIELD_FIRST", "LOWER_FIELD_FIRST"]).optional(),
      highQualityFieldSeparation: z.boolean().optional(),
      removePulldown: z.enum(["OFF", "SSWWW", "SWWWS", "SWWWW_24P_ADVANCE", "WSSWW", "WSWWW_24P_ADVANCE", "WWSSW", "WWSWW_24P_ADVANCE", "WWWSS", "WWWSW_24P_ADVANCE", "WWWWS_24P_ADVANCE"]).optional(),
      loop: z.number().int().min(1).optional(),
      pixelAspect: z.number().optional(),
    },
    jsx: `${interpretation}
var out = [];
for (var i = 0; i < args.items.length; i++) {
  var it = aemcp.findItem(args.items[i]);
  if (!(it instanceof FootageItem)) aemcp.fail("'" + it.name + "' is not footage");
  var s = it.mainSource, skipped = [];
  // each setting on its own: some don't apply to every file (e.g. loop or frame rate on a still)
  var set = function (label, fn) { try { fn(); } catch (e) { skipped.push(label + ": " + e.message.replace(/^After Effects error: /, "")); } };
  if (args.conformFrameRate !== undefined) set("conformFrameRate", function () { s.conformFrameRate = args.conformFrameRate; });
  if (args.alphaMode) set("alphaMode", function () { s.alphaMode = AlphaMode[args.alphaMode]; });
  if (args.invertAlpha !== undefined) set("invertAlpha", function () { s.invertAlpha = args.invertAlpha; });
  if (args.premulColor !== undefined) set("premulColor", function () { s.premulColor = aemcp.color3(args.premulColor); });
  if (args.fieldSeparation) set("fieldSeparation", function () { s.fieldSeparationType = FieldSeparationType[args.fieldSeparation]; });
  if (args.highQualityFieldSeparation !== undefined) set("highQualityFieldSeparation", function () { s.highQualityFieldSeparation = args.highQualityFieldSeparation; });
  if (args.removePulldown) set("removePulldown", function () { s.removePulldown = PulldownPhase[args.removePulldown]; });
  if (args.loop !== undefined) set("loop", function () { s.loop = args.loop; });
  if (args.pixelAspect !== undefined) set("pixelAspect", function () { it.pixelAspect = args.pixelAspect; });
  var info = interp(it);
  if (skipped.length) info.notApplied = skipped;
  out.push(info);
}
return out;`,
  },
  {
    name: "ae_set_proxy",
    title: "Set proxy",
    description: "Assign a proxy file (or image sequence) to footage or a comp, switch between proxy and original, or remove the proxy.",
    input: {
      item: itemRef,
      path: z.string().optional().describe("Absolute path to the proxy file; omit to only toggle useProxy."),
      sequence: z.boolean().optional().describe("The proxy is an image sequence (path = first frame)."),
      remove: z.boolean().optional().describe("Remove the proxy."),
      useProxy: z.boolean().optional().describe("Use the proxy (true) or the original (false)."),
    },
    jsx: `${interpretation}
var it = aemcp.findItem(args.item);
if (!(it instanceof FootageItem || it instanceof CompItem)) aemcp.fail("'" + it.name + "' is not footage or a comp");
if (args.remove) it.setProxyToNone();
else if (args.path) {
  var f = new File(args.path); if (!f.exists) aemcp.fail("File not found: " + args.path);
  if (args.sequence) it.setProxyWithSequence(f, false); else it.setProxy(f);
}
if (args.useProxy !== undefined) it.useProxy = args.useProxy;
return it instanceof FootageItem ? interp(it) : { item: it.name, useProxy: it.useProxy, proxy: it.proxySource ? it.proxySource.file.fsName : null };`,
  },
  {
    name: "ae_relink_footage",
    title: "Relink footage",
    description:
      "Find missing footage by file name inside a folder (searched recursively) and relink it; image sequences stay sequences. " +
      "By default handles every missing item; pass items to relink specific ones (also when not missing, e.g. to switch to a new folder).",
    input: {
      searchFolder: z.string().describe("Absolute folder to search."),
      items: z.array(itemRef).optional(),
      maxFiles: z.number().int().min(100).max(500000).optional().describe("Stop scanning after this many files (default 50000)."),
    },
    jsx: `
var root = new Folder(args.searchFolder);
if (!root.exists) aemcp.fail("Folder not found: " + args.searchFolder);
var targets = [];
if (args.items) { for (var i = 0; i < args.items.length; i++) targets.push(aemcp.findItem(args.items[i])); }
else { for (var j = 1; j <= app.project.numItems; j++) { var it = app.project.item(j); if (it instanceof FootageItem && it.footageMissing) targets.push(it); } }
if (!targets.length) return { relinked: [], notFound: [], message: "No missing footage" };
// index file names in the folder tree (case-insensitive)
var index = {}, scanned = 0, limit = args.maxFiles || 50000, truncated = false;
function scan(folder) {
  var list = folder.getFiles();
  for (var k = 0; k < list.length; k++) {
    if (scanned >= limit) { truncated = true; return; }
    if (list[k] instanceof Folder) scan(list[k]);
    else { scanned++; var n = "f:" + decodeURI(list[k].name).toLowerCase(); if (!index[n]) index[n] = list[k]; } // prefixed key: see aemcp notes
  }
}
scan(root);
var relinked = [], notFound = [];
for (var t = 0; t < targets.length; t++) {
  var item = targets[t];
  if (!(item instanceof FootageItem) || !item.file) { notFound.push({ item: item.name, reason: "not file footage" }); continue; }
  var name = decodeURI(item.file.name).toLowerCase(), hit = index["f:" + name];
  if (!hit) { notFound.push({ item: item.name, file: decodeURI(item.file.name) }); continue; }
  var seq = false;
  try { seq = !item.mainSource.isStill && /\\d+\\.(png|jpe?g|exr|tiff?|dpx|tga|psd|bmp|cin|hdr|sgi)$/i.test(name); } catch (e) {}
  if (seq) item.replaceWithSequence(hit, false); else item.replace(hit);
  relinked.push({ item: item.name, file: hit.fsName, sequence: seq });
}
return { relinked: relinked, notFound: notFound, filesScanned: scanned, truncated: truncated };`,
  },
];
