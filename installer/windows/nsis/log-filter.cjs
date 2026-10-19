// Used by the Windows Setup .exe (surehand-mcp.nsi): runs `node <args>` with no console input (so the
// server's installer never waits for an answer) and turns its output into plain ASCII for Setup's
// "Show details" log (no color codes; check marks become words). Exits with the child's exit code.
"use strict";
const { spawn } = require("node:child_process");

const child = spawn(process.execPath, process.argv.slice(2), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const MAP = { "✔": "OK", "✖": "X", "·": "-", "…": "...", "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "→": "->" };
const clean = (s) =>
  s
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[^\t\n\r\x20-\x7e]/g, (c) => MAP[c] ?? "")
    .replace(/\r?\n/g, "\r\n");
for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  from.setEncoding("utf8"); // decodes characters split across chunks correctly
  from.on("data", (s) => to.write(clean(s)));
}
child.on("error", (e) => {
  process.stderr.write(`Could not run Node.js: ${e.message}\r\n`);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
