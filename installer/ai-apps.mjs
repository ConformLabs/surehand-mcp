// The installers' AI app lists, generated from the one definition, installer/ai-apps.json (the server takes the
// names from it too), so the Windows Setup, the Mac Installer and the server cannot drift apart:
//
//   nsisApps()              the Windows Setup's ai-apps.nsh: AI_APPS_FOR_EACH calls a macro once per app
//                           (N, id, name) in the list's order; package-win-installer.mjs writes it at build time
//   macDistribution(xml)    the Mac Installer's distribution.xml from installer/mac/pkg/distribution.xml: one choice
//                           per app (found on this Mac: ticked; not found: greyed out, the description says why),
//                           the optional cloudflared choice, the hidden last step that writes the summary; the
//                           titles are short (macTitles) because Installer's Package Name column cuts them off
//   macComponents()         the payload-free component packages those choices install (id, file, postinstall args)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_ID = "com.conformlabs.surehand-mcp";

export function loadAiApps(file = join(HERE, "ai-apps.json")) {
  const def = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(def.apps) || !def.apps.length) throw new Error(`${file}: "apps" is empty`);
  for (const a of def.apps) {
    if (!/^[a-z][a-z0-9-]*$/.test(a.id ?? "")) throw new Error(`${file}: bad app id ${JSON.stringify(a.id)}`);
    if (typeof a.name !== "string" || !a.name || /["$\\<>&]/.test(a.name)) throw new Error(`${file}: ${a.id}: the name must be plain text`);
    if (a.macName !== undefined && (typeof a.macName !== "string" || !a.macName || /["$\\<>&]/.test(a.macName))) throw new Error(`${file}: ${a.id}: the macName must be plain text`);
    if (!Array.isArray(a.mac) || !a.mac.length) throw new Error(`${file}: ${a.id}: "mac" lists no paths`);
  }
  return def;
}

/**
 * The Mac Installer's Custom Install list has a fixed Package Name column (about 250 px at the system font) that cuts
 * longer titles off, so its titles stay within this many characters; the description pane under the list says the
 * rest (not found on this Mac, the cloudflared download). The Windows Setup keeps the full names.
 */
export const MAC_TITLE_MAX = 30;

/** The Mac Installer's choice titles: { main, apps: { <id>: title }, tunnel }. */
export function macTitles(def = loadAiApps()) {
  return {
    main: "Surehand MCP",
    apps: Object.fromEntries(def.apps.map((a) => [a.id, `Connect ${a.macName ?? a.name}`])),
    tunnel: def.web.macTitle ?? def.web.title,
  };
}

/** The Windows Setup's list (an NSIS header). */
export function nsisApps(def = loadAiApps()) {
  return [
    "; Generated from installer/ai-apps.json by installer/ai-apps.mjs (npm run package:win-installer): do not edit.",
    `!define AI_APP_COUNT ${def.apps.length}`,
    `!define AI_WEB_TITLE "${def.web.title}"`,
    "; !insertmacro AI_APPS_FOR_EACH <macro>: <macro> N id name, once per app, in the list's order",
    "!macro AI_APPS_FOR_EACH MACRO",
    ...def.apps.map((a, i) => `  !insertmacro \${MACRO} ${i + 1} "${a.id}" "${a.name}"`),
    "!macroend",
    "",
  ].join("\r\n");
}

const xml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The payload-free component packages of the Mac Installer's choices, in the order they install. */
export function macComponents(def = loadAiApps()) {
  return [
    ...def.apps.map((a) => ({ choice: `app-${a.id}`, id: `${PKG_ID}.connect.${a.id}`, file: `surehand-mcp-connect-${a.id}.pkg`, args: ["install", "--connect-only", "--clients", a.id] })),
    { choice: "tunnel", id: `${PKG_ID}.tunnel`, file: "surehand-mcp-tunnel.pkg", args: ["install", "--connect-only", "--tunnel"] },
    { choice: "summary", id: `${PKG_ID}.summary`, file: "surehand-mcp-summary.pkg", args: ["install", "--summary"] },
  ];
}

export const MAC_NOTE = "Surehand connects the apps you tick. You can change this later in the Surehand panel in Adobe® After Effects®.";

/**
 * distribution.xml from its template: @VERSION@, @COMPONENT_PKG@ (the main package), and @APP_PATHS@ (the paths each
 * app is looked for at, for the found() script), @CHOICES_OUTLINE@ / @CHOICES@ / @PKG_REFS@ (generated here).
 */
export function macDistribution(template, { version, componentPkg, def = loadAiApps() }) {
  const comps = macComponents(def);
  const comp = (choice) => comps.find((c) => c.choice === choice);
  const outline = ["main", ...def.apps.flatMap((a) => [`app-${a.id}`, `app-${a.id}-missing`]), "tunnel", "summary"].map((c) => `        <line choice="${c}"/>`);
  const titles = macTitles(def);
  const choices = [
    `    <choice id="main" title="${xml(titles.main)}" description="${xml("The Surehand MCP server, its private Node.js and the After Effects panel, for your Mac account only.")}" enabled="false" selected="true">`,
    `        <pkg-ref id="${PKG_ID}"/>`,
    "    </choice>",
    ...def.apps.flatMap((a) => [
      // found on this Mac: ticked (the user can untick it)
      `    <choice id="app-${a.id}" title="${xml(titles.apps[a.id])}" description="${xml(MAC_NOTE)}" visible="found('${a.id}')" start_selected="found('${a.id}')">`,
      `        <pkg-ref id="${comp(`app-${a.id}`).id}"/>`,
      "    </choice>",
      // not found: shown greyed out, nothing to install; the description says why
      `    <choice id="app-${a.id}-missing" title="${xml(titles.apps[a.id])}" description="${xml(`${a.name} was not found on this Mac. Install it, then run this installer again. ${MAC_NOTE}`)}" visible="!found('${a.id}')" enabled="false" selected="false"/>`,
    ]),
    `    <choice id="tunnel" title="${xml(titles.tunnel)}" description="${xml("Downloads Cloudflare's cloudflared (20 MB) into ~/.surehand/bin for the secure link ChatGPT on the web uses. You can also do this later in the Surehand panel.")}" start_selected="${def.web.default ? "true" : "false"}">`,
    `        <pkg-ref id="${comp("tunnel").id}"/>`,
    "    </choice>",
    // the last step: what happened, at the top of ~/.surehand/ae/install.log
    `    <choice id="summary" title="Summary" visible="false" enabled="false" selected="true">`,
    `        <pkg-ref id="${comp("summary").id}"/>`,
    "    </choice>",
  ];
  const refs = [
    `    <pkg-ref id="${PKG_ID}" version="${version}" onConclusion="none">${componentPkg}</pkg-ref>`,
    ...comps.map((c) => `    <pkg-ref id="${c.id}" version="${version}" onConclusion="none">${c.file}</pkg-ref>`),
  ];
  const paths = Object.fromEntries(def.apps.map((a) => [a.id, a.mac]));
  return template
    .replaceAll("@VERSION@", version)
    .replaceAll("@COMPONENT_PKG@", componentPkg)
    .replace("@APP_PATHS@", () => JSON.stringify(paths))
    .replace("@CHOICES_OUTLINE@", () => outline.join("\n"))
    .replace("@CHOICES@", () => choices.join("\n"))
    .replace("@PKG_REFS@", () => refs.join("\n"));
}
