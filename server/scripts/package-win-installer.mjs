// Builds the Windows installer, dist-zip/Surehand-MCP-Setup-<version>.exe, with NSIS (makensis) on this
// Mac (or any machine with makensis). Per-user install, no admin rights: see installer/windows/nsis/surehand-mcp.nsi.
//
//   npm run package:win-installer                 unsigned
//   npm run package:win-installer -- --sign       Authenticode-signs the installer and its uninstaller
//                                                 (scripts/sign-win.mjs; SimplySign Desktop must be logged in)
//   AEMCP_WIN_SIGN=1 npm run package:win-installer   same as --sign
//
// Node.js is the official win-x64 build, pinned below and checked against both the pinned SHA-256 and
// nodejs.org's SHASUMS256.txt. node.exe is shipped byte for byte, so it keeps the OpenJS Foundation's
// Authenticode signature. Downloads are cached in installer/windows/nsis/.cache (gitignored).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "24.22.0"; // Node.js 24 LTS ("Krypton")
const NODE_ZIP = `node-v${NODE_VERSION}-win-x64.zip`;
const NODE_ZIP_SHA256 = "f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3";
const NODE_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(SERVER, "..");
const NSIS_DIR = join(ROOT, "installer", "windows", "nsis");
const CACHE = join(NSIS_DIR, ".cache");
const OUT_DIR = join(ROOT, "dist-zip");
const pkg = JSON.parse(readFileSync(join(SERVER, "package.json"), "utf8"));
const sign = process.argv.includes("--sign") || /^(1|true|yes)$/i.test(process.env.AEMCP_WIN_SIGN || "");

const has = (cmd) => spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// --- makensis ---
if (!has("makensis")) {
  if (process.platform === "darwin" && has("brew")) {
    console.log("makensis not found: brew install makensis");
    run("brew", ["install", "makensis"]);
  } else throw new Error("makensis (NSIS 3.08+) not found: install NSIS (macOS: brew install makensis; Linux: apt install nsis)");
}

// --- signing preflight: fail before a long build if SimplySign is not logged in ---
const signScript = join(SERVER, "scripts", "sign-win.mjs");
if (sign && spawnSync(process.execPath, [signScript, "--check"], { stdio: "inherit" }).status !== 0) process.exit(1);

// --- server bundle ---
run(process.execPath, ["build.mjs"], { cwd: SERVER });
const serverMjs = join(SERVER, "dist", "ae-mcp.mjs");

// --- Node.js (pinned, verified) ---
mkdirSync(CACHE, { recursive: true });
const nodeExe = join(CACHE, `node-v${NODE_VERSION}-win-x64.exe`);
if (!existsSync(nodeExe)) {
  const zip = join(CACHE, NODE_ZIP);
  if (!existsSync(zip) || sha256(zip) !== NODE_ZIP_SHA256) {
    console.log(`Downloading ${NODE_BASE}/${NODE_ZIP}`);
    const res = await fetch(`${NODE_BASE}/${NODE_ZIP}`);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    writeFileSync(zip + ".part", Buffer.from(await res.arrayBuffer()));
    renameSync(zip + ".part", zip);
  }
  const sums = await (await fetch(`${NODE_BASE}/SHASUMS256.txt`)).text();
  const listed = sums.split("\n").map((l) => l.trim().split(/\s+/)).find(([, f]) => f === NODE_ZIP)?.[0];
  const actual = sha256(zip);
  if (actual !== NODE_ZIP_SHA256 || listed !== NODE_ZIP_SHA256) {
    rmSync(zip, { force: true });
    throw new Error(`${NODE_ZIP} checksum mismatch (got ${actual}, pinned ${NODE_ZIP_SHA256}, SHASUMS256.txt ${listed})`);
  }
  console.log(`${NODE_ZIP}: SHA-256 matches the pinned value and SHASUMS256.txt`);
  const tmp = mkdtempSync(join(CACHE, "unzip-"));
  try {
    run("unzip", ["-q", "-j", zip, `node-v${NODE_VERSION}-win-x64/node.exe`, "-d", tmp]);
    renameSync(join(tmp, "node.exe"), nodeExe);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
// node.exe must still carry the OpenJS Foundation's Authenticode signature
if (has("osslsigncode")) {
  const v = spawnSync("osslsigncode", ["verify", "-in", nodeExe], { encoding: "utf8" });
  const text = `${v.stdout}\n${v.stderr}`;
  const signer = text.match(/Subject:.*OpenJS Foundation.*/)?.[0];
  const current = text.match(/Current message digest\s*:\s*([0-9A-F]+)/)?.[1];
  const calculated = text.match(/Calculated message digest\s*:\s*([0-9A-F]+)/)?.[1];
  if (!signer || !current || current !== calculated) throw new Error(`node.exe has no intact OpenJS Foundation signature:\n${text}`);
  console.log(`node.exe signature: ${signer.trim()}${v.status === 0 ? " (verified)" : " (digest matches; certificate chain not checked on this machine)"}`);
} else console.log("osslsigncode not found: skipping the node.exe signature check");

// --- icon (multi-size .ico with PNG images, from server/assets/icon.png; macOS sips) ---
const icon = join(CACHE, "surehand-mcp.ico");
const iconSrc = join(SERVER, "assets", "icon.png");
if (!existsSync(icon) || statSync(icon).mtimeMs < statSync(iconSrc).mtimeMs) {
  const sizes = [16, 24, 32, 48, 64, 256];
  const pngs = sizes.map((s) => {
    const out = join(CACHE, `icon-${s}.png`);
    run("sips", ["-z", String(s), String(s), "-s", "format", "png", iconSrc, "--out", out], { stdio: "ignore" });
    const data = readFileSync(out);
    rmSync(out);
    return { s, data };
  });
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ s, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(s >= 256 ? 0 : s, e);
    header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  writeFileSync(icon, Buffer.concat([header, ...pngs.map((p) => p.data)]));
}

// --- makensis ---
const version = pkg.version;
const [maj, min, pat] = version.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
mkdirSync(OUT_DIR, { recursive: true });
const outFile = join(OUT_DIR, `Surehand-MCP-Setup-${version}.exe`);
rmSync(outFile, { force: true });
const estimatedKb = Math.ceil((statSync(nodeExe).size + statSync(serverMjs).size + statSync(icon).size) / 1024) + 200;
const defines = {
  VERSION: version,
  VERSION4: `${maj}.${min}.${pat}.0`,
  NODE_VERSION,
  NODE_EXE: nodeExe,
  SERVER_MJS: serverMjs,
  LOG_FILTER: join(NSIS_DIR, "log-filter.cjs"),
  ICON: icon,
  OUTFILE: outFile,
  ESTIMATED_KB: String(estimatedKb),
};
if (sign) defines.SIGN_CMD = `"${process.execPath}" "${signScript}"`;
run("makensis", ["-V2", "-INPUTCHARSET", "UTF8", ...Object.entries(defines).map(([k, v]) => `-D${k}=${v}`), join(NSIS_DIR, "surehand-mcp.nsi")]);

if (has("osslsigncode")) {
  const v = spawnSync("osslsigncode", ["verify", "-in", outFile], { encoding: "utf8" });
  const signer = `${v.stdout}`.match(/Subject:.*/)?.[0];
  console.log(sign ? `Installer signature: ${signer?.trim() ?? "MISSING"}` : "Installer is unsigned (pass --sign to sign it).");
  if (sign && !signer) throw new Error("the installer is not signed");
}
const size = statSync(outFile).size;
console.log(`\nWindows installer ready:\n  ${outFile}\n  ${(size / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256(outFile)}`);
