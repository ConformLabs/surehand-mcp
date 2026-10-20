// Conform Labs installer frame (Windows): how Setup runs the app's own commands with its private Node.js.
//
//   node cl-run.cjs [--ini <out.ini>] [--json-file <in.json>] -- <node arguments...>
//   node cl-run.cjs --ini <out.ini> --json-file <in.json>     only the conversion (no command)
//
// Runs `node <arguments>` with no console input (a command never waits for an answer) and turns its output into
// plain ASCII for Setup's "Show details" log (no colour codes; check marks become words). Exits with the
// command's exit code.
// --ini: Setup (NSIS) can't read JSON, so the command's JSON answer is also written as an INI file it can read with
// ReadINIStr: the JSON from --json-file (a result file the command wrote), else the last line of its output that
// is a JSON object. Objects become sections named by their path ("root" for the top level; "clients.0" for the
// first item of "clients"), their plain values keys; an array also gets "count" in its own section, and an array
// of plain values its items as keys 0, 1, ... in that section. Values are written on one line.
"use strict";
const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const opts = sep >= 0 ? argv.slice(0, sep) : argv;
const args = sep >= 0 ? argv.slice(sep + 1) : [];
const opt = (name) => {
  const i = opts.indexOf(name);
  return i >= 0 ? opts[i + 1] : undefined;
};
const iniFile = opt("--ini");
const jsonFile = opt("--json-file");

const MAP = { "✔": "OK", "✖": "X", "·": "-", "…": "...", "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "→": "->" };
const clean = (s) =>
  s
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[^\t\n\r\x20-\x7e]/g, (c) => MAP[c] ?? "")
    .replace(/\r?\n/g, "\r\n");

/** JSON -> INI text (see above). */
function toIni(value) {
  const sections = new Map();
  const put = (section, key, v) => {
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push(`${key}=${String(v).replace(/[\r\n]+/g, " ")}`);
  };
  const walk = (path, v) => {
    if (Array.isArray(v)) {
      put(path, "count", v.length);
      v.forEach((item, i) => (item && typeof item === "object" ? walk(`${path}.${i}`, item) : put(path, String(i), item)));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (x && typeof x === "object") walk(path === "root" ? k : `${path}.${k}`, x);
        else if (x !== undefined && x !== null) put(path, k, typeof x === "boolean" ? (x ? 1 : 0) : x);
      }
    }
  };
  walk("root", value);
  return [...sections].map(([name, lines]) => `[${name}]\r\n${lines.join("\r\n")}\r\n`).join("\r\n");
}

function lastJson(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--)
    try {
      return JSON.parse(lines[i]);
    } catch {}
  return null;
}

/** The INI file Setup reads, in UTF-16 with a BOM: what Windows' INI functions (NSIS ReadINIStr) read as Unicode. */
function writeIni(file, data) {
  writeFileSync(file, Buffer.from(`\ufeff${toIni(data ?? { ok: false, error: "no answer" })}`, "utf16le"));
}

module.exports = { toIni, lastJson, writeIni };

/** Only the conversion: the JSON file Setup names, as an INI file. */
function convert() {
  try {
    writeIni(iniFile, JSON.parse(readFileSync(jsonFile, "utf8").replace(/^\ufeff/, "")));
  } catch (e) {
    process.stderr.write(`Could not convert ${jsonFile}: ${e.message}\r\n`);
    process.exitCode = 1;
  }
}

function run() {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    from.setEncoding("utf8"); // decodes characters split across chunks correctly
    from.on("data", (s) => {
      if (from === child.stdout) stdout += s;
      to.write(clean(s));
    });
  }
  child.on("error", (e) => {
    process.stderr.write(`Could not run Node.js: ${e.message}\r\n`);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
    if (!iniFile) return;
    let data = null;
    try {
      data = jsonFile ? JSON.parse(readFileSync(jsonFile, "utf8").replace(/^\ufeff/, "")) : lastJson(stdout);
    } catch (e) {
      process.stderr.write(`No result to read (${e.message})\r\n`);
    }
    try {
      writeIni(iniFile, data);
    } catch (e) {
      process.stderr.write(`Could not write ${iniFile}: ${e.message}\r\n`);
    }
  });
}

if (require.main === module) {
  if (args.length) run();
  else convert();
}
