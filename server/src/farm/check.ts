// The node check: does this machine have what a manifest says the render needs? Works from the disk alone (no After
// Effects: `surehand-ae farm check <manifest.json>`): After Effects and aerender installed, the project, footage, proxies,
// OCIO config and output folders reachable (through a path map when the node mounts the share elsewhere), fonts in the
// font folders, third-party plug-ins in the Plug-ins folders. With After Effects running (the ae_farm tool), its own
// lists of effects and fonts count too.
import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fontFolders, indexFonts } from "./fonts.js";
import type { Manifest } from "./manifest.js";
import { aerenderNextTo, cmpVersion, findAeInstalls, majorOf, mapPath, readAeInstall, type AeInstall, type PathMapping, type Platform } from "./paths.js";
import { findMatchNames, pluginFolders } from "./plugins.js";
import { listFrames, patternOfFrame, runsOf, runsText } from "./seq.js";

export type CheckStatus = "ok" | "missing" | "different" | "warning" | "not checked";
export interface CheckLine { area: string; what: string; status: CheckStatus; detail: string }
export interface CheckResult {
  verdict: string;
  line: string;
  lines: CheckLine[];
  machine: { platform: Platform; afterEffects: string | null; aerender: string | null };
  notes: string[];
}

export interface CheckOptions {
  platform: Platform;
  home: string;
  /** an After Effects install folder to use (default: the one matching the manifest's version) */
  aeFolder?: string;
  pathMap?: PathMapping[];
  fontFolders?: string[];
  pluginFolders?: string[];
  /** what this machine's running After Effects says (ae_farm, not the command line) */
  live?: { version?: string; app?: string; effects: Record<string, { n: string; v?: string } | null>; fonts: Record<string, boolean> | null } | null;
  pluginBudgetMs?: number;
  /** also the system and user font folders (default true; tests turn it off) */
  systemFonts?: boolean;
  /** test seam: the installs found on disk */
  installs?: AeInstall[];
}

const BLOCKING: CheckStatus[] = ["missing", "different"];

