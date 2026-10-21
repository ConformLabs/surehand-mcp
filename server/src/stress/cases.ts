// ae_stress_test: the worst-case inputs. Test data, not looks: realistic strings and numbers that break templates in
// an editor's or client's hands (a long German compound, Arabic that must join and run right to left, CJK and Thai
// that the font may not cover, an empty field, a price with seven digits, an emoji). Every case has a stable id
// (what the report and the view name it by). Text cases scale from the target's current text, so a two-word title
// is tested with a German title of its own size, not a paragraph. Unit-tested in test/stress.test.ts.

export type TargetKind = "text" | "number" | "checkbox" | "dropdown" | "color" | "media";
export type Cell = string | number | boolean | null;

/** A variable the comp exposes (an Essential Graphics controller, a data-driven or named text layer). */
export interface Target {
  /** unique within a run: the controller's or layer's name ("Title"); "#3" where the name repeats */
  id: string;
  name: string;
  kind: TargetKind;
  source: "egp" | "layer" | "data";
  /** the layer of the comp the value lands on (1-based), when known */
  layer?: number;
  layerName?: string;
  /** property path in match names from the layer ([] = the layer itself: media) */
  path?: string[];
  /** the value now (text: the string) */
  current?: Cell | number[];
  /** dropdown: how many items the menu has (probed on a scratch copy) */
  items?: number;
  /** the text layer is paragraph (box) text */
  box?: boolean;
  /** the user's own number format for the text that shows this number (versions' NumberFormat) */
  numberFormat?: import("../versions/data.js").NumberFormat;
  /** the user's max width for point text, comp px, and most lines */
  maxWidthPx?: number;
  maxLines?: number;
  /** why the target can't be tested (it is still listed) */
  problem?: string;
}

/** One case of a generated set. */
export interface Case {
  id: string;
  label: string;
  /** "text", "rtl", "cjk", "complex", "number", "edge" ... (the `sets` filter) */
  group: string;
  value: Cell | number[];
  /** what it tests, in a few words (the view's sub-line) */
  detail: string;
}

/** One variant: one or more targets set to an input. */
export interface Variant {
  id: string;
  name: string;
  /** generated (one target), together (one case on every target), own (the user's values), data (a row), combination */
  set: "generated" | "together" | "own" | "data" | "combination";
  caseId?: string;
  group?: string;
  sets: { target: string; value: Cell | number[]; detail?: string }[];
}

// ---------- text ----------

// real words, longest first: German and Finnish compounds an editor really gets from a translator
const DE = ["Rechtsschutzversicherungsgesellschaften", "Geschwindigkeitsbegrenzung", "Kundenzufriedenheitsumfrage", "Sonderangebot", "Jahresabschluss", "Veranstaltung", "für", "alle", "Mitglieder", "und", "Gäste"];
const FI = ["Työterveyshuoltopalveluiden", "järjestelmäasiantuntijoille", "Kansaneläkelaitoksen", "erikoistarjous", "asiakastyytyväisyyskysely", "kaikille", "jäsenille", "ja", "vieraille"];

/** Words joined until the text is at least `len` characters (the first word always). */
export function fill(words: string[], len: number): string {
  let out = words[0];
  for (let k = 1; out.length < len; k++) out += " " + words[k % words.length];
  return out;
}

