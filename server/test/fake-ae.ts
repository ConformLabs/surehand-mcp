// A small fake After Effects for running the real helper library (aemcp.jsxinc) in tests: one comp,
// one layer, one Opacity property, app.project.revision, and an undo stack that behaves like AE's
// (checked in AE 2025 and 2026): an undo group becomes one undo step only if something changed in it,
// an edit outside a group is a step of its own, an extra endUndoGroup() closes the group early, and
// Edit > Undo moves the revision forward (it doesn't restore it).
import { helperSource } from "../src/jsx.js";

class CompItem {}
class FolderItem {}
class FootageItem {}
class SolidSource {}
class PlaceholderSource {}
class AVLayer {}
const PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
const PropertyValueType = { NO_VALUE: 6412, OneD: 6417, TEXT_DOCUMENT: 6420 };
export const BlendingMode = { NORMAL: 5212, ADD: 5220 };
const TrackMatteType = { NO_TRACK_MATTE: 5012 };

interface State { opacity: number; blend: number; layerLabel: number; compLabel: number; comment: string }

export interface Fake {
  app: any;
  comp: any;
  layer: any;
  opacity: any;
  /** property values read so far (what makes a snapshot slow) */
  reads: { n: number };
  /** an edit: bumps the revision like AE does (outside an undo group it is an undo step of its own) */
  edit: (f: () => void) => void;
  /** the undo steps, oldest first (their names) */
  undoStack: () => string[];
  /** how many times Edit > Undo ran */
  undos: { n: number };
}

export function fakeAE(opts: { revision?: boolean; undoWorks?: boolean } = {}): Fake {
  const reads = { n: 0 };
  const undos = { n: 0 };
  let revision = 1;
  let opacityValue = 100;
  const opacity: any = {
    name: "Opacity",
    propertyType: PropertyType.PROPERTY,
    propertyValueType: PropertyValueType.OneD,
    canSetExpression: true,
    expression: "",
    numKeys: 0,
    get value() {
      reads.n++;
      return opacityValue;
    },
    set value(v: number) {
      edit(() => (opacityValue = v));
    },
    setValue(v: number) {
      this.value = v;
    },
  };
  const transform: any = { name: "Transform", propertyType: PropertyType.NAMED_GROUP, numProperties: 1, property: () => opacity };
  const layer: any = Object.assign(new AVLayer(), {
    id: 7, name: "BG", inPoint: 0, outPoint: 4, startTime: 0, stretch: 100, parent: null, enabled: true, solo: false, locked: false,
    shy: false, label: 1, threeDLayer: false, blendingMode: BlendingMode.NORMAL, trackMatteType: TrackMatteType.NO_TRACK_MATTE,
    adjustmentLayer: false, motionBlur: false, guideLayer: false, audioEnabled: false, numProperties: 1, property: () => transform,
  });
  const comp: any = Object.assign(new CompItem(), {
    id: 1, name: "Main", parentFolder: { name: "Root" }, label: 1, comment: "", width: 1920, height: 1080, duration: 4, frameRate: 25,
    pixelAspect: 1, bgColor: [0, 0, 0], workAreaStart: 0, workAreaDuration: 4, numLayers: 1, useProxy: false, time: 0,
    layer: () => layer,
  });
  const project: any = { numItems: 1, item: () => comp, itemByID: (id: number) => (id === 1 ? comp : null), activeItem: comp, bitsPerChannel: 8 };
  if (opts.revision !== false) Object.defineProperty(project, "revision", { get: () => revision });

  // ---------- undo ----------
  const state = (): State => ({ opacity: opacityValue, blend: layer.blendingMode, layerLabel: layer.label, compLabel: comp.label, comment: comp.comment });
  const restore = (s: State) => {
    opacityValue = s.opacity;
    layer.blendingMode = s.blend;
    layer.label = s.layerLabel;
    comp.label = s.compLabel;
    comp.comment = s.comment;
  };
  const same = (a: State, b: State) => JSON.stringify(a) === JSON.stringify(b);
  const stack: { name: string; before: State; moved: boolean }[] = [];
  let group: { name: string; before: State; rev: number } | null = null;
  const app = {
    project,
    beginSuppressDialogs() {},
    endSuppressDialogs() {},
    beginUndoGroup(name: string) {
      if (!group) group = { name, before: state(), rev: revision }; // nested groups fold into the outer one
    },
    endUndoGroup() {
      if (!group) return;
      if (!same(group.before, state())) stack.push({ name: group.name, before: group.before, moved: revision !== group.rev });
      group = null;
    },
    executeCommand(id: number) {
      if (id !== 16 || opts.undoWorks === false) return;
      undos.n++;
      const step = stack.pop();
      if (!step) return;
      restore(step.before);
      if (step.moved) revision++;
    },
  };
  function edit(f: () => void) {
    const before = state(), rev = revision;
    f();
    if (revision !== rev) return; // an edit inside (setting the value) counted already
    revision++;
    if (!group) stack.push({ name: "(edit)", before, moved: true });
  }
  return { app, comp, layer, opacity, reads, edit, undoStack: () => stack.map((s) => s.name), undos };
}

/** The real helper library (aemcp.jsxinc), loaded into the fake After Effects. */
export function loadHelpers(f: Fake): any {
  const globals = { CompItem, FolderItem, FootageItem, SolidSource, PlaceholderSource, AVLayer, PropertyType, PropertyValueType, BlendingMode, TrackMatteType };
  const names = Object.keys(globals);
  const $ = { global: { ...globals } };
  return new Function("$", "app", ...names, "var aemcp;\n" + helperSource + "\nreturn aemcp;")($, f.app, ...names.map((n) => (globals as any)[n]));
}
