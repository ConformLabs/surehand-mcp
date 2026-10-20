// Localization round trip: the files translators get and send back, in TypeScript and unit-tested
// (test/localize.test.ts). CSV (UTF-8 with a BOM, so Excel opens Hebrew and Arabic correctly) and XLIFF 1.2 (the
// version CAT tools import most widely; 2.0 is read too). One string per text layer of the comp tree (per keyframe
// of keyframed Source Text), keyed by the comp's and the layer's After Effects ids, with its context: where it is,
// its time on screen, its box or the width it has, a character limit and notes.
//
// Line breaks: After Effects text uses \r between paragraphs and \u0003 for a line break inside a paragraph. In the
// files a paragraph break is a plain line break and a line break inside a paragraph is U+2028 (LINE SEPARATOR):
// \u0003 is not allowed in XML.
import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { csvTable, parseCsv } from "../versions/data.js";

/** One string to translate, as it is written to the files. */
export interface LUnit {
  /** "c12:L1003" (comp id, layer id), "c12:L1003:k2" for the second keyframe of keyframed Source Text */
  id: string;
  /** the comp path from the root: "Main > Lower third" */
  comp: string;
  layer: string;
  /** the master text (After Effects line breaks) */
  source: string;
  onScreen?: string;
  /** paragraph text: "800 × 200" (layer px) */
  box?: string;
  /** point text: the width it has (comp px), to the edge of the frame or the safe area */
  maxWidth?: number;
  maxChars?: number;
  /** what the translator should know about the place: hidden layer, keyframe, expression, used n times */
  context?: string;
  notes?: string;
}

/** A translated file, read back. */
export interface LFile {
  format: "csv" | "xliff";
  path: string;
  /** the root comp the file was exported from, when the file says (XLIFF original / the first comp column) */
  root?: string;
  sourceLanguage?: string;
  languages: string[];
  units: { id: string; comp?: string; layer?: string; source: string; targets: Record<string, string>; state?: Record<string, string> }[];
  /** what the reader noticed: columns that aren't languages, units without an id */
  notes: string[];
}

// ---------- text in files ----------

/** After Effects text -> file text. */
export const toFileText = (s: string) => s.replace(/\r\n|\r/g, "\n").replace(/\u0003/g, "\u2028");
/** File text -> After Effects text. */
export const fromFileText = (s: string) => s.replace(/\r\n|\n|\r/g, "\r").replace(/\u2028/g, "\u0003");
/** Two texts compare equal when they differ only in how line breaks are written, or in Unicode normalization. */
export const sameText = (a: string, b: string) => fromFileText(a).normalize("NFC") === fromFileText(b).normalize("NFC");

// ---------- languages ----------

export const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
const RTL_LANGS = new Set(["ar", "arc", "ckb", "dv", "fa", "he", "iw", "ji", "nqo", "prs", "ps", "sd", "syr", "ug", "ur", "yi"]);
const RTL_SCRIPTS = new Set(["arab", "hebr", "syrc", "thaa", "nkoo", "adlm", "rohg", "mand", "samr"]);
const LTR_SCRIPTS = new Set(["latn", "cyrl", "grek", "deva", "hans", "hant", "jpan", "kore", "thai"]);

/** Right to left by the language tag: its script subtag if it has one (sd-Deva is LTR), else the language. */
export function isRtl(lang: string): boolean {
  const parts = lang.toLowerCase().split(/[-_]/);
  const script = parts.slice(1).find((p) => p.length === 4);
  if (script && RTL_SCRIPTS.has(script)) return true;
  if (script && LTR_SCRIPTS.has(script)) return false;
  return RTL_LANGS.has(parts[0]);
}

// ---------- CSV ----------

export const CSV_FIXED = ["id", "comp", "layer", "source"] as const;
export const CSV_CONTEXT = ["on screen", "box (px)", "max width (px)", "max chars", "context", "notes"] as const;

