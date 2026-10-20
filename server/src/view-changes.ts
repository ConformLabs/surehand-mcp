// An edit's change report (aemcp.jsxinc's Changes, the "Changes:" lines of every edit) as the views' list:
// comp › layer › property, with the old and new value apart so the view can strike the old one through.
// The text lines (jsx.ts formatChanges) are unchanged; this reads the same data.
import type { Changes } from "./jsx.js";
import type { ViewChange } from "./views/types.js";

/** "A -> B" as its two sides; null when it isn't exactly one change ("a -> b; c -> d", "keyframes 2 -> 3, expression added"). */
export function splitChange(s: string): { from: string; to: string } | null {
  if (/; |, (?:keyframes|expression)/.test(s)) return null;
  const parts = s.split(" -> ");
  return parts.length === 2 && parts[0] && parts[1] ? { from: parts[0], to: parts[1] } : null;
}

/** "parent none -> Logo_Null" -> the field and its two sides (the field is the first word); null when not one change. */
export function splitField(s: string): { what: string; from: string; to: string } | null {
  const m = /^(\S+) ([\s\S]+)$/.exec(s);
  const c = m && splitChange(m[2]);
  return c ? { what: m![1], ...c } : null;
}

/** At most this many changes go to a view (the result has to stay small; the text has its own limit). */
export const MAX_VIEW_CHANGES = 300;
export const capChanges = (list: ViewChange[]) => ({ changes: list.slice(0, MAX_VIEW_CHANGES), moreChanges: Math.max(0, list.length - MAX_VIEW_CHANGES) });

const lastSeg = (p: string) => p.split("/").pop() ?? p;
const parentPath = (p: string) => p.split("/").slice(0, -1).join(" › ") || undefined;
const verb = (op: string) => (op === "+" ? "added" : "removed");

/** The change report as view rows (in its own order: items, layers, properties). */
export function changesFromReport(ch: Changes | undefined): ViewChange[] {
  if (!ch || ch.error || ch.unlisted) return [];
  const out: ViewChange[] = [];
  const op = (o: string) => (o === "+" || o === "-" ? o : "~") as ViewChange["op"];
  for (const [o, type, name, extra] of ch.items) {
    const comp = type === "comp" ? name : undefined;
    if (o === "+" || o === "-") out.push({ op: op(o), ...(comp ? { comp } : {}), what: `${type} ${name} ${verb(o)}` });
    else if (type === "project") out.push({ op: "~", what: `Project settings: ${extra}` });
    else {
      const f = splitField(String(extra ?? ""));
      out.push(f ? { op: "~", ...(comp ? { comp } : {}), ...f } : { op: "~", ...(comp ? { comp } : {}), what: `${type} ${name}: ${extra}` });
    }
  }
  for (const [o, comp, layer, extra] of ch.layers) {
    if (o === "+" || o === "-") out.push({ op: op(o), comp, layer, what: `${layer} ${verb(o)}` });
    else {
      const f = splitField(extra ?? "");
      out.push(f ? { op: "~", comp, layer, ...f } : { op: "~", comp, layer, what: extra ?? "changed" });
    }
  }
  for (const [o, layer, path, extra, comp] of ch.props) {
    const where = { ...(comp ? { comp } : {}), layer, ...(parentPath(path) ? { path: parentPath(path) } : {}) };
    if (o === "+" || o === "-") out.push({ op: op(o), ...where, what: `${lastSeg(path)} ${verb(o)}` });
    else {
      const c = splitChange(extra ?? "");
      out.push(c ? { op: "~", ...where, what: lastSeg(path), ...c } : { op: "~", ...where, what: `${lastSeg(path)}: ${extra}` });
    }
  }
  return out;
}
