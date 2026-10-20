/**
 * The server's instructions to the AI, the most important rules first. Claude Code cuts them at 4,096 characters:
 * a test keeps the longest version (with `onDemand`) under 4,000. `onDemand`: the chat has only the core tools
 * loaded (tools/profile.ts).
 */
export function serverInstructions(onDemand: boolean): string {
  return `This server controls a running Adobe After Effects instance through ExtendScript. Rules, most important first:
1. Check the connection first: ae_status.
2. Read before editing: ae_get_project_info, ae_get_comp_info, ae_get_comp_map (nested precomps, parenting, expression
   links). Use ae_get_properties to find property paths/match names before setting values.
3. Every edit returns a "Changes" list of exactly what changed in the project: use it to confirm the edit did what you
   meant. Every tool call is one undo step; ae_undo reverts it.
4. After visual changes, look at the result: ae_render_frame (one frame; can zoom a region, solo layers, show alpha, diff),
   ae_render_contact_sheet (motion over time). Check layout numerically with ae_get_layer_bounds.
5. Prove structural edits that should not change the picture (un-precompose, bake expressions, reorder effects, simplify
   a rig): ae_prove_identical (action "run" with the edits as batch steps) gives pixel evidence that the render is
   unchanged. Report its verdict (IDENTICAL, or DIFFERS: then undo or explain) as given.
6. Before delivery, ae_preflight checks the comp and/or its render against the user's own delivery spec (size, frame
   rate, safe areas over time, text size and reading speed, missing items, file codec/levels/loudness); action "schema"
   helps write the spec. Never invent spec values; never call a check PASS that did not run.
7. Never work around a refusal: when the permission mode (Full / Ask / Read-only in the Surehand panel), a Deny or a
   pause stops a call, report it; don't get the same result with another tool or a script.${
    onDemand
      ? `
8. This chat has the core tools loaded. Many more (3D, audio, text styling, footage, render settings, masks, Essential
   Graphics, project management...) are available on demand: ae_tools lists them, ae_tools {describe: [...]} gives
   parameters, ae_call runs them.`
      : ""
  }
Also:
- Prefer the specific tools (ae_create_comp, ae_add_layer, ae_set_keyframes, ae_apply_effect...) for common edits; use
  ae_run_script for anything else - the full AE scripting API is available. Read the resource aemcp://docs/extendscript
  before writing non-trivial ExtendScript.
- For an unfamiliar or inherited project, ae_project_xray explains how it works: what the render queue pulls in,
  expression dependencies and fragile links, missing items, footage specs and what makes it heavy.
- Sending a project to someone: ae_handoff_package collects it with its footage, lists what the recipient needs, and
  with verify proves the package renders the same.
- Exact timing: the keyframe table (ae_get_keyframes / ae_set_keyframe_table: frames or seconds, exact speed and
  influence), ae_copy_ease, ae_retime_keyframes (whole frames), ae_audit_easing. Layout: ae_align_layers moves layers by
  their measured on-screen bounds; ae_reformat makes the comp at another size by the user's rules and checks every frame.
  ae_find_files locates files on disk; ae_export_frames saves PNG stills.
- Tools never replace an existing file silently: ae_save_project (Save As), ae_render_frame and ae_render_contact_sheet
  (outputPath) and ae_export_frames refuse and say so. Pass overwrite: true only when replacing it is intended.`;
}

