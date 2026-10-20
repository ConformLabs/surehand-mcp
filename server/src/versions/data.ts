// Versions from data: the data side, in TypeScript and unit-tested (test/versions.test.ts). Reading the rows
// (CSV or JSON file, or inline), and turning each cell into the exact value a target gets: text, a number in the
// user's own format, a colour from the cell or from the user's rules, a footage path, a property value, a size in
// pixels from the user's value-to-size mapping. Nothing here has a default look: every format, colour and size comes
// from the call.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";

export type Cell = string | number | boolean | null;
export interface Table {
  columns: string[];
  rows: Record<string, Cell>[];
  /** where the rows came from: the file, or "inline rows" */
  source: string;
  /** the data file's folder (relative footage paths resolve against it) */
  dir?: string;
}

// ---------- reading ----------

/** RFC 4180 CSV: quoted fields ("" inside quotes), line breaks inside quotes, CRLF or LF, a UTF-8 BOM. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  text = text.replace(/^﻿/, "");
  const d = delimiter ?? sniffDelimiter(text);
  const out: string[][] = [];
  let row: string[] = [], field = "", quoted = false, i = 0, line = 1, startLine = 1;
  const endRow = () => {
    row.push(field);
    field = "";
    // a line with nothing on it is not a row
    if (!(row.length === 1 && row[0] === "")) out.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      if (ch === "\n") line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      startLine = line;
      i++;
    } else if (ch === d) {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\r" || ch === "\n") {
      endRow();
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      line++;
    } else {
      field += ch;
      i++;
    }
  }
  if (quoted) throw new Error(`a quoted field that starts on line ${startLine} is never closed`);
  if (field !== "" || row.length) endRow();
  return out;
}

/** The delimiter of a CSV file: comma, semicolon (spreadsheets in many locales) or tab, by its header line. */
export function sniffDelimiter(text: string): string {
  const head = text.split(/\r?\n/)[0].replace(/"(?:[^"]|"")*"/g, "");
  const count = (c: string) => head.split(c).length - 1;
  return ["\t", ";", ","].reduce((best, c) => (count(c) > count(best) ? c : best), ",");
}

/** CSV text as a table: the first line names the columns. */
export function csvTable(text: string, source: string, delimiter?: string): Table {
  const lines = parseCsv(text, delimiter);
  if (!lines.length) throw new Error(`${source} is empty`);
  const columns = lines[0].map((c) => c.trim());
  const dup = columns.find((c, k) => c && columns.indexOf(c) !== k);
  if (dup) throw new Error(`${source}: two columns are named "${dup}"`);
  if (columns.some((c) => !c)) throw new Error(`${source}: column ${columns.findIndex((c) => !c) + 1} of the header line has no name`);
  const rows = lines.slice(1).map((cells, k) => {
    if (cells.length !== columns.length) throw new Error(`${source}: data row ${k + 1} has ${cells.length} fields; the header has ${columns.length}`);
    return Object.fromEntries(columns.map((c, j) => [c, cells[j]]));
  });
  return { columns, rows, source };
}

/** JSON rows: an array of objects (column -> value), or {rows: [...]}. Values must be text, numbers, true/false or null. */
export function jsonTable(raw: unknown, source: string): Table {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as any).rows) ? (raw as any).rows : null;
  if (!list) throw new Error(`${source}: expected an array of rows (objects), or {"rows": [...]}`);
  const columns: string[] = [];
  const rows = list.map((r: unknown, k: number) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error(`${source}: row ${k + 1} is not an object (column -> value)`);
    for (const [c, v] of Object.entries(r)) {
      if (v !== null && typeof v === "object") throw new Error(`${source}: row ${k + 1}, column "${c}" holds a list or object; use text, a number, true/false or null`);
      if (!columns.includes(c)) columns.push(c);
    }
    return r as Record<string, Cell>;
  });
  return { columns, rows, source };
}

/** The rows from a .csv / .tsv / .txt / .json file, or inline rows. */
export function loadTable(data: string | Record<string, unknown>[], opts: { delimiter?: string } = {}): Table {
  if (Array.isArray(data)) return jsonTable(data, "inline rows");
  const path = resolve(data);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e: any) {
    throw new Error(`Could not read the data file ${path}: ${e?.message ?? e}`);
  }
  const ext = extname(path).toLowerCase();
  let t: Table;
  if (ext === ".json") {
    let raw: unknown;
    try {
      raw = JSON.parse(text.replace(/^﻿/, ""));
    } catch (e: any) {
      throw new Error(`The data file ${path} is not valid JSON: ${e?.message ?? e}`);
    }
    t = jsonTable(raw, basename(path));
  } else {
    try {
      t = csvTable(text, basename(path), opts.delimiter ?? (ext === ".tsv" ? "\t" : undefined));
    } catch (e: any) {
      throw new Error(`The data file ${path} could not be read as CSV: ${e?.message ?? e}`);
    }
  }
  return { ...t, dir: dirname(path) };
}