function csvField(v: string | number | undefined, d: string): string {
  const s = v === undefined ? "" : String(v);
  return /["\r\n\u2028]|^\s|\s$/.test(s) || s.includes(d) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The CSV: a BOM, then id, comp, layer, source, one empty column per target language, then the context. CRLF lines. */
export function writeCsv(units: LUnit[], languages: string[], delimiter = ","): string {
  const head = [...CSV_FIXED, ...languages, ...CSV_CONTEXT];
  const rows = units.map((u) =>
    [u.id, u.comp, u.layer, toFileText(u.source), ...languages.map(() => ""), u.onScreen, u.box, u.maxWidth, u.maxChars, u.context, u.notes].map((v) => csvField(v, delimiter)).join(delimiter),
  );
  return "\uFEFF" + [head.map((h) => csvField(h, delimiter)).join(delimiter), ...rows].join("\r\n") + "\r\n";
}

/** Reads a file as UTF-8, or says how to save it as UTF-8 (Excel's plain "CSV" is not UTF-8 on Windows). */
export function readUtf8(path: string): string {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (e: any) {
    throw new Error(`Could not read ${path}: ${e?.message ?? e}`);
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new Error(
      `${basename(path)} is not UTF-8 text, so Hebrew, Arabic and other non-Latin letters would come in wrong. In Excel save it with ` +
        `File > Save As > "CSV UTF-8 (Comma delimited) (.csv)"; in Google Sheets File > Download > CSV is UTF-8 already.`,
    );
  }
}

export function readCsv(path: string, text: string, delimiter?: string): LFile {
  const t = csvTable(text, basename(path), delimiter);
  const lower = t.columns.map((c) => c.toLowerCase());
  for (const need of ["id", "source"]) if (!lower.includes(need)) throw new Error(`${basename(path)} has no "${need}" column (the columns of an exported file: ${[...CSV_FIXED, "<languages>", ...CSV_CONTEXT].join(", ")})`);
  const col = (name: string) => t.columns[lower.indexOf(name)];
  const known = new Set<string>([...CSV_FIXED, ...CSV_CONTEXT]);
  const notes: string[] = [];
  const languages = t.columns.filter((c) => {
    if (known.has(c.toLowerCase())) return false;
    if (LANG_RE.test(c)) return true;
    notes.push(`column "${c}" is not a language code (like he, ar, fr-CA): ignored`);
    return false;
  });
  const units: LFile["units"] = [];
  t.rows.forEach((r, k) => {
    const id = String(r[col("id")] ?? "").trim();
    if (!id) return void notes.push(`data row ${k + 1} has no id: ignored`);
    const targets: Record<string, string> = {};
    for (const l of languages) {
      const v = String(r[l] ?? "");
      if (v.trim() !== "") targets[l] = fromFileText(v);
    }
    units.push({ id, comp: lower.includes("comp") ? String(r[col("comp")] ?? "") : undefined, layer: lower.includes("layer") ? String(r[col("layer")] ?? "") : undefined, source: fromFileText(String(r[col("source")] ?? "")), targets });
  });
  const firstComp = units.find((u) => u.comp)?.comp;
  return { format: "csv", path, root: firstComp ? firstComp.split(" > ")[0] : undefined, languages, units, notes };
}

// ---------- XML ----------

const xmlEsc = (s: string, attr = false) => {
  // characters XML 1.0 doesn't allow (other control characters) are dropped
  const clean = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");
  const out = clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return attr ? out.replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;") : out;
};

/** XLIFF 1.2: one file per target language (target-language is one per <file>). */
export function writeXliff(units: LUnit[], o: { sourceLanguage: string; targetLanguage: string; root: string; toolVersion?: string }): string {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">',
    `  <file original="${xmlEsc(o.root, true)}" source-language="${xmlEsc(o.sourceLanguage, true)}" target-language="${xmlEsc(o.targetLanguage, true)}" datatype="plaintext">`,
    "    <header>",
    `      <tool tool-id="surehand-ae" tool-name="Surehand MCP for After Effects"${o.toolVersion ? ` tool-version="${xmlEsc(o.toolVersion, true)}"` : ""}/>`,
    "    </header>",
    "    <body>",
  ];
  for (const u of units) {
    const limit = u.maxChars !== undefined ? ` maxwidth="${u.maxChars}" size-unit="char"` : "";
    out.push(`      <trans-unit id="${xmlEsc(u.id, true)}" resname="${xmlEsc(`${u.comp} > ${u.layer}`, true)}"${limit} xml:space="preserve">`);
    out.push(`        <source xml:lang="${xmlEsc(o.sourceLanguage, true)}">${xmlEsc(toFileText(u.source))}</source>`);
    const ctx = [`${u.comp} > ${u.layer}`, u.onScreen && `on screen ${u.onScreen}`, u.box && `paragraph box ${u.box} px`, u.maxWidth !== undefined && `room for about ${u.maxWidth} px of width`, u.maxChars !== undefined && `at most ${u.maxChars} characters`, u.context]
      .filter(Boolean)
      .join(" · ");
    out.push(`        <note from="Surehand" priority="2">${xmlEsc(ctx)}</note>`);
    if (u.notes) out.push(`        <note from="author" priority="1">${xmlEsc(u.notes)}</note>`);
    out.push("      </trans-unit>");
  }
  out.push("    </body>", "  </file>", "</xliff>", "");
  return out.join("\n");
}

interface XNode {
  name: string;
  attrs: Record<string, string>;
  kids: (XNode | string)[];
}
const local = (n: string) => n.replace(/^.*:/, "");
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unent = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e] ?? m)));

