import { z } from "zod";
import { CAPABILITIES_JSX } from "../capabilities.js";
import type { JsxTool } from "./registry.js";

export const appTools: JsxTool[] = [
  {
    name: "ae_execute_menu_command",
    title: "Execute menu command",
    description:
      'Run any After Effects menu command by its exact menu name (e.g. "Pre-compose...", "Easy Ease", "Center Anchor Point in Layer Content", "Fit to Comp", "Sequence Layers...") or numeric command id. Acts on the current selection.',
    input: { command: z.union([z.string(), z.number().int()]) },
    jsx: `
var id = typeof args.command === "number" ? args.command : app.findMenuCommandId(args.command);
if (!id) aemcp.fail("Menu command not found: " + args.command);
app.executeCommand(id); return { executed: args.command, id: id };`,
  },
  {
    name: "ae_undo",
    title: "Undo",
    description: "Undo the last action(s) in After Effects (Edit > Undo).",
    input: { steps: z.number().int().min(1).max(50).optional() },
    noUndo: true,
    report: true,
    jsx: `var n = args.steps || 1; for (var i = 0; i < n; i++) app.executeCommand(16); return { undone: n };`,
  },
  {
    name: "ae_redo",
    title: "Redo",
    description: "Redo the last undone action(s).",
    input: { steps: z.number().int().min(1).max(50).optional() },
    noUndo: true,
    report: true,
    jsx: `var n = args.steps || 1; for (var i = 0; i < n; i++) app.executeCommand(2035); return { redone: n };`,
  },
  {
    name: "ae_purge",
    title: "Purge caches",
    description: "Purge memory/disk caches (all memory, undo history, image caches, snapshot).",
    input: { target: z.enum(["ALL_CACHES", "ALL_MEMORY_CACHES", "UNDO_CACHES", "SNAPSHOT_CACHES", "IMAGE_CACHES"]).optional() },
    noUndo: true,
    jsx: `app.purge(PurgeTarget[args.target || "ALL_MEMORY_CACHES"]); return { purged: args.target || "ALL_MEMORY_CACHES" };`,
  },
  {
    name: "ae_get_fonts",
    title: "List fonts",
    description: "Search installed fonts (AE 24.0+): returns PostScript names to use for text layers.",
    input: { nameContains: z.string().optional(), limit: z.number().int().optional().describe("Default 100.") },
    readOnly: true,
    jsx: `
if (!app.fonts) aemcp.fail("app.fonts requires After Effects 24.0 or newer");
var out = [], q = args.nameContains ? args.nameContains.toLowerCase() : null, lim = args.limit || 100, all = app.fonts.allFonts;
for (var i = 0; i < all.length && out.length < lim; i++) for (var j = 0; j < all[i].length && out.length < lim; j++) {
  var f = all[i][j];
  if (q && f.familyName.toLowerCase().indexOf(q) < 0 && f.postScriptName.toLowerCase().indexOf(q) < 0) continue;
  out.push({ postScriptName: f.postScriptName, family: f.familyName, style: f.styleName });
}
return out;`,
  },
  {
    name: "ae_system_info",
    title: "System & app info",
    description:
      "After Effects version, OS, memory, folders, scripting permissions, expression engine, and which newer scripting features this " +
      "AE version supports (per-character text, render settings API, Essential Graphics, keyframe labels...).",
    input: {},
    readOnly: true,
    tempItems: true,
    jsx: `
var caps = (function () {${CAPABILITIES_JSX}
})();
var o = { features: caps.features, appVersion: app.version, buildName: app.buildName, os: $.os, locale: $.locale, screens: $.screens, memoryInUse: app.memoryInUse, tempFolder: Folder.temp.fsName,
  userDataFolder: Folder.userData.fsName, appFolder: Folder.appPackage ? Folder.appPackage.fsName : null };
try { o.canWriteFiles = app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY") === 1; } catch (e) {}
try { o.expressionEngine = app.project.expressionEngine; } catch (e) {}
return o;`,
  },
];