export const EXTENDSCRIPT_DOC = `# After Effects ExtendScript cheat sheet (for ae_run_script)

## Language
- Write normal modern JavaScript: let/const, arrow functions, template strings, destructuring, spread, classes,
  ?. and ??, for...of, map/filter/forEach/find/includes, Object.keys/entries/assign, JSON. ae_run_script converts it
  for After Effects' ExtendScript engine (ES3) automatically and keeps line numbers.
- Not available: async/await, Promise, Map/Set/WeakMap, generators, Symbol, getters/setters, regex lookbehind/named groups.
- Your code is a function body: \`return\` a value to get it back. \`args\` holds the JSON args, \`log(...)\` adds log lines.
- AE collections are **1-based**: app.project.item(i), comp.layer(i), group.property(i). JS arrays are 0-based.
- Times are in seconds. Colors are [r,g,b] floats 0-1 (aemcp.color("#ff8800") converts).
- Use index loops or for...of over arrays, not for...in (polyfilled methods are enumerable in ES3).
- ES3 reserves words such as int, short, char, float, double, long, byte, boolean, class, default. Variables, functions
  and parameters with those names are renamed automatically, and o.default / { class: 1 } become string keys. Globals
  you never declare can't be renamed: declare them or use another name.
- Only with transpile:false or ae_run_script_file (raw ExtendScript): use var/function only, put parentheses around
  nested ?: (ExtendScript evaluates a ? b : c ? d : e left-to-right), don't use reserved words as names, and write
  keyword properties as strings (o["default"]).
- After Effects may run in another language: prefer match names ("ADBE Opacity", "ADBE Glo2") over display names in
  scripts. The tools accept common English names everywhere.
- Don't use plain objects as dictionaries keyed by arbitrary names: ExtendScript objects already have members such as
  "+", "-", "*", "reflect", "watch" and "toSource" (operator overloading), so a comp named "-" collides. Prefix keys
  (map["k:" + name]).
- Edits report what changed (items, layers, properties, keyframes, expressions, effects) after every call.

## Helpers (global \`aemcp\`)
aemcp.findComp(idOrName|"active"), aemcp.findLayer(comp, indexOrName), aemcp.findItem(idOrName),
aemcp.resolveProp(layer, "Transform/Position" | ["ADBE Transform Group","ADBE Position"]),
aemcp.compInfo(comp, withLayers), aemcp.layerInfo(layer, detail), aemcp.propInfo(prop, {depth, keyframes}),
aemcp.itemInfo(item), aemcp.projectInfo(), aemcp.keyframes(prop), aemcp.color(v), aemcp.color3(v),
aemcp.applyText(textDocument, {text,font,fontSize,fillColor,...}), aemcp.fail("message"), aemcp.stringify(v).

## Project & items
\`\`\`js
var p = app.project;                       // p.numItems, p.item(i), p.activeItem, p.selection, p.rootFolder
var comp = p.items.addComp("Main", 1920, 1080, 1, 10, 30); // name,w,h,pixelAspect,duration,fps
var folder = p.items.addFolder("Assets");
var footage = p.importFile(new ImportOptions(new File("/path/clip.mp4")));
comp.openInViewer();
item instanceof CompItem / FootageItem / FolderItem
\`\`\`

## Layers (comp.layers)
\`\`\`js
var L = comp.layers;
L.addSolid([1,0,0], "Red", comp.width, comp.height, 1, comp.duration);
var t = L.addText("Hello");  L.addBoxText([800,200], "Para");
L.addShape(); L.addNull(); L.addCamera("Cam", [960,540]); L.addLight("Key", [960,540]);
L.add(footageOrComp);
layer.name, .index, .enabled, .solo, .locked, .shy, .inPoint, .outPoint, .startTime, .stretch, .parent = otherLayer,
layer.threeDLayer, .blendingMode = BlendingMode.SCREEN, .adjustmentLayer, .motionBlur, .label (0-16)
layer.moveToBeginning(), .moveBefore(l), .moveAfter(l), .duplicate(), .remove(), .selected = true
layer.setTrackMatte(matteLayer, TrackMatteType.ALPHA)   // AE 23+
\`\`\`

## Properties & keyframes
\`\`\`js
var tr = layer.property("ADBE Transform Group");      // or layer.transform
var pos = tr.property("ADBE Position");               // or layer.transform.position
pos.setValue([960,540]);
pos.setValueAtTime(1, [100,100]);                     // creates a keyframe
pos.setValuesAtTimes([0,1],[[0,0],[100,100]]);
pos.numKeys, pos.keyTime(k), pos.keyValue(k), pos.removeKey(k), pos.nearestKeyIndex(t)
pos.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER);
pos.setTemporalEaseAtKey(k, [new KeyframeEase(0, 75)], [new KeyframeEase(0, 75)]); // spatial props: 1 ease; Scale: 3
pos.expression = "wiggle(2, 30)"; pos.expressionError
pos.valueAtTime(t, false)
\`\`\`
Common match names: ADBE Anchor Point, ADBE Position, ADBE Scale, ADBE Rotate Z, ADBE Opacity, ADBE Position_0/_1 (separated),
ADBE Mask Parade > ADBE Mask Atom > ADBE Mask Shape / ADBE Mask Feather / ADBE Mask Opacity,
ADBE Effect Parade (effects), ADBE Text Properties > ADBE Text Document (source text), ADBE Marker.

## Text
\`\`\`js
var src = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
var td = src.value; td.text = "New"; td.font = "Arial-BoldMT"; td.fontSize = 120;
td.applyFill = true; td.fillColor = [1,1,1]; td.justification = ParagraphJustification.CENTER_JUSTIFY;
src.setValue(td);
\`\`\`

## Shape layers
\`\`\`js
var s = comp.layers.addShape(), g = s.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
var v = g.property("ADBE Vectors Group");
v.addProperty("ADBE Vector Shape - Rect").property("ADBE Vector Rect Size").setValue([400,200]);
// also: "ADBE Vector Shape - Ellipse", "ADBE Vector Shape - Star", "ADBE Vector Shape - Group" (path)
v.addProperty("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color").setValue([1,0.5,0]);
v.addProperty("ADBE Vector Graphic - Stroke");
// operators: "ADBE Vector Filter - Trim", "ADBE Vector Filter - Repeater", "ADBE Vector Filter - RC" (round corners), "ADBE Vector Filter - Offset"
\`\`\`

## Effects
\`\`\`js
var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2");
fx.property("Blurriness").setValue(20);
// match names: ADBE Fill, ADBE Glo2 (Glow), ADBE Drop Shadow, ADBE Tint, ADBE Curves, ADBE Easy Levels2, ADBE Ramp (Gradient Ramp),
// ADBE Fractal Noise, ADBE Turbulent Displace, ADBE Slider Control, ADBE Color Control, ADBE Checkbox Control, ADBE Point Control, ADBE Layer Control,
// ADBE Motion Blur (Directional Blur), ADBE Brightness & Contrast 2, ADBE HUE SATURATION, ADBE Venetian Blinds, ADBE Linear Wipe, ADBE Radial Wipe
// list all: app.effects[i].matchName / displayName / category
\`\`\`

## Render queue
\`\`\`js
var rqi = app.project.renderQueue.items.add(comp);
rqi.applyTemplate("Best Settings"); var om = rqi.outputModule(1); om.applyTemplate("High Quality"); om.file = new File("/out/movie.mov");
app.project.renderQueue.render();      // blocks until done
comp.saveFrameToPng(time, new File("/tmp/frame.png"));
\`\`\`

## Misc
- app.beginUndoGroup / endUndoGroup are handled for you.
- app.executeCommand(app.findMenuCommandId("Easy Ease")) runs a menu command on the selection.
- File/Folder: new File(path).exists, .open("r"), .read(), .write(), .close(); Folder.temp, Folder.desktop.
- system.callSystem("cmd") runs a shell command (needs "Allow Scripts to Write Files and Access Network").
- $.sleep(ms), $.os, app.version, app.project.save(new File(path)).
`;