/** A small XML reader (elements, attributes, text, CDATA, comments, entities): enough for XLIFF, no DTDs. */
export function parseXml(text: string): XNode {
  const root: XNode = { name: "#root", attrs: {}, kids: [] };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      top().kids.push(unent(text.slice(i)));
      break;
    }
    if (lt > i) top().kids.push(unent(text.slice(i, lt)));
    if (text.startsWith("<!--", lt)) {
      const e = text.indexOf("-->", lt);
      if (e < 0) throw new Error("an XML comment is never closed");
      i = e + 3;
    } else if (text.startsWith("<![CDATA[", lt)) {
      const e = text.indexOf("]]>", lt);
      if (e < 0) throw new Error("a CDATA section is never closed");
      top().kids.push(text.slice(lt + 9, e));
      i = e + 3;
    } else if (text.startsWith("<?", lt) || text.startsWith("<!", lt)) {
      const e = text.indexOf(">", lt);
      i = e < 0 ? text.length : e + 1;
    } else if (text[lt + 1] === "/") {
      const e = text.indexOf(">", lt);
      const name = text.slice(lt + 2, e).trim();
      if (stack.length < 2 || top().name !== name) throw new Error(`XML: </${name}> doesn't close <${top().name}>`);
      stack.pop();
      i = e + 1;
    } else {
      // a start tag: attribute values may hold ">"
      const m = /^<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(text.slice(lt, lt + 20000));
      if (!m) throw new Error(`XML: a broken tag near "${text.slice(lt, lt + 40)}"`);
      const node: XNode = { name: m[1], attrs: {}, kids: [] };
      for (const a of m[2].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[a[1]] = unent(a[2] ?? a[3] ?? "");
      top().kids.push(node);
      if (!m[3]) stack.push(node);
      i = lt + m[0].length;
    }
  }
  if (stack.length > 1) throw new Error(`XML: <${top().name}> is never closed`);
  return root;
}

const elems = (n: XNode, name: string): XNode[] => n.kids.filter((k): k is XNode => typeof k !== "string" && local(k.name) === name);
function* walk(n: XNode): Generator<XNode> {
  for (const k of n.kids)
    if (typeof k !== "string") {
      yield k;
      yield* walk(k);
    }
}
const attr = (n: XNode, name: string) => {
  for (const [k, v] of Object.entries(n.attrs)) if (local(k) === name) return v;
  return undefined;
};
/** The text of a source / target: inline markup kept as text, native-code placeholders dropped, line-break placeholders as line breaks. */
function textOf(n: XNode): string {
  let s = "";
  for (const k of n.kids) {
    if (typeof k === "string") s += k;
    else {
      const ln = local(k.name), ct = attr(k, "ctype") ?? attr(k, "type") ?? "";
      if ((ln === "x" || ln === "ph" || ln === "sc" || ln === "ec") && /lb|break/i.test(ct)) s += "\n";
      else if (ln === "g" || ln === "mrk" || ln === "pc") s += textOf(k);
      // bpt, ept, ph, it, sub, x: native codes or placeholders; our files have none
    }
  }
  return s;
}

