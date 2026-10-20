// Mock-ups of the Mac Installer's pages for review (generate-art.mjs --preview), at the Installer window's real size
// (620 x 440 points): Apple's window, sidebar and controls drawn approximately, with the real background image, the
// real welcome / conclusion pages (macPage) and the Installation Type choices as installer/ai-apps.mjs generates them.
import { join } from "node:path";
import { loadAiApps, macTitles, MAC_NOTE } from "../ai-apps.mjs";

export function macPages({ app, version, preview, macPage }) {
  const steps = ["Introduction", "Destination Select", "Installation Type", "Installation", "Summary"];
  const frame = (mode, active, content, buttons) => {
    const dark = mode === "dark";
    const win = dark ? "#1E1E1E" : "#ECECEC", pane = dark ? "#262626" : "#FFFFFF", text = dark ? "#EDEDED" : "#1D1D1F", dim = dark ? "#8A8A8A" : "#9A9A9A";
    const bg = `file://${join(preview, `mac-background-${mode}@2x.png`)}`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:${win};font:13px -apple-system,"Helvetica Neue",sans-serif;color:${text}}
.title{height:28px;display:flex;align-items:center;justify-content:center;font-size:13px;color:${dark ? "#BDBDBD" : "#4D4D4D"};border-bottom:1px solid ${dark ? "#2A2A2A" : "#D4D4D4"}}
.dots{position:absolute;left:12px;top:8px;display:flex;gap:8px}.dots i{width:12px;height:12px;border-radius:50%;display:block}
.side{position:absolute;left:0;top:28px;width:152px;bottom:0;background:url('${bg}') no-repeat left bottom/152px 120px}
.side ol{list-style:none;margin:20px 0 0 16px;padding:0;line-height:22px;font-size:13px}
.main{position:absolute;left:168px;top:44px;right:16px;bottom:56px;background:${pane};border:1px solid ${dark ? "#3A3A3A" : "#D0D0D0"};border-radius:6px;overflow:hidden}
.main iframe{border:0;width:100%;height:100%;background:transparent}
.btn{position:absolute;bottom:16px;height:24px;padding:0 14px;border-radius:6px;font-size:13px;display:flex;align-items:center;background:${dark ? "#4A4A4A" : "#FFFFFF"};border:1px solid ${dark ? "#4A4A4A" : "#C8C8C8"}}
.btn.def{background:#2F7CF6;border-color:#2F7CF6;color:#fff}
.cap{position:absolute;left:168px;top:34px;font-size:13px;color:${dark ? "#BDBDBD" : "#4D4D4D"}}
table{border-collapse:collapse;width:100%;font-size:13px}th{font-weight:400;text-align:left;color:${dim};padding:3px 8px;border-bottom:1px solid ${dark ? "#3A3A3A" : "#DDD"}}
td{padding:3px 8px}.cb{width:14px;height:14px;border-radius:4px;border:1px solid ${dim};display:inline-block;vertical-align:middle;position:relative}
.cb.on{background:#2F7CF6;border-color:#2F7CF6}.cb.on::after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
.grey{color:${dim}}.note{position:absolute;left:0;right:0;bottom:0;padding:8px 10px;border-top:1px solid ${dark ? "#3A3A3A" : "#DDD"};font-size:12px}
</style></head><body><div class="dots"><i style="background:#FF5F57"></i><i style="background:#FEBC2E"></i><i style="background:#28C840"></i></div>
<div class="title">Install ${app.name}</div>
<div class="side"><ol>${steps.map((s) => `<li style="${s === active ? "font-weight:600" : `color:${dim}`}">${s}</li>`).join("")}</ol></div>
${content}
${buttons.map(([label, right, def]) => `<div class="btn ${def ? "def" : ""}" style="right:${right}px">${label}</div>`).join("")}
</body></html>`;
  };
  const iframe = (page) => `data:text/html;base64,${Buffer.from(macPage(page, { version, app })).toString("base64")}`;
  const def = loadAiApps();
  const titles = macTitles(def);
  // on the reviewer's Mac the choices would follow what is installed; the mock-up shows the design's case
  const found = { "claude-desktop": true, "claude-code": true, cursor: true, codex: false, vscode: true, windsurf: false, "lm-studio": false };
  const rows = [
    `<tr><td><span class="cb on" style="opacity:.5"></span></td><td>${app.name}</td><td class="grey">Install</td></tr>`,
    ...def.apps.map((a) => found[a.id]
      ? `<tr><td><span class="cb on"></span></td><td>${titles.apps[a.id]}</td><td class="grey">Install</td></tr>`
      : `<tr class="grey"><td><span class="cb" style="opacity:.5"></span></td><td>${titles.apps[a.id]}</td><td>Skip</td></tr>`),
    `<tr><td><span class="cb"></span></td><td>${titles.tunnel}</td><td class="grey">Skip</td></tr>`,
  ];
  return {
    welcome: (mode) => frame(mode, "Introduction", `<div class="main"><iframe src="${iframe("welcome")}"></iframe></div>`, [["Continue", 16, true], ["Go Back", 110]]),
    choices: (mode) => frame(mode, "Installation Type", `<div class="cap">Custom Install on “Macintosh HD”</div><div class="main" style="top:56px"><table><tr><th style="width:30px"></th><th>Package Name</th><th style="width:70px">Action</th></tr>${rows.join("")}</table><div class="note">${MAC_NOTE}</div></div>`, [["Install", 16, true], ["Go Back", 96], ["Change Install Location…", 196]]),
    conclusion: (mode) => frame(mode, "Summary", `<div class="main"><iframe src="${iframe("conclusion")}"></iframe></div>`, [["Close", 16, true], ["Go Back", 92]]),
  };
}