/** "1-3,7" -> the 1-based row numbers it names, in the table's order. */
export function pickRows(spec: string | undefined, count: number): number[] {
  if (!spec || !spec.trim()) return Array.from({ length: count }, (_, k) => k + 1);
  const want = new Set<number>();
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) throw new Error(`rows: "${part}" is not a row number or range (e.g. "1-3,7")`);
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    if (a < 1 || b < a) throw new Error(`rows: "${part}" is not a valid range`);
    if (b > count) throw new Error(`rows: "${part}" goes past the last row (${count})`);
    for (let n = a; n <= b; n++) want.add(n);
  }
  return [...want].sort((x, y) => x - y);
}

// ---------- numbers ----------

export interface NumberFormat {
  decimals?: number;
  decimalSeparator?: string;
  thousandsSeparator?: string;
  prefix?: string;
  suffix?: string;
  /** how a negative number is written: "-" before the prefix (default), after the prefix, or in parentheses */
  negative?: "minus-before-prefix" | "minus-after-prefix" | "parentheses";
  /** write "+" before positive numbers */
  plusSign?: boolean;
}

/** A cell as a number. Text uses "." as the decimal separator unless the data's is "," (then "." and spaces group thousands). */
export function parseNumber(v: Cell, dataDecimal: "." | "," = "."): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.trim().replace(/[   ]/g, "");
  if (dataDecimal === ",") s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,(?=\d{3}(\D|$))/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  return Number(s);
}

/** Rounds half away from zero at `decimals` places, without binary surprises (1.005 -> 1.01). */
export function roundTo(n: number, decimals: number): number {
  const sign = n < 0 ? -1 : 1;
  return sign * Number(Math.round(Number(`${Math.abs(n)}e${decimals}`)) + `e-${decimals}`);
}

/** A number written in the user's format. Without decimals, as many as the number has. */
export function formatNumber(n: number, f: NumberFormat = {}): string {
  const neg = n < 0 || Object.is(n, -0);
  let abs = Math.abs(n);
  let digits: string;
  if (f.decimals !== undefined) {
    abs = roundTo(abs, f.decimals);
    digits = abs.toFixed(f.decimals);
  } else {
    // plain decimal notation, never 1e+21 style
    digits = abs.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
  }
  let [int, frac] = digits.split(".");
  if (f.thousandsSeparator) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, f.thousandsSeparator);
  const body = int + (frac !== undefined ? (f.decimalSeparator ?? ".") + frac : "");
  const isNeg = neg && Number(digits) !== 0;
  const pre = f.prefix ?? "", suf = f.suffix ?? "";
  if (!isNeg) return `${f.plusSign && abs > 0 ? "+" : ""}${pre}${body}${suf}`;
  switch (f.negative) {
    case "parentheses":
      return `(${pre}${body}${suf})`;
    case "minus-after-prefix":
      return `${pre}-${body}${suf}`;
    default:
      return `-${pre}${body}${suf}`;
  }
}

// ---------- colours ----------

/** "#rgb", "#rrggbb", "r,g,b" (0-255, or 0-1 when every part is at most 1) or [r,g,b] -> [r,g,b] in 0-1. */
export function parseColor(v: unknown): [number, number, number] | null {
  if (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => typeof x === "number" && Number.isFinite(x))) {
    const c = v.slice(0, 3) as number[];
    const big = c.some((x) => x > 1);
    const out = c.map((x) => (big ? x / 255 : x));
    return out.every((x) => x >= 0 && x <= 1) ? (out as [number, number, number]) : null;
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, "$&$&") : hex[1];
    return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16) / 255) as [number, number, number];
  }
  const parts = s.replace(/^\[|\]$/g, "").split(/\s*[,;\s]\s*/).filter(Boolean);
  if (parts.length === 3 && parts.every((p) => /^\d*\.?\d+$/.test(p))) return parseColor(parts.map(Number));
  return null;
}

export const hex = (c: number[]) => "#" + c.slice(0, 3).map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();