export function readXliff(path: string, text: string): LFile {
  let doc: XNode;
  try {
    doc = parseXml(text.replace(/^\uFEFF/, ""));
  } catch (e: any) {
    throw new Error(`${basename(path)} is not valid XML: ${e?.message ?? e}`);
  }
  const x = elems(doc, "xliff")[0];
  if (!x) throw new Error(`${basename(path)} is not an XLIFF file (no <xliff> element)`);
  const v2 = /^2/.test(x.attrs.version ?? "");
  const units: LFile["units"] = [], languages = new Set<string>(), notes: string[] = [];
  let root: string | undefined, sourceLanguage: string | undefined;
  for (const f of elems(x, "file")) {
    const src = v2 ? x.attrs.srcLang : f.attrs["source-language"];
    const tgt = v2 ? x.attrs.trgLang : f.attrs["target-language"];
    sourceLanguage ??= src;
    root ??= f.attrs.original;
    if (tgt) languages.add(tgt);
    for (const u of walk(f)) {
      const ln = local(u.name);
      if (ln !== (v2 ? "unit" : "trans-unit")) continue;
      const id = u.attrs.id;
      if (!id) {
        notes.push("a unit without an id: ignored");
        continue;
      }
      let source = "", target: string | undefined, state: string | undefined;
      if (v2) {
        for (const seg of [...walk(u)].filter((k) => local(k.name) === "segment" || local(k.name) === "ignorable")) {
          source += textOf(elems(seg, "source")[0] ?? { name: "", attrs: {}, kids: [] });
          const t = elems(seg, "target")[0];
          if (t) target = (target ?? "") + textOf(t);
          state ??= seg.attrs.state;
        }
      } else {
        source = textOf(elems(u, "source")[0] ?? { name: "", attrs: {}, kids: [] });
        const t = elems(u, "target")[0];
        if (t) {
          // segmented targets (<mrk mtype="seg">) join back into one text
          target = textOf(t);
          state = t.attrs.state;
        }
      }
      const targets: Record<string, string> = {}, states: Record<string, string> = {};
      if (tgt && target !== undefined && target.trim() !== "") targets[tgt] = fromFileText(target);
      if (tgt && state) states[tgt] = state;
      const res = u.attrs.resname ?? u.attrs.name;
      const cut = res ? res.lastIndexOf(" > ") : -1;
      units.push({ id, comp: cut > 0 ? res!.slice(0, cut) : undefined, layer: cut > 0 ? res!.slice(cut + 3) : undefined, source: fromFileText(source), targets, state: states });
    }
  }
  if (!units.length) notes.push("no translation units in the file");
  return { format: "xliff", path, root, sourceLanguage, languages: [...languages], units, notes };
}

/** A translated file (or several XLIFF files, one per language) as one list of units with their targets. */
export function readTranslations(files: string[], csvDelimiter?: string): LFile {
  const read = files.map((f) => {
    const path = resolve(f), ext = extname(path).toLowerCase(), text = readUtf8(path);
    if (ext === ".csv" || ext === ".tsv" || ext === ".txt") return readCsv(path, text, csvDelimiter ?? (ext === ".tsv" ? "\t" : undefined));
    if (ext === ".xlf" || ext === ".xliff" || ext === ".xml" || /^\s*(<\?xml|<xliff)/.test(text.replace(/^\uFEFF/, ""))) return readXliff(path, text);
    throw new Error(`${basename(path)}: give a .csv or an .xlf / .xliff file`);
  });
  if (read.length === 1) return read[0];
  const merged: LFile = { format: read[0].format, path: read.map((r) => r.path).join(", "), root: read.find((r) => r.root)?.root, sourceLanguage: read.find((r) => r.sourceLanguage)?.sourceLanguage, languages: [], units: [], notes: [] };
  const byId = new Map<string, LFile["units"][number]>();
  for (const r of read) {
    merged.notes.push(...r.notes.map((n) => `${basename(r.path)}: ${n}`));
    for (const l of r.languages) if (!merged.languages.includes(l)) merged.languages.push(l);
    for (const u of r.units) {
      const have = byId.get(u.id);
      if (!have) {
        const copy = { ...u, targets: { ...u.targets }, state: { ...u.state } };
        byId.set(u.id, copy);
        merged.units.push(copy);
      } else {
        if (!sameText(have.source, u.source)) merged.notes.push(`${u.id}: the source differs between files (${basename(r.path)} has ${JSON.stringify(toFileText(u.source))})`);
        Object.assign(have.targets, u.targets);
        Object.assign(have.state!, u.state);
      }
    }
  }
  return merged;
}

/** A path with {lang} filled in. */
export const langPath = (pattern: string, lang: string) => pattern.replace(/\{lang\}/g, lang);

/** Splits a CSV quickly into lines (for tests and the dry run): the parsed rows. */
export const csvRows = (text: string) => parseCsv(text.replace(/^\uFEFF/, ""));