export function checkManifest(m: Manifest, o: CheckOptions): CheckResult {
  const lines: CheckLine[] = [], notes: string[] = [];
  const add = (area: string, what: string, status: CheckStatus, detail: string) => lines.push({ area, what, status, detail });
  const map = (p: string) => mapPath(p, o.pathMap);
  const mapped = (p: string) => (map(p) !== p ? ` (as ${map(p)})` : "");

  // After Effects and aerender
  const want = m.afterEffects.version, wantMajor = m.afterEffects.major;
  const installs = o.installs ?? (o.aeFolder ? [readAeInstall(o.aeFolder, o.platform)] : findAeInstalls(o.platform));
  let ae: AeInstall | undefined;
  if (o.live?.app) ae = { folder: o.platform === "windows" ? o.live.app : dirname(o.live.app), version: o.live.version ?? null, aerender: aerenderNextTo(o.live.app, o.platform) };
  ae ??= installs.find((i) => wantMajor !== null && majorOf(i.version) === wantMajor) ?? installs[0];
  const haveVersion = o.live?.version ?? ae?.version ?? null;
  if (!ae && !o.live) add("After Effects", "install", "missing", `no After Effects found${o.aeFolder ? ` in ${o.aeFolder}` : " in the default install folder"} (pass the install folder)`);
  else if (!haveVersion) add("After Effects", "version", "not checked", `the version of ${ae?.folder ?? "After Effects"} can't be read from disk`);
  else if (!want) add("After Effects", "version", "not checked", `the manifest has no After Effects version; here: ${haveVersion}`);
  else {
    const hm = majorOf(haveVersion);
    if (wantMajor !== null && hm < wantMajor) add("After Effects", "version", "different", `${haveVersion} here, the project was saved in ${want}: an older After Effects can't open it`);
    else if (wantMajor !== null && hm > wantMajor) add("After Effects", "version", "warning", `${haveVersion} here, the project was saved in ${want}: a newer version converts the project and can render differently`);
    else if (cmpVersion(haveVersion, want) !== 0) add("After Effects", "version", "warning", `${haveVersion} here, ${want} where the manifest was made (same major version; renders can still differ)`);
    else add("After Effects", "version", "ok", haveVersion);
  }
  if (installs.length > 1 && !o.live) notes.push(`After Effects installs found: ${installs.map((i) => `${i.version ?? "?"} (${i.folder})`).join(", ")}; checked ${ae?.folder}`);
  if (ae) add("aerender", "aerender", ae.aerender ? "ok" : "missing", ae.aerender ?? `not found in ${ae.folder}`);

  // expressions engine and colour
  if (m.project.expressionEngine && /javascript/i.test(m.project.expressionEngine) && haveVersion && majorOf(haveVersion) < 16)
    add("project", "expressions engine", "different", `the JavaScript expressions engine needs After Effects 16.0 or later (${haveVersion} here)`);
  if (m.color.ocioConfig) {
    const p = m.color.ocioConfig.path;
    add("colour", "OCIO config", existsSync(map(p)) ? "ok" : "missing", `${p}${mapped(p)}`);
  }

  // the project and its files
  if (m.project.file) add("files", "project", existsSync(map(m.project.file)) ? "ok" : "missing", `${m.project.file}${mapped(m.project.file)}`);
  for (const f of m.footage) {
    if (!f.path || f.kind === "solid" || f.kind === "placeholder") continue;
    const p = map(f.path);
    const label = `footage "${f.name}"`;
    if (!f.rendered) {
      if (!existsSync(p)) add("files", label, "warning", `${f.path}${mapped(f.path)} is not here (only on layers that are off)`);
      continue;
    }
    if (f.sequence) {
      const pat = patternOfFrame(p);
      const nums = pat ? listFrames(pat).map((x) => x.num).filter((n) => n >= f.sequence!.first && n <= f.sequence!.last) : [];
      const want2 = new Set<number>();
      for (let n = f.sequence.first; n <= f.sequence.last; n++) want2.add(n);
      for (const [a, b] of f.sequence.gaps) for (let n = a; n <= b; n++) want2.delete(n);
      const have = new Set(nums), lost = [...want2].filter((n) => !have.has(n));
      if (!nums.length) add("files", label, "missing", `${f.sequence.pattern}${mapped(f.path)}: no frames here`);
      else if (lost.length) add("files", label, "different", `${lost.length} of ${want2.size} frames are not here: ${runsText(runsOf(lost), 6)}`);
      else add("files", label, "ok", `${want2.size} frames`);
    } else add("files", label, existsSync(p) ? "ok" : "missing", `${f.path}${mapped(f.path)}`);
    if (f.proxy?.needed) add("files", `proxy of "${f.name}"`, existsSync(map(f.proxy.path)) ? "ok" : "missing", `${f.proxy.path}${mapped(f.proxy.path)}`);
  }
  for (const it of m.items)
    for (const out of it.outputs) {
      if (!out.folder) continue;
      const d = map(out.folder);
      let st: CheckStatus = "ok", why = d;
      if (!existsSync(d)) (st = "warning"), (why = `${out.folder}${mapped(out.folder)} doesn't exist here`);
      else
        try {
          accessSync(d, constants.W_OK);
        } catch {
          (st = "missing"), (why = `${out.folder}${mapped(out.folder)} can't be written from here`);
        }
      add("output", `render queue item ${it.rqIndex}, output ${out.index}`, st, why);
    }

  // fonts
  const fonts = m.fonts.filter((f) => f.rendered);
  if (fonts.length) {
    const live = o.live?.fonts ?? null;
    const idx = indexFonts([...(o.fontFolders ?? []), ...(o.systemFonts === false ? [] : fontFolders(o.platform, o.home))]);
    for (const f of fonts) {
      const file = idx.byName.get(f.postScriptName);
      if (file) add("fonts", f.postScriptName, "ok", file);
      else if (live?.[f.postScriptName]) add("fonts", f.postScriptName, "ok", "After Effects lists it");
      else add("fonts", f.postScriptName, "missing", `not in the font folders${live ? " and not in After Effects' fonts" : ""}${f.adobeFonts ? " (Adobe Fonts: activate it in Creative Cloud on this machine)" : ""}`);
    }
    if (idx.unreadable) notes.push(`${idx.unreadable} of ${idx.files} font files could not be read for their PostScript name (e.g. .dfont suitcases)`);
  }

  // plug-ins: third-party ones in the Plug-ins folders (or in After Effects' own list); Adobe's are part of After Effects
  const third = m.plugins.filter((p) => p.vendor === "third party" && p.rendered);
  const adobe = m.plugins.filter((p) => p.vendor === "Adobe" && p.rendered);
  if (adobe.length) {
    if (o.live) {
      const gone = adobe.filter((p) => o.live!.effects[p.matchName] === null);
      for (const p of gone) add("plug-ins", p.matchName, "missing", `${p.displayName}: not in this After Effects`);
      if (!gone.length) add("plug-ins", `${adobe.length} Adobe effects`, "ok", "in this After Effects");
    } else add("plug-ins", `${adobe.length} Adobe effects`, "ok", "part of After Effects (not checked one by one without After Effects)");
  }
  if (third.length) {
    const liveFx = o.live?.effects ?? null;
    const rest = third.filter((p) => !liveFx?.[p.matchName]);
    const search = rest.length ? findMatchNames(o.pluginFolders ?? pluginFolders(o.platform, ae?.folder ?? null), rest.map((p) => p.matchName), { budgetMs: o.pluginBudgetMs }) : null;
    for (const p of third) {
      const l = liveFx?.[p.matchName];
      if (l) {
        const v = l.v ?? null;
        add("plug-ins", p.matchName, p.version && v && p.version !== v ? "different" : "ok", `${l.n}${v ? ` ${v}` : ""}${p.version && v && p.version !== v ? ` here, ${p.version} in the manifest` : ""}`);
      } else {
        const hit = search?.found.get(p.matchName);
        if (hit) add("plug-ins", p.matchName, "ok", `${p.displayName}: in ${hit}${p.version ? ` (version not checked from disk; the manifest has ${p.version})` : ""}`);
        else if (search?.stopped) add("plug-ins", p.matchName, "not checked", `${p.displayName}: ${search.stopped}`);
        else add("plug-ins", p.matchName, "missing", `${p.displayName}: not found in ${search?.folders.join(", ")}`);
      }
    }
    if (search) notes.push(`plug-ins: searched ${search.files} files (${Math.round(search.bytes / 1e6)} MB) for the match names${search.skipped.length ? `; ${search.skipped.length} files over the size limit were skipped` : ""}`);
  }
  if (m.fonts.some((f) => f.here === "unknown")) notes.push("the manifest's machine could not list missing fonts (After Effects before 24.0)");

  const fails = lines.filter((l) => BLOCKING.includes(l.status)).length;
  const warns = lines.filter((l) => l.status === "warning").length;
  const notChecked = lines.filter((l) => l.status === "not checked");
  const verdict = fails ? `FAIL (${fails})` : notChecked.length ? `INCOMPLETE (${notChecked.length} not checked)` : warns ? `WARNINGS (${warns})` : "PASS";
  const line = fails
    ? `${verdict}: this machine is missing or has different ${[...new Set(lines.filter((l) => BLOCKING.includes(l.status)).map((l) => l.area))].join(", ")}.`
    : notChecked.length
      ? `${verdict}: nothing missing so far, but ${notChecked.map((l) => l.what).join(", ")} could not be checked.`
      : warns
        ? `${verdict}: everything the render needs is here; see the warnings.`
        : "PASS: everything the render needs is here.";
  return { verdict, line, lines, machine: { platform: o.platform, afterEffects: haveVersion, aerender: ae?.aerender ?? null }, notes };
}

const MARK: Record<CheckStatus, string> = { ok: "ok", missing: "MISSING", different: "DIFFERENT", warning: "warning", "not checked": "not checked" };
export function formatCheck(r: CheckResult, m: Manifest, source: string): string {
  const out = [r.line, `Manifest: ${source} (made ${m.createdAt} on ${m.machine.host}, After Effects ${m.afterEffects.version ?? "?"}).`, `This machine: ${r.machine.platform === "windows" ? "Windows" : "macOS"}, After Effects ${r.machine.afterEffects ?? "not found"}, aerender ${r.machine.aerender ?? "not found"}.`, ""];
  const order = ["missing", "different", "warning", "not checked", "ok"];
  for (const l of [...r.lines].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))) out.push(`  [${MARK[l.status]}] ${l.area}: ${l.what}${l.detail && l.detail !== l.what ? ` - ${l.detail}` : ""}`);
  if (r.notes.length) out.push("", "Notes:", ...r.notes.map((n) => `  - ${n}`));
  return out.join("\n") + "\n";
}
