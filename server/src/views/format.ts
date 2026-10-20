// Property values as the views show them: "80 %" instead of [80,80,100], "960, 540 px", "45°", "#FF8A5C".
// Only for display: the change report and the history diff keep their raw values in the text.

const n2 = (v: number) => String(Math.round(v * 100) / 100);

/** "[80,80,100]" / "50" -> numbers; anything else (a string, "default", "none", a path) -> null */
function numbers(raw: string): number[] | null {
  const t = raw.trim();
  const m = /^\[([-\d., e+]+)\]$/.exec(t) ?? /^(-?[\d.]+(?:e[-+]?\d+)?)$/.exec(t);
  if (!m) return null;
  const v = m[1].split(",").map((s) => Number(s.trim()));
  return v.length && v.every((x) => Number.isFinite(x)) ? v : null;
}

const hex = (v: number[]) =>
  "#" +
  v
    .slice(0, 3)
    .map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

type Kind = "scale" | "position" | "percent" | "angle" | "color" | null;
function kindOf(what: string): Kind {
  const name = what.trim();
  if (/^Scale$/i.test(name)) return "scale";
  if (/^(Position|Anchor Point|Point of Interest|[XYZ] Position)$/i.test(name)) return "position";
  if (/Opacity$/i.test(name)) return "percent";
  if (/(Rotation|Orientation)$/i.test(name)) return "angle";
  if (/Colou?r$/i.test(name)) return "color";
  return null;
}
/** a 2D layer's z as After Effects reports it (scale 100 %, position 0): left out when both sides have it */
const Z: Partial<Record<NonNullable<Kind>, number>> = { scale: 100, position: 0 };

function show(kind: Kind, v: number[] | null, raw: string, dropZ: boolean): string {
  if (!v || !kind) return raw;
  const s = dropZ && v.length === 3 ? v.slice(0, 2) : v;
  switch (kind) {
    case "scale":
      return s.every((x) => x === s[0]) ? `${n2(s[0])} %` : `${s.map(n2).join(" × ")} %`;
    case "position":
      return `${s.map(n2).join(", ")} px`;
    case "percent":
      return v.length === 1 ? `${n2(v[0])} %` : raw;
    case "angle":
      return `${v.map(n2).join("°, ")}°`;
    case "color":
      return (v.length === 3 || v.length === 4) && v.every((x) => x >= 0 && x <= 1) ? hex(v) : raw;
  }
}

/** A single value of property `what` (its display name) in the panel's units, or as it is. */
export function prettyValue(what: string, raw: string): string {
  const k = kindOf(what), v = numbers(raw), z = k ? Z[k] : undefined;
  return show(k, v, raw, z !== undefined && v?.length === 3 && v[2] === z);
}

/** A change's two sides in the panel's units; z left out only when both sides are 2D. */
export function prettyChange(what: string, from: string, to: string): { from: string; to: string } {
  const k = kindOf(what), a = numbers(from), b = numbers(to), z = k ? Z[k] : undefined;
  const twoD = (v: number[] | null) => !v || (v.length === 3 && v[2] === z);
  const dropZ = z !== undefined && twoD(a) && twoD(b);
  return { from: show(k, a, from, dropZ), to: show(k, b, to, dropZ) };
}
