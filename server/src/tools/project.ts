import { z } from "zod";
import { itemRef, type JsxTool } from "./registry.js";

export const projectTools: JsxTool[] = [
  {
    name: "ae_get_project_info",
    title: "Get project info",
    description: "Summary of the open project: file path, dirty state, item counts, bit depth, render queue size, active item.",
    input: {},
    readOnly: true,
    jsx: "return aemcp.projectInfo();",
  },
  {
    name: "ae_list_items",
    title: "List project items",
    description: "List items in the Project panel (comps, footage, solids, folders) with ids, sizes, durations and folders.",
    input: {
      type: z.enum(["comp", "footage", "solid", "folder", "placeholder"]).optional().describe("Only items of this type."),
      nameContains: z.string().optional().describe("Case-insensitive name filter."),
      folder: itemRef.optional().describe("Only direct children of this folder."),
      limit: z.number().int().min(1).max(5000).optional().describe("Max items (default 300)."),
      offset: z.number().int().min(0).optional().describe("Skip this many matching items (paging; see nextOffset)."),
    },
    readOnly: true,
    jsx: `
var p = app.project, out = [], lim = args.limit || 300, skip = args.offset || 0, matched = 0, f = args.folder !== undefined ? aemcp.findItem(args.folder) : null;
var q = args.nameContains ? String(args.nameContains).toLowerCase() : null, more = false;
for (var i = 1; i <= p.numItems; i++) {
  var it = p.item(i);
  if (args.type && aemcp.itemType(it) !== args.type) continue;
  if (q && it.name.toLowerCase().indexOf(q) < 0) continue;
  if (f && it.parentFolder !== f) continue;
  if (matched++ < skip) continue;
  if (out.length >= lim) { more = true; break; }
  out.push(aemcp.itemInfo(it));
}
var r = { totalInProject: p.numItems, returned: out.length, items: out };
if (more) r.nextOffset = skip + out.length;
return r;`,
  },
  {
    name: "ae_get_item_info",
    title: "Get item info",
    description: "Detailed info about one project item (comp, footage, solid or folder).",
    input: { item: itemRef },
    readOnly: true,
    jsx: `
var it = aemcp.findItem(args.item);
if (it instanceof CompItem) return aemcp.compInfo(it, true);
var o = aemcp.itemInfo(it);
if (it instanceof FolderItem) { o.children = []; for (var i = 1; i <= it.numItems; i++) o.children.push({ id: it.item(i).id, name: it.item(i).name, type: aemcp.itemType(it.item(i)) }); }
o.usedIn = []; for (var u = 0; u < it.usedIn.length; u++) o.usedIn.push({ id: it.usedIn[u].id, name: it.usedIn[u].name });
return o;`,
  },
  {
    name: "ae_import_files",
    title: "Import files",
    description: "Import footage, images, audio, image sequences, or AE/PSD/AI files into the project.",
    input: {
      paths: z.array(z.string()).min(1).describe("Absolute file paths."),
      folder: itemRef.optional().describe("Project folder to put the imported items in."),
      sequence: z.boolean().optional().describe("Import the first file as an image sequence."),
      importAs: z.enum(["footage", "comp", "comp_cropped_layers", "project"]).optional().describe("For layered files (PSD/AI) or .aep."),
      addToComp: z.union([z.number().int(), z.string()]).optional().describe("Also add each imported item as a layer to this comp (id/name/'active')."),
    },
    jsx: `
var out = [], folder = args.folder !== undefined ? aemcp.findItem(args.folder) : null;
var comp = args.addToComp !== undefined ? aemcp.findComp(args.addToComp) : null;
for (var i = 0; i < args.paths.length; i++) {
  var f = new File(args.paths[i]);
  if (!f.exists) aemcp.fail("File not found: " + args.paths[i]);
  var io = new ImportOptions(f);
  if (args.sequence) io.sequence = true;
  if (args.importAs) {
    var m = { footage: ImportAsType.FOOTAGE, comp: ImportAsType.COMP, comp_cropped_layers: ImportAsType.COMP_CROPPED_LAYERS, project: ImportAsType.PROJECT };
    if (io.canImportAs(m[args.importAs])) io.importAs = m[args.importAs];
  }
  var it = app.project.importFile(io);
  if (folder) it.parentFolder = folder;
  if (comp && (it instanceof FootageItem || it instanceof CompItem)) comp.layers.add(it);
  out.push(aemcp.itemInfo(it));
}
return out;`,
  },
  {
    name: "ae_create_folder",
    title: "Create folder",
    description: "Create a folder in the Project panel.",
    input: { name: z.string(), parent: itemRef.optional() },
    jsx: `var f = app.project.items.addFolder(args.name); if (args.parent !== undefined) f.parentFolder = aemcp.findItem(args.parent); return aemcp.itemInfo(f);`,
  },
  {
    name: "ae_move_items",
    title: "Move items to folder",
    description: "Move project items into a folder (use folder 'root' for the project root).",
    input: { items: z.array(itemRef).min(1), folder: itemRef },
    jsx: `
var dest = args.folder === "root" ? app.project.rootFolder : aemcp.findItem(args.folder);
if (!(dest instanceof FolderItem)) aemcp.fail("Destination is not a folder");
var out = []; for (var i = 0; i < args.items.length; i++) { var it = aemcp.findItem(args.items[i]); it.parentFolder = dest; out.push(it.name); }
return { moved: out, to: dest.name };`,
  },
  {
    name: "ae_rename_item",
    title: "Rename item",
    description: "Rename a project item and/or set its comment and label color (0-16).",
    input: { item: itemRef, name: z.string().optional(), comment: z.string().optional(), label: z.number().int().min(0).max(16).optional() },
    jsx: `var it = aemcp.findItem(args.item); if (args.name !== undefined) it.name = args.name; if (args.comment !== undefined) it.comment = args.comment; if (args.label !== undefined) it.label = args.label; return aemcp.itemInfo(it);`,
  },
  {
    name: "ae_remove_items",
    title: "Delete items",
    description: "Delete project items (comps, footage, folders). Undoable.",
    input: { items: z.array(itemRef).min(1) },
    destructive: true,
    jsx: `var out = []; for (var i = 0; i < args.items.length; i++) { var it = aemcp.findItem(args.items[i]); out.push(it.name); it.remove(); } return { removed: out };`,
  },
  {
    name: "ae_replace_footage",
    title: "Replace footage",
    description: "Replace the source file of a footage item (relinks every layer using it).",
    input: { item: itemRef, path: z.string(), sequence: z.boolean().optional() },
    jsx: `
var it = aemcp.findItem(args.item); if (!(it instanceof FootageItem)) aemcp.fail("Not a footage item");
var f = new File(args.path); if (!f.exists) aemcp.fail("File not found: " + args.path);
if (args.sequence) it.replaceWithSequence(f, false); else it.replace(f);
return aemcp.itemInfo(it);`,
  },
  {
    name: "ae_save_project",
    title: "Save project",
    description: "Save the project (optionally Save As to a new .aep path).",
    input: { path: z.string().optional().describe("Absolute .aep path for Save As.") },
    noUndo: true,
    jsx: `if (args.path) app.project.save(new File(args.path)); else if (app.project.file) app.project.save(); else aemcp.fail("Project has never been saved: pass a path"); return { file: app.project.file ? app.project.file.fsName : null };`,
  },
  {
    name: "ae_open_project",
    title: "Open project",
    description: "Open an .aep/.aet project file. Unsaved changes in the current project are discarded only if discardChanges is true.",
    input: { path: z.string(), discardChanges: z.boolean().optional() },
    destructive: true,
    noUndo: true,
    jsx: `
if (app.project.dirty && !args.discardChanges) aemcp.fail("Current project has unsaved changes. Save first or pass discardChanges: true.");
var f = new File(args.path); if (!f.exists) aemcp.fail("File not found: " + args.path);
app.open(f); return aemcp.projectInfo();`,
  },
  {
    name: "ae_new_project",
    title: "New project",
    description: "Close the current project and create a new empty one.",
    input: { discardChanges: z.boolean().optional() },
    destructive: true,
    noUndo: true,
    jsx: `
if (app.project.dirty && !args.discardChanges) aemcp.fail("Current project has unsaved changes. Save first or pass discardChanges: true.");
app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.newProject(); return aemcp.projectInfo();`,
  },
];