export interface ColorRule {
  op: "<" | "<=" | ">" | ">=" | "=" | "!=";
  value: number | string;
  color: string;
}

/** The first rule the cell matches (numbers compare as numbers, text as text), else `otherwise`, else null (leave as is). */
export function colorByRules(v: Cell, rules: ColorRule[], otherwise: string | undefined, dataDecimal: "." | "," = "."): { color: string; rule: string } | null {
  for (const r of rules) {
    let hit: boolean;
    if (typeof r.value === "number") {
      const n = parseNumber(v, dataDecimal);
      if (n === null) continue;
      hit = { "<": n < r.value, "<=": n <= r.value, ">": n > r.value, ">=": n >= r.value, "=": n === r.value, "!=": n !== r.value }[r.op];
    } else {
      const s = v === null ? "" : String(v).trim();
      if (r.op === "=") hit = s === r.value;
      else if (r.op === "!=") hit = s !== r.value;
      else continue; // < and > compare numbers only
    }
    if (hit) return { color: r.color, rule: `${r.op} ${typeof r.value === "number" ? r.value : JSON.stringify(r.value)}` };
  }
  return otherwise !== undefined ? { color: otherwise, rule: "otherwise" } : null;
}

// ---------- sizes ----------

/**
 * A value as pixels through the user's mapping (value, px) points, linear between them. Outside the mapped values
 * the line through the nearest two points goes on, and `outside` says so (the row fails: the data is out of range).
 */
export function mapToPx(v: number, points: [number, number][]): { px: number; outside: boolean } {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  let k = p.findIndex((q, j) => j > 0 && v <= q[0]);
  if (k < 0) k = p.length - 1;
  const [x0, y0] = p[k - 1], [x1, y1] = p[k];
  const px = x1 === x0 ? y1 : y0 + ((v - x0) * (y1 - y0)) / (x1 - x0);
  return { px, outside: v < p[0][0] || v > p[p.length - 1][0] };
}

// ---------- names and paths ----------

/** Characters no file name may have on Windows or macOS, replaced in values put into an output path. */
const UNSAFE_FILE = /[<>:"/\\|?*\u0000-\u001F]/g;

/**
 * A name or path from a pattern: {Column} is that row's cell, {#} the row number (1-based, in the data), {#3} the row
 * number padded to 3 digits, {comp} the template comp's name. `forPath` makes the values safe in a file name.
 */
export function fillPattern(pattern: string, row: Record<string, Cell>, n: number, template: string, columns: string[], forPath = false): string {
  return pattern.replace(/\{([^{}]+)\}/g, (_, key: string) => {
    let v: string;
    const pad = /^#(\d+)?$/.exec(key);
    if (pad) v = pad[1] ? String(n).padStart(Number(pad[1]), "0") : String(n);
    else if (key === "comp") v = template;
    else if (columns.includes(key)) v = row[key] === null || row[key] === undefined ? "" : String(row[key]);
    else throw new Error(`the pattern "${pattern}" names {${key}}, which is not a column (columns: ${columns.join(", ")}), {#} or {comp}`);
    return forPath ? v.replace(UNSAFE_FILE, "_").trim() : v;
  });
}

/** Columns a pattern names (for checking it before anything is built). */
export const patternColumns = (pattern: string) => [...pattern.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]).filter((k) => !/^#\d*$/.test(k) && k !== "comp");

/** A footage path from a cell: absolute as it is, relative to `base` (the footage folder, or the data file's folder). */
export function footagePath(v: Cell, base: string | undefined): string | null {
  const s = v === null || v === undefined ? "" : String(v).trim();
  if (!s) return null;
  const p = s.replace(/^~(?=[\\/]|$)/, process.env.HOME ?? process.env.USERPROFILE ?? "~");
  return isAbsolute(p) ? p : resolve(base ?? process.cwd(), p);
}

/** Whether an output path is taken: the file, or for an image sequence ("frame_[####].png") any file of the sequence. */
export function outputTaken(path: string): string | null {
  const seq = /\[#+\]/.exec(basename(path));
  if (!seq) return existsSync(path) ? path : null;
  const [head, tail] = basename(path).split(seq[0]);
  let names: string[];
  try {
    names = readdirSync(dirname(path));
  } catch {
    return null;
  }
  const hit = names.find((n) => n.startsWith(head) && n.endsWith(tail) && /^\d+$/.test(n.slice(head.length, n.length - tail.length)));
  return hit ? resolve(dirname(path), hit) : null;
}
