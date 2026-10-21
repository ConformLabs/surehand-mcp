// `surehand-ae farm check <manifest.json>`: the check a render node runs before it renders, without After Effects:
// After Effects and aerender installed, the project, footage, proxies, OCIO config and output folders reachable, fonts in
// the font folders, third-party plug-ins in the Plug-ins folders. Exit code 0: nothing missing (PASS or WARNINGS);
// 1: something missing or different (FAIL); 3: parts could not be checked (INCOMPLETE); 2: usage or an unreadable manifest.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { checkManifest, formatCheck } from "../farm/check.js";
import type { Manifest } from "../farm/manifest.js";
import { platformOf, type PathMapping } from "../farm/paths.js";

export const FARM_USAGE = "usage: surehand-ae farm check <manifest.json> [--ae <After Effects folder>] [--map <from>=<to>]... [--fonts <folder>]... [--plugins <folder>]... [--json]";

export interface FarmCli { code: number; out: string }

export function farmCommand(argv: string[], o: { platform?: NodeJS.Platform; home?: string; systemFonts?: boolean } = {}): FarmCli {
  const json = argv.includes("--json");
  const fail = (code: number, error: string): FarmCli => ({ code, out: json ? JSON.stringify({ ok: false, error }) : error });
  const [sub, ...rest] = argv.filter((a) => a !== "--json");
  if (sub !== "check") return fail(2, FARM_USAGE);
  const pos: string[] = [], map: PathMapping[] = [], fonts: string[] = [], plugins: string[] = [];
  let ae: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i], v = rest[i + 1];
    if (a === "--ae" || a === "--map" || a === "--fonts" || a === "--plugins") {
      if (v === undefined) return fail(2, `${a} needs a value. ${FARM_USAGE}`);
      i++;
      if (a === "--ae") ae = v;
      else if (a === "--fonts") fonts.push(v);
      else if (a === "--plugins") plugins.push(v);
      else {
        const eq = v.indexOf("=");
        if (eq <= 0) return fail(2, `--map takes <from>=<to>, e.g. --map /Volumes/Jobs=J:\\Jobs (got "${v}")`);
        map.push({ from: v.slice(0, eq), to: v.slice(eq + 1) });
      }
    } else if (a.startsWith("--")) return fail(2, `Unknown option ${a}. ${FARM_USAGE}`);
    else pos.push(a);
  }
  if (pos.length !== 1) return fail(2, FARM_USAGE);
  const file = resolve(pos[0]);
  let m: Manifest;
  try {
    m = JSON.parse(readFileSync(file, "utf8"));
  } catch (e: any) {
    return fail(2, `The manifest ${file} can't be read: ${e?.message ?? e}`);
  }
  if ((m as any)?.surehandFarmManifest !== 1) return fail(2, `${file} is not a farm manifest (ae_farm {action: "manifest", save: true} writes one).`);
  const r = checkManifest(m, { platform: platformOf(o.platform ?? process.platform), home: o.home ?? homedir(), aeFolder: ae, pathMap: map, fontFolders: fonts, pluginFolders: plugins.length ? plugins : undefined, systemFonts: o.systemFonts, live: null });
  const code = r.verdict.startsWith("FAIL") ? 1 : r.verdict.startsWith("INCOMPLETE") ? 3 : 0;
  return { code, out: json ? JSON.stringify({ ok: code === 0, ...r }) : formatCheck(r, m, file).trimEnd() };
}