/** The target's text grown to `len` characters with its own words (scaling from the current text). */
export function grow(text: string, len: number): string {
  const words = text.replace(/[\r\n\u0003]+/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return fill(DE.slice(3), len);
  let out = words.join(" ");
  for (let k = 0; out.length < len; k++) out += " " + words[k % words.length];
  return out;
}

/** Upper case as an editor's caps lock gives it (ß stays ß in AE's own caps; the string is what was typed). */
const upper = (s: string) => s.toLocaleUpperCase("de-DE");

/**
 * The generated text cases for a text target whose current text is `current`. Lengths scale from it: German about
 * 1.4x, Finnish 1.5x, "2x" twice, never shorter than the longest compound (a one-word title still gets a compound).
 */
export function textCases(current: string): Case[] {
  const base = Array.from(current.replace(/[\r\n\u0003]/g, "")).length || 12;
  const de = fill(DE, Math.max(Math.round(base * 1.4), DE[0].length));
  const fi = fill(FI, Math.max(Math.round(base * 1.5), FI[0].length));
  const noSpace = (s: string, len: number) => {
    let out = s;
    while (out.length < len) out += s.slice(out.length % s.length);
    return out;
  };
  const url = noSpace("https://www.example.com/campaign/2026/spring-collection-launch-event", Math.max(Math.round(base * 1.5), 40));
  return [
    { id: "de-long", label: "German long", group: "length", value: de, detail: `${de.length} chars, compounds` },
    { id: "fi-long", label: "Finnish long", group: "length", value: fi, detail: `${fi.length} chars, compounds` },
    { id: "double", label: "Twice as long", group: "length", value: grow(current, base * 2), detail: `the current text grown to ${base * 2} chars` },
    { id: "no-spaces", label: "No spaces", group: "length", value: url, detail: `${url.length} chars, a URL with no break point` },
    { id: "caps", label: "All caps", group: "edge", value: upper(current.trim() ? current : "Überraschung für Österreich") + " ÄÖÜ ÉÑ", detail: "the current text in capitals, accented capitals" },
    { id: "he-rtl", label: "Hebrew + numbers", group: "rtl", value: "מבצע מיוחד: 50% הנחה עד 31.12.2026", detail: "right to left, mixed with numbers" },
    { id: "ar-rtl", label: "Arabic + numbers", group: "rtl", value: "عرض خاص: خصم 50% حتى 31.12.2026", detail: "right to left, joined letters, numbers" },
    { id: "ar-mixed", label: "Arabic + Latin", group: "rtl", value: "مهرجان After Effects للتصميم 2026", detail: "right to left with a Latin name inside" },
    { id: "ja", label: "Japanese", group: "cjk", value: "東京都千代田区で特別キャンペーン開催中", detail: "kanji and kana, no spaces" },
    { id: "zh", label: "Chinese", group: "cjk", value: "限时特惠活动现已全面开始", detail: "simplified Chinese, no spaces" },
    { id: "ko", label: "Korean", group: "cjk", value: "특별 할인 행사가 진행 중입니다", detail: "Hangul" },
    { id: "th", label: "Thai", group: "complex", value: "โปรโมชั่นพิเศษลดราคาสินค้าทั้งหมด", detail: "complex shaping, no spaces between words" },
    { id: "hi", label: "Hindi", group: "complex", value: "सभी उत्पादों पर विशेष छूट", detail: "Devanagari conjuncts and vowel signs" },
    { id: "vi-combining", label: "Combining marks", group: "complex", value: "Chương trình khuyến mãi đặc biệt".normalize("NFD"), detail: "Vietnamese with combining diacritics (NFD)" },
    { id: "emoji", label: "Emoji", group: "edge", value: "Sale 🔥🎉 50% off ❤️ 👍🏽 👨‍👩‍👧", detail: "emoji, skin tone, ZWJ sequence" },
    { id: "empty", label: "Empty", group: "edge", value: "", detail: "an empty field" },
    { id: "one-char", label: "One character", group: "edge", value: "W", detail: "a single wide letter" },
    { id: "three-lines", label: "Three lines", group: "edge", value: [current.trim() || "Line", current.trim() || "Line", current.trim() || "Line"].join("\r"), detail: "line breaks in the data" },
  ];
}

/** Number cases typed into a text field that shows a number: both separator styles, signs, percent, decimals. */
export const NUMBER_TEXT_CASES: Case[] = [
  { id: "n-zero", label: "Zero", group: "number", value: "0", detail: '"0"' },
  { id: "n-negative", label: "Negative", group: "number", value: "-1,234.50", detail: '"-1,234.50"' },
  { id: "n-huge", label: "Huge", group: "number", value: "1,234,567.89", detail: '"1,234,567.89"' },
  { id: "n-eu", label: "European separators", group: "number", value: "1.234.567,89", detail: '"1.234.567,89"' },
  { id: "n-decimals", label: "Many decimals", group: "number", value: "3.14159265", detail: '"3.14159265"' },
  { id: "n-percent", label: "Percent", group: "number", value: "100%", detail: '"100%"' },
];

/** Number cases set on a number control (a slider): sign, size, precision, AE's own slider limits. */
export const NUMBER_CASES: Case[] = [
  { id: "n-zero", label: "Zero", group: "number", value: 0, detail: "0" },
  { id: "n-negative", label: "Negative", group: "number", value: -1234.5, detail: "-1234.5" },
  { id: "n-huge", label: "Huge", group: "number", value: 1234567.89, detail: "1234567.89" },
  { id: "n-limit", label: "Past the slider limit", group: "number", value: 9999999999, detail: "9999999999 (sliders stop at ±1,000,000)" },
  { id: "n-decimals", label: "Many decimals", group: "number", value: 3.14159265, detail: "3.14159265" },
  { id: "n-tiny", label: "Tiny", group: "number", value: 0.000001, detail: "0.000001" },
  { id: "n-percent", label: "Over 100 percent", group: "number", value: 150, detail: "150 (a percentage over 100)" },
];

/** A text that is a number (a price, a score): its digits parse as one. */
export function looksNumeric(s: string): boolean {
  const t = s.trim();
  return /\d/.test(t) && /^[^\p{L}]*[-+−(]?[^\p{L}\d]{0,3}\d[\d.,\s'’]*%?[^\p{L}]{0,3}$/u.test(t) && t.length <= 24;
}

/** The generated cases for a target, by its kind. Dropdowns: every item; checkboxes: both states. */
export function casesFor(t: Target): Case[] {
  switch (t.kind) {
    case "text": {
      const cur = typeof t.current === "string" ? t.current : "";
      return [...textCases(cur), ...(looksNumeric(cur) ? NUMBER_TEXT_CASES : [])];
    }
    case "number":
      return NUMBER_CASES;
    case "checkbox":
      return [
        { id: "on", label: "On", group: "state", value: 1, detail: "checkbox on" },
        { id: "off", label: "Off", group: "state", value: 0, detail: "checkbox off" },
      ];
    case "dropdown": {
      const n = Math.max(1, Math.min(t.items ?? 1, 30));
      return Array.from({ length: n }, (_, k) => ({ id: `item-${k + 1}`, label: `Item ${k + 1}`, group: "state", value: k + 1, detail: `menu item ${k + 1} of ${n}` }));
    }
    case "color":
      return [
        { id: "black", label: "Black", group: "color", value: [0, 0, 0], detail: "#000000" },
        { id: "white", label: "White", group: "color", value: [1, 1, 1], detail: "#FFFFFF" },
      ];
    case "media":
      return [
        { id: "media-wide", label: "Very wide media", group: "media", value: "wide", detail: "a 4:1 picture" },
        { id: "media-tall", label: "Very tall media", group: "media", value: "tall", detail: "a 1:4 picture" },
        { id: "media-small", label: "Small media", group: "media", value: "small", detail: "a 64 x 64 picture" },
      ];
  }
}

// ---------- the variants of a run ----------

export interface PlanOptions {
  /** only cases whose id or group is listed */
  sets?: string[];
  exclude?: string[];
  /** single (default): one target at a time; together: also every text target with the same case; all: combinations */
  combinations?: "single" | "together" | "all";
  maxVariants: number;
  own?: { target: string; values: (Cell | number[])[] }[];
  rows?: { n: number; cells: { target: string; value: Cell }[] }[];
}

export interface Plan {
  variants: Variant[];
  /** what was left out by the cap, and how the kept ones were picked */
  sampled?: { total: number; kept: number; how: string };
}

const wanted = (c: Case, o: PlanOptions) =>
  (!o.sets?.length || o.sets.includes(c.id) || o.sets.includes(c.group)) && !(o.exclude ?? []).some((x) => x === c.id || x === c.group);

/** Every `step`-th of `n` indexes, evenly spread and deterministic (same input, same sample). */
export function spread(n: number, keep: number): number[] {
  if (keep >= n) return Array.from({ length: n }, (_, i) => i);
  if (keep <= 0) return [];
  if (keep === 1) return [0];
  return Array.from({ length: keep }, (_, i) => Math.round((i * (n - 1)) / (keep - 1)));
}

/**
 * The variants: the user's data rows and own values first (they are real), then the generated cases per target, the
 * "together" cases, and with "all" the combinations. Over the cap, generated variants are sampled evenly per target
 * (every target keeps cases) and combinations evenly over the product; the plan says what was kept.
 */
export function planVariants(targets: Target[], o: PlanOptions): Plan {
  const live = targets.filter((t) => !t.problem);
  const real: Variant[] = [];
  for (const r of o.rows ?? [])
    real.push({ id: `row-${r.n}`, name: `Row ${r.n}`, set: "data", sets: r.cells.map((c) => ({ target: c.target, value: c.value })) });
  for (const own of o.own ?? [])
    own.values.forEach((v, k) => real.push({ id: `own-${k + 1}@${own.target}`, name: `${own.target}: value ${k + 1}`, set: "own", sets: [{ target: own.target, value: v }] }));

  const perTarget = live.map((t) => casesFor(t).filter((c) => wanted(c, o)).map((c): Variant => ({
    id: `${c.id}@${t.id}`,
    name: `${c.label}`,
    set: "generated",
    caseId: c.id,
    group: c.group,
    sets: [{ target: t.id, value: c.value, detail: c.detail }],
  })));
  const generated = perTarget.flat();

  const together: Variant[] = [];
  const texts = live.filter((t) => t.kind === "text");
  if ((o.combinations === "together" || o.combinations === "all") && texts.length > 1) {
    for (const c of textCases("")) {
      if (!wanted(c, o)) continue;
      // each target with its own scaled version of the case
      const sets = texts.map((t) => {
        const own = casesFor(t).find((x) => x.id === c.id)!;
        return { target: t.id, value: own.value, detail: own.detail };
      });
      together.push({ id: `${c.id}@all`, name: `${c.label} (every text)`, set: "together", caseId: c.id, group: c.group, sets });
    }
  }

  let combos: Variant[] = [];
  let total = 0;
  const notes: string[] = [];
  if (o.combinations === "all" && perTarget.filter((p) => p.length).length > 1) {
    const lists = perTarget.filter((p) => p.length);
    total = lists.reduce((n, l) => n * l.length, 1);
    const room = Math.max(0, o.maxVariants - real.length - generated.length - together.length);
    const pick = spread(total, Math.min(total, room));
    combos = pick.map((idx) => {
      const sets: Variant["sets"] = [], ids: string[] = [];
      let rest = idx;
      for (const l of lists) {
        const v = l[rest % l.length];
        rest = Math.floor(rest / l.length);
        sets.push(...v.sets);
        ids.push(v.id);
      }
      return { id: ids.join("+"), name: `Combination ${idx + 1}`, set: "combination", sets };
    });
    if (combos.length < total) notes.push(`${combos.length} of ${total.toLocaleString("en-US")} combinations, evenly spread over all of them`);
  }

  // the cap: real data first, then generated evenly per target, then together, then combinations
  const all = [...real, ...generated, ...together, ...combos];
  if (all.length <= o.maxVariants) return { variants: all, ...(notes.length ? { sampled: { total: all.length - combos.length + total, kept: all.length, how: notes.join("; ") } } : {}) };
  let room = o.maxVariants;
  const keptReal = real.slice(0, room);
  room -= keptReal.length;
  const keptGen: Variant[] = [];
  // round robin over the targets, each target's cases evenly spread
  const per = perTarget.map((l) => ({ l, idx: spread(l.length, l.length) }));
  const share = per.length ? Math.floor(room / per.length) : 0;
  let extra = per.length ? room - share * per.length : 0;
  for (const p of per) {
    const want = Math.min(p.l.length, share + (extra > 0 && p.l.length > share ? (extra--, 1) : 0));
    keptGen.push(...spread(p.l.length, want).map((i) => p.l[i]));
  }
  room -= keptGen.length;
  const keptTogether = together.slice(0, Math.max(0, room));
  room -= keptTogether.length;
  const keptCombos = combos.slice(0, Math.max(0, room));
  const kept = [...keptReal, ...keptGen, ...keptTogether, ...keptCombos];
  const how = [
    keptReal.length < real.length && `${keptReal.length} of ${real.length} of your values`,
    keptGen.length < generated.length && `${keptGen.length} of ${generated.length} generated cases, evenly spread per control`,
    keptTogether.length < together.length && `${keptTogether.length} of ${together.length} cases on every text at once`,
    combos.length || total ? `${keptCombos.length} of ${total.toLocaleString("en-US")} combinations, evenly spread` : null,
  ].filter(Boolean).join("; ");
  return { variants: kept, sampled: { total: real.length + generated.length + together.length + (total || combos.length), kept: kept.length, how } };
}

// ---------- frames ----------

/**
 * The frames every variant is measured at: the animation's key frames, where each text layer starts and stops being
 * visible, and the comp's first and last frame; over `max`, the visibility edges stay and the rest are spread evenly.
 */
export function pickFrames(o: { frames: number; keys: number[]; edges: number[]; max: number }): number[] {
  const last = Math.max(0, o.frames - 1);
  const clamp = (f: number) => Math.max(0, Math.min(last, Math.round(f)));
  const edges = [...new Set([0, last, ...o.edges.map(clamp)])].sort((a, b) => a - b);
  const keys = [...new Set(o.keys.map(clamp))].filter((f) => !edges.includes(f)).sort((a, b) => a - b);
  if (edges.length >= o.max) return spread(edges.length, o.max).map((i) => edges[i]);
  const room = o.max - edges.length;
  const out = [...edges, ...spread(keys.length, room).map((i) => keys[i])];
  // nothing animates: the middle too
  if (!keys.length && last > 1 && out.length < o.max) out.push(Math.round(last / 2));
  return [...new Set(out)].sort((a, b) => a - b);
}
