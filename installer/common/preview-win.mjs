// Mock-ups of the Windows Setup's pages for review (generate-art.mjs --preview): HTML at the real size, laid out in
// the dialog units conformlabs.nsh and surehand-mcp.nsi use, at Segoe UI 9 and 100 % scaling (1 unit = 1.75 px
// across, 1.875 px down), with the real bitmaps and fonts. Not a screenshot of Windows: Segoe UI is replaced by a
// similar face on a Mac, and the native check boxes, radio buttons and push buttons are drawn the way Windows 11's
// dark theme draws them (their colours come from Windows, not from Setup).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLORS, resultLines } from "./frame.mjs";

const UX = 1.75, UY = 1.875;
const W = Math.round(330 * UX), H = Math.round(219 * UY), BAR = 31;
const px = (x, y, w, h) => `left:${Math.round(x * UX)}px;top:${Math.round(y * UY)}px;width:${Math.round(w * UX)}px;height:${Math.round(h * UY)}px`;
const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

export function winPages({ app, version, art, fonts }) {
  const bmp = (f) => `data:image/bmp;base64,${readFileSync(join(art, f)).toString("base64")}`;
  const accent = app.accent.dark;
  const css = `${fonts}
*{box-sizing:border-box}
html,body{margin:0;background:#202020}
.win{position:absolute;left:0;top:0;width:${W}px;height:${H + BAR}px;background:${COLORS.paper};color:${COLORS.ink};font:12px/15px "Segoe UI","Helvetica Neue",Arial,sans-serif;overflow:hidden}
.bar{position:absolute;left:0;top:0;right:0;height:${BAR}px;background:${COLORS.paperSunk};display:flex;align-items:center;gap:8px;padding:0 10px;font-size:12px}
.bar .ctl{margin-left:auto;letter-spacing:22px;color:${COLORS.inkMuted}}
.c{position:absolute;left:0;top:${BAR}px;width:${W}px;height:${H}px}
.a{position:absolute;white-space:normal;overflow:hidden}
.muted{color:${COLORS.inkMuted}}
.head{background:${COLORS.paperSunk}}
.t1{font:600 20px/24px "Space Grotesk"}
.th{font:600 14.5px/18px "Space Grotesk"}
.strong{font:600 12px/15px "IBM Plex Sans"}
.mono{font:400 10.5px/14px "IBM Plex Mono"}
.lab{font:500 9.5px/12px "IBM Plex Mono";letter-spacing:.04em}
.rule{background:${COLORS.rule};height:1px!important}
.btn{position:absolute;display:flex;align-items:center;justify-content:center;border:1px solid #5f5f5f;border-radius:4px;background:#2b2b2b;color:#fff;font:12px "Segoe UI","Helvetica Neue",sans-serif}
.btn.main{background:${accent};border-color:${accent};color:#14161A;font:600 12px "IBM Plex Sans"}
.btn.off{color:#7a7a7a;border-color:#3a3a3a;background:#262626}
.box{position:absolute;width:13px;height:13px;border:1px solid #9a9a9a;border-radius:3px;background:#1f1f1f}
.box.on{background:#4cc2ff;border-color:#4cc2ff}
.box.on::after{content:"";position:absolute;left:3px;top:0px;width:4px;height:8px;border:solid #000;border-width:0 2px 2px 0;transform:rotate(45deg)}
.box.off{opacity:.45}
.radio{position:absolute;width:13px;height:13px;border:1px solid #9a9a9a;border-radius:50%;background:#1f1f1f}
.radio.on{border-color:#4cc2ff}
.radio.on::after{content:"";position:absolute;left:3px;top:3px;width:5px;height:5px;border-radius:50%;background:#4cc2ff}
img.p{position:absolute;image-rendering:pixelated}`;
  const titleBar = `<div class="bar"><span style="width:16px;height:16px;background:${accent};display:inline-block"></span><span>${esc(app.name)} setup</span><span class="ctl">–□×</span></div>`;
  const footer = (buttons) =>
    `<div class="a rule" style="${px(0, 193, 330, 1)}"></div>` +
    buttons.map(([label, x, kind]) => `<div class="btn ${kind ?? ""}" style="${px(x, 199, 50, 14)}">${label}</div>`).join("");
  const header = (title, sub) =>
    `<div class="a head" style="${px(0, 0, 330, 35)}"></div><img class="p" src="${bmp("header-175.bmp")}" style="left:${W - 175}px;top:0;width:175px;height:66px">` +
    `<div class="a th" style="${px(10, 7, 220, 10)}">${esc(title)}</div><div class="a muted" style="${px(15, 19, 220, 16)}">${esc(sub)}</div>` +
    `<div class="a rule" style="${px(0, 35, 330, 1)}"></div>`;
  const inner = (x, y, w, h, body, cls = "") => `<div class="a ${cls}" style="${px(15 + x, 44 + y, w, h)}">${body}</div>`;
  const sidebar = `<img class="p" src="${bmp("wizard-191.bmp")}" style="left:0;top:0;width:191px;height:362px"><div class="a mono muted" style="${px(12, 178, 90, 9)}">${esc(version)}</div>`;
  const page = (body, buttons) => ({ w: W, h: H + BAR, page: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="win">${titleBar}<div class="c">${body}${footer(buttons)}</div></div></body></html>` });
  const rule = (y) => inner(0, y, 300, 1, "", "rule");
  const checkRow = (y, title, note, on, enabled = true) =>
    rule(y) + `<div class="box ${on ? "on" : ""} ${enabled ? "" : "off"}" style="left:${Math.round(15 * UX)}px;top:${Math.round((44 + y + 4) * UY) + 3}px"></div>` +
    inner(13, y + 4, 280, 10, esc(title), enabled ? "strong" : "muted") + (note ? inner(13, y + 13, 280, 9, esc(note), "muted") : "");
  // the bitmaps have a 1 px margin of their background
  const glyph = (kind, bg, x, y) => `<img class="p" src="${bmp(`glyph-${kind}-${bg}-9.bmp`)}" style="left:${Math.round(x * UX) - 1}px;top:${Math.round(y * UY) - 1}px;width:11px;height:11px">`;

  const pages = {};
  pages.welcome = page(
    sidebar +
      `<div class="a t1" style="${px(124, 20, 196, 16)}">Install ${esc(app.name)}</div>` +
      `<div class="a muted" style="${px(124, 38, 196, 10)}">${esc(app.for)}</div>` +
      `<div class="a" style="${px(124, 56, 196, 34)}">Surehand lets the AI apps you use, like Claude, ChatGPT and Cursor, work in After Effects on this computer. Every edit is listed. You can undo it in After Effects.</div>` +
      `<div class="a muted" style="${px(124, 94, 196, 18)}">It installs for your Windows account only. No administrator rights needed.</div>` +
      `<div class="a muted" style="${px(124, 116, 196, 10)}">Next, you choose which AI apps to connect.</div>`,
    [["Back", 164, "off"], ["Next", 214, "main"], ["Cancel", 273]],
  );
  let y = 11, rows = "";
  for (const [name, found] of [["Claude Desktop", true], ["Claude Code", true], ["Cursor", true], ["ChatGPT desktop / Codex", false]]) {
    rows += checkRow(y, name, found ? "" : "Not found on this PC. Install it, then run Setup again.", found, found);
    y += found ? 15 : 23;
  }
  y += 4;
  rows += inner(0, y, 300, 9, "OPTIONAL", "lab muted");
  y += 10;
  rows += checkRow(y, "Set up ChatGPT on the web", "Downloads Cloudflare's cloudflared (about 55 MB) for the secure link ChatGPT uses.", false);
  y += 23;
  pages.apps = page(
    header("Choose AI apps", "Surehand connects the apps you tick. You can change this later in the panel.") + inner(0, 0, 300, 9, "AI APPS", "lab muted") + rows + rule(y),
    [["Back", 164], ["Install", 214, "main"], ["Cancel", 273]],
  );
  const steps = [["Installing Surehand MCP", "done"], ["Setting up After Effects", "done"], ["Connecting Claude Desktop", "done"], ["Connecting Claude Code", "done"], ["Connecting Cursor", "now"], ["Downloading cloudflared", "next"]];
  let sy = 26, sbody = "";
  for (const [t, st] of steps) {
    sbody += rule(sy) + glyph(st === "done" ? "done" : st === "now" ? "skipped" : "waiting", "paper", 15, 44 + sy + 4) +
      inner(10, sy + 3, 228, 9, esc(t), st === "now" ? "strong" : st === "next" ? "muted" : "") +
      inner(240, sy + 3, 60, 9, `<div style="text-align:right;color:${st === "done" ? accent : COLORS.inkMuted}">${st.toUpperCase()}</div>`, "lab");
    sy += 12;
  }
  sbody += rule(sy);
  pages.progress = page(
    header("Installing", "This takes about a minute.") +
      inner(0, 0, 300, 12, "Connecting Cursor…", "mono") +
      inner(0, 15, 300, 3, `<div style="height:100%;background:${COLORS.paperSunk}"><div style="width:62%;height:100%;background:${accent}"></div></div>`) +
      sbody + `<div class="btn" style="${px(15, 44 + sy + 6, 60, 14)}">Show details</div>`,
    [["Back", 164, "off"], ["Next", 214, "off"], ["Cancel", 273, "off"]],
  );
  const results = [
    ["done", `Connected Claude Desktop, Claude Code, Cursor`],
    ["skipped", "Not found: ChatGPT desktop / Codex"],
    ["done", "Adobe® After Effects® 2025, 2026"],
    ["failed", "cloudflared not downloaded: no internet. Panel › Menu › ChatGPT on the web installs it later."],
  ];
  // the results box as conformlabs.nsh builds it: the ink rule (1u), a 3u strip, rows (a 14u gutter with the glyph
  // centred, the text from 138u), a 3u strip; lines counted the same way (frame.mjs resultLines)
  let ry = 38 + 1 + 3, rbody = "";
  for (const [k, t] of results) {
    const h = resultLines(t) * 10;
    rbody += glyph(k, "sunk", 124 + 7 - 9 / 2 / UX, ry + h / 2 - 9 / 2 / UY) + `<div class="a mono ${k === "skipped" ? "muted" : ""}" style="${px(138, ry, 182, h)}">${esc(t)}</div>`;
    ry += h;
  }
  ry += 3;
  const next = ["Restart After Effects (it is open).", "Restart Claude Desktop, Claude Code and Cursor.", "Ask one of them “What's in my project?” The Surehand panel (Window › Extensions › Surehand MCP) shows when it's connected."];
  let ny = ry + 8, nbody = "";
  next.forEach((t, i) => {
    const lines = Math.max(1, Math.ceil(t.length / 48));
    nbody += `<div class="a muted" style="${px(124, ny, 9, 9)}">${i + 1}.</div><div class="a" style="${px(134, ny, 186, lines * 9)}">${esc(t)}</div>`;
    ny += lines * 9 + 3;
  });
  pages.finish = page(
    sidebar + `<div class="a t1" style="${px(124, 14, 196, 16)}">${esc(app.name)} is installed</div>` +
      `<div class="a" style="${px(124, 38, 196, 1)};background:${COLORS.ink}"></div>` +
      `<div class="a" style="${px(124, 39, 196, ry - 39)};background:${COLORS.paperSunk}"></div>` + rbody + nbody +
      `<div class="a muted" style="${px(124, 177, 22, 9)}">Help:</div><div class="a" style="${px(145, 177, 150, 10)};text-decoration:underline;text-align:center">github.com/ConformLabs/surehand-mcp</div>`,
    [["Finish", 273, "main"]],
  );
  const option = (y, on, title, note, noteH = 18) =>
    rule(y) + `<div class="radio ${on ? "on" : ""}" style="left:${Math.round(15 * UX)}px;top:${Math.round((44 + y + 5) * UY) + 3}px"></div>` +
    inner(13, y + 5, 280, 10, esc(title), "strong") + inner(13, y + 16, 280, noteH, esc(note), "muted");
  const maint = (uninstall) =>
    page(
      header("Update or uninstall Surehand MCP", "Version 1.4.0-beta.1 is installed for your Windows account.") +
        option(4, !uninstall, `Update to ${version}`, "Replaces 1.4.0-beta.1. Next, you can change which AI apps are connected. Your settings and checkpoints are kept.") +
        option(44, uninstall, "Uninstall", "Removes the server, the Adobe® After Effects® extension and the AI app connections.") +
        `<div class="box ${uninstall ? "" : "off"}" style="left:${Math.round(28 * UX)}px;top:${Math.round((44 + 81) * UY) + 3}px"></div>` +
        inner(25, 81, 268, 10, "Also remove my settings and checkpoints", uninstall ? "" : "muted") + rule(96),
      [[uninstall ? "Uninstall" : "Next", 214, "main"], ["Cancel", 273]],
    );
  pages.maintenance = maint(false);
  pages["maintenance-uninstall"] = maint(true);
  pages["uninstall-confirm"] = page(
    header("Uninstall Surehand MCP", "Remove Surehand MCP from your computer.") +
      inner(0, 0, 300, 30, "Surehand MCP will be removed: the server, the After Effects extension, its AI app connections and its private Node.js. Your settings (.surehand\\ae\\config.json), project checkpoints (.surehand\\ae\\checkpoints) and your other files there are kept.") +
      inner(0, 40, 60, 10, "Uninstalling from:", "muted") + inner(62, 38, 238, 13, `<div style="border:1px solid #444;padding:1px 4px;height:100%">C:\\Users\\you\\AppData\\Local\\Programs\\Surehand MCP\\</div>`),
    [["Uninstall", 214, "main"], ["Cancel", 273]],
  );
  pages["uninstall-confirm"].page = pages["uninstall-confirm"].page.replace(`${esc(app.name)} setup</span>`, `${esc(app.name)} uninstall</span>`);
  return pages;
}
