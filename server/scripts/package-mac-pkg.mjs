// Builds the signed (and notarized) per-user macOS installer: dist-zip/Surehand-MCP-<version>.pkg
//
// Usage (macOS only, from server/):
//   npm run package:mac-pkg                          build, sign, notarize (waits up to 30 min), staple, verify
//   npm run package:mac-pkg -- --no-notarize         build and sign only (fast; the pkg is not notarized yet)
//   npm run package:mac-pkg -- --notarize-only <pkg> notarize + staple + verify an already built pkg
//   npm run package:mac-pkg -- --notarize-only <pkg> --submission-id <id>
//                                                    wait for an earlier submission of that pkg, then staple + verify
//   npm run package:mac-pkg -- --notary-timeout 2h   wait longer for Apple (default 30m)
//
// What it installs (no admin password; only the installing user's home folder):
//   ~/.aemcp/node/bin/node      Node.js 24 LTS (pinned below), universal arm64 + x86_64, re-signed with our Developer ID
//   ~/.aemcp/node/LICENSE       Node.js license
//   ~/.aemcp/server/ae-mcp.mjs  the single-file server (server/dist)
// then installer/mac/pkg/scripts/postinstall runs `node ae-mcp.mjs install` (extension, config, AI apps).
//
// Pipeline: build.mjs -> download both Node tarballs (cached in installer/mac/pkg/.cache, checked against the pinned
// hashes and nodejs.org SHASUMS256.txt) -> lipo -create -> codesign (hardened runtime + node.entitlements) -> smoke
// test both slices (node -e, server --version, MCP tools/list) -> pkgbuild (component, install location /.aemcp in
// the home domain) -> productbuild (distribution.xml, welcome/conclusion pages, Developer ID Installer signature)
// -> notarytool submit --wait -> stapler staple/validate -> spctl + pkgutil --check-signature.
//
// Needs: Xcode command line tools; the "Developer ID Application" and "Developer ID Installer" identities in the
// login keychain; notarization credentials stored as the keychain profile "aemcp-notary"
// (xcrun notarytool store-credentials aemcp-notary ...). Re-running is safe: downloads are reused when their hash
// matches, build output is recreated from scratch, an existing pkg of the same version is replaced.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "24.22.0"; // Node.js 24 LTS "Krypton"
const NODE_SHA256 = {
  arm64: "6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5",
  x64: "495e3f273c645f3c4677d438304cdfc701729ea5dec5728f5c8e76a2dece4b91",
};
const TEAM = "Ron Yitzhaki (PM339FMCLG)";
const APP_IDENTITY = `Developer ID Application: ${TEAM}`;
const INSTALLER_IDENTITY = `Developer ID Installer: ${TEAM}`;
const NOTARY_PROFILE = "aemcp-notary";
const PKG_ID = "com.conformlabs.surehand-mcp";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(SERVER, "..");
const PKG_SRC = join(ROOT, "installer", "mac", "pkg");
const CACHE = join(PKG_SRC, ".cache");
const BUILD = join(PKG_SRC, "build");
const OUT_DIR = join(ROOT, "dist-zip");
const version = JSON.parse(readFileSync(join(SERVER, "package.json"), "utf8")).version;

// ---------- helpers ----------
const die = (msg) => {
  console.error(`\npackage-mac-pkg: ERROR: ${msg}`);
  process.exit(1);
};
const log = (msg) => console.log(`\n== ${msg}`);
/** Run a command, echo it, inherit output; throws (exit 1) on failure. */
function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) die(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} exited with status ${r.status}`);
}
/** Run a command and return its stdout (stderr shown); throws (exit 1) on failure. */
function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  if (r.error) die(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} ${args.join(" ")} exited with status ${r.status}\n${r.stdout}${r.stderr}`);
  return r.stdout + r.stderr;
}
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const mb = (file) => `${(statSync(file).size / 1e6).toFixed(1)} MB`;

// ---------- arguments ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  if (!argv[i + 1] || argv[i + 1].startsWith("--")) die(`${name} needs a value`);
  return argv[i + 1];
};
const known = new Set(["--no-notarize", "--notarize-only", "--notary-timeout", "--submission-id"]);
for (let i = 0; i < argv.length; i++) {
  if (!known.has(argv[i])) die(`unknown argument ${argv[i]} (see the usage at the top of ${basename(fileURLToPath(import.meta.url))})`);
  if (argv[i] !== "--no-notarize") i++;
}
const notaryTimeout = option("--notary-timeout") || "30m";
if (process.platform !== "darwin") die("macOS only (pkgbuild, productbuild, codesign, notarytool).");

// ---------- notarize + staple + verify ----------
function notarize(pkg, submissionId = null) {
  // submit (or, with --submission-id, wait for an earlier submission of this same pkg) and wait up to notaryTimeout
  const args = submissionId
    ? ["notarytool", "wait", submissionId, "--keychain-profile", NOTARY_PROFILE, "--timeout", notaryTimeout, "--output-format", "json"]
    : ["notarytool", "submit", pkg, "--keychain-profile", NOTARY_PROFILE, "--wait", "--timeout", notaryTimeout, "--output-format", "json"];
  log(`Notarizing ${basename(pkg)}${submissionId ? ` (submission ${submissionId})` : ""} (waits up to ${notaryTimeout})`);
  const r = spawnSync("xcrun", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // the JSON result is on stdout, except for errors such as the timeout, which notarytool writes to stderr
  const output = `${r.stdout || ""}\n${r.stderr || ""}`;
  const jsonLine = output.split("\n").reverse().find((l) => l.trim().startsWith("{"));
  let result = {};
  try {
    result = JSON.parse(jsonLine);
  } catch {}
  console.log(output.trim());
  const id = result.id || submissionId;
  console.log(`submission id: ${id ?? "?"}  status: ${result.status ?? "?"}${result.message ? `  (${result.message})` : ""}`);
  if (result.status !== "Accepted") {
    if (id && result.status !== "Invalid" && result.status !== "Rejected")
      die(
        `notarization not finished yet (status ${result.status ?? "In Progress"}). Check with\n` +
          `  xcrun notarytool info ${id} --keychain-profile ${NOTARY_PROFILE}\n` +
          `then wait for it, staple and verify (without submitting again) with\n` +
          `  npm run package:mac-pkg -- --notarize-only ${pkg} --submission-id ${id}\n` +
          `Do not rebuild in between: the submission covers this exact file.`,
      );
    if (id) spawnSync("xcrun", ["notarytool", "log", id, "--keychain-profile", NOTARY_PROFILE], { stdio: "inherit" });
    die(`notarization failed (status ${result.status ?? "unknown"})`);
  }
  log("Stapling the notarization ticket");
  run("xcrun", ["stapler", "staple", pkg]);
  run("xcrun", ["stapler", "validate", pkg]);
  verifyPkg(pkg, true);
}

function verifyPkg(pkg, notarized) {
  log("Verifying the package signature");
  run("pkgutil", ["--check-signature", pkg]);
  const r = spawnSync("spctl", ["-a", "-vvv", "-t", "install", pkg], { encoding: "utf8" });
  const out = (r.stdout + r.stderr).trim();
  console.log(out);
  if (notarized && (r.status !== 0 || !/source=Notarized Developer ID/.test(out))) die("Gatekeeper (spctl) does not accept the notarized package");
  if (!notarized) console.log("(not notarized yet: Gatekeeper rejecting it above is expected)");
}

if (flag("--notarize-only")) {
  const pkg = resolve(option("--notarize-only"));
  if (!existsSync(pkg)) die(`no such file: ${pkg}`);
  notarize(pkg, option("--submission-id"));
  console.log(`\nDone: ${pkg} (${mb(pkg)})`);
  process.exit(0);
}

// ---------- 1. server bundle ----------
log("Building the server");
run(process.execPath, ["build.mjs"], { cwd: SERVER });
const bundle = join(SERVER, "dist", "ae-mcp.mjs");

// ---------- 2. Node.js download + verification ----------
log(`Node.js v${NODE_VERSION} (darwin-arm64 + darwin-x64)`);
mkdirSync(CACHE, { recursive: true });
const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
const shasumsFile = join(CACHE, `SHASUMS256-v${NODE_VERSION}.txt`);
if (!existsSync(shasumsFile)) run("curl", ["-fsSL", "--retry", "3", `${base}/SHASUMS256.txt`, "-o", shasumsFile]);
const shasums = readFileSync(shasumsFile, "utf8");
const extracted = {};
for (const arch of ["arm64", "x64"]) {
  const name = `node-v${NODE_VERSION}-darwin-${arch}.tar.gz`;
  const listed = shasums.split("\n").find((l) => l.trim().endsWith(`  ${name}`))?.split(/\s+/)[0];
  if (listed !== NODE_SHA256[arch]) die(`${name}: the pinned hash does not match nodejs.org SHASUMS256.txt (${listed ?? "not listed"})`);
  const tarball = join(CACHE, name);
  if (existsSync(tarball) && sha256(tarball) !== NODE_SHA256[arch]) {
    console.log(`${name}: cached copy has the wrong hash; downloading again`);
    rmSync(tarball);
  }
  if (!existsSync(tarball)) run("curl", ["-fL", "--retry", "3", "--progress-bar", `${base}/${name}`, "-o", `${tarball}.part`]), run("mv", [`${tarball}.part`, tarball]);
  if (sha256(tarball) !== NODE_SHA256[arch]) die(`${name}: checksum mismatch after download`);
  console.log(`${name}: sha256 OK`);
  const dir = join(CACHE, `node-v${NODE_VERSION}-darwin-${arch}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  const top = `node-v${NODE_VERSION}-darwin-${arch}`;
  run("tar", ["-xzf", tarball, "-C", dir, "--strip-components", "1", `${top}/bin/node`, `${top}/LICENSE`]);
  extracted[arch] = dir;
}

// ---------- 3. payload ----------
log("Assembling the payload");
rmSync(BUILD, { recursive: true, force: true });
const payload = join(BUILD, "root"); // installed at ~/.aemcp
const nodeBin = join(payload, "node", "bin", "node");
mkdirSync(dirname(nodeBin), { recursive: true });
mkdirSync(join(payload, "server"), { recursive: true });
run("lipo", ["-create", join(extracted.arm64, "bin", "node"), join(extracted.x64, "bin", "node"), "-output", nodeBin]);
const archs = capture("lipo", ["-archs", nodeBin]).trim().split(/\s+/).sort();
if (archs.join(",") !== "arm64,x86_64") die(`universal node has architectures ${archs.join(",")}`);
console.log(`universal node: ${archs.join(" + ")}, ${mb(nodeBin)}`);
chmodSync(nodeBin, 0o755);
copyFileSync(join(extracted.arm64, "LICENSE"), join(payload, "node", "LICENSE"));
chmodSync(join(payload, "node", "LICENSE"), 0o644);
copyFileSync(bundle, join(payload, "server", "ae-mcp.mjs"));
chmodSync(join(payload, "server", "ae-mcp.mjs"), 0o755);
run("xattr", ["-cr", payload]); // (com.apple.provenance stays; see the Payload rebuild below)

// ---------- 4. code signing ----------
log("Signing node (hardened runtime)");
run("codesign", ["--force", "--options", "runtime", "--timestamp", "--entitlements", join(PKG_SRC, "node.entitlements"), "--sign", APP_IDENTITY, nodeBin]);
run("codesign", ["--verify", "--strict", "--verbose=2", nodeBin]);
const sigInfo = capture("codesign", ["-dvv", nodeBin]);
if (!sigInfo.includes(`Authority=${APP_IDENTITY}`) || !/flags=.*runtime/.test(sigInfo) || !/Timestamp=/.test(sigInfo)) die(`unexpected signature:\n${sigInfo}`);

// ---------- 5. smoke test: both slices run the server under the hardened runtime ----------
log("Smoke-testing the signed node");
const sandboxHome = mkdtempSync(join(tmpdir(), "surehand-pkg-test-")); // the server writes under ~/.aemcp: keep it out of the real home
const testEnv = { ...process.env, HOME: sandboxHome, AEMCP_NO_AUTOSETUP: "1", AEMCP_NO_ACTIVITY_LOG: "1", AEMCP_NO_UPDATE_CHECK: "1" };
const toolsList =
  'import { spawn } from "node:child_process";' +
  "const p = spawn(process.execPath, [process.argv[1]], { stdio: ['pipe', 'pipe', 'inherit'] });" +
  "let buf = ''; const t = setTimeout(() => { console.error('timeout'); process.exit(1); }, 20000);" +
  "p.stdout.on('data', (d) => { buf += d; for (const l of buf.split('\\n')) { try { const m = JSON.parse(l); if (m.id === 2) { console.log(m.result.tools.length); clearTimeout(t); p.kill(); process.exit(0); } } catch {} } });" +
  "const send = (m) => p.stdin.write(JSON.stringify(m) + '\\n');" +
  "send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pkg-smoke', version: '1' } } });" +
  "send({ jsonrpc: '2.0', method: 'notifications/initialized' });" +
  "send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });";
const rosetta = spawnSync("arch", ["-x86_64", "/usr/bin/true"]).status === 0;
for (const arch of ["arm64", "x86_64"]) {
  if (arch === "x86_64" && process.arch !== "x64" && !rosetta) {
    console.log("x86_64: skipped (no Rosetta on this Mac)");
    continue;
  }
  const exec = (args) => capture("arch", [`-${arch}`, nodeBin, ...args], { env: testEnv, cwd: sandboxHome }).trim();
  const one = exec(["-e", "console.log(1 + 0, process.arch)"]);
  const ver = exec([join(payload, "server", "ae-mcp.mjs"), "--version"]);
  const tools = exec(["--input-type=module", "-e", toolsList, join(payload, "server", "ae-mcp.mjs")]);
  console.log(`${arch}: node -e -> "${one}", server --version -> ${ver}, MCP tools/list -> ${tools} tools`);
  if (!one.startsWith("1 ") || ver !== version || !(Number(tools) > 0)) die(`${arch}: smoke test failed`);
}
rmSync(sandboxHome, { recursive: true, force: true });

// ---------- 6. pkgbuild + productbuild ----------
log("Building the component package");
const componentName = `surehand-mcp-${version}-component.pkg`;
const component = join(BUILD, componentName);
run("pkgbuild", [
  "--root", payload,
  "--install-location", "/.aemcp", // in the home domain this is ~/.aemcp
  "--scripts", join(PKG_SRC, "scripts"),
  "--identifier", PKG_ID,
  "--version", version,
  component,
]);
// pkgbuild stores extended attributes as "._name" AppleDouble files in the payload, and macOS tags every file this
// process writes with com.apple.provenance (which cannot be removed). Installer would then drop ._node etc. into
// ~/.aemcp. So rebuild the Payload (gzipped odc cpio, root:wheel like pkgbuild's default ownership) and the Bom
// without them and re-flatten the component.
const expandedComponent = join(BUILD, "component-expanded");
run("pkgutil", ["--expand", component, expandedComponent]);
// pkgbuild's own Bom minus the ._ entries (lsbom output is mkbom -i input)
const bomList = capture("lsbom", [join(expandedComponent, "Bom")]).split("\n").filter((l) => l.trim() && !/(^|\/)\._/.test(l.split("\t")[0]));
writeFileSync(join(BUILD, "bom.txt"), bomList.join("\n") + "\n");
rmSync(join(expandedComponent, "Payload"));
rmSync(join(expandedComponent, "Bom"));
run("tar", ["-c", "-z", "--format", "odc", "--no-mac-metadata", "--no-xattrs", "--no-acls", "--uid", "0", "--gid", "0", "--uname", "root", "--gname", "wheel",
  "-f", join(expandedComponent, "Payload"), "-C", payload, "."]);
run("mkbom", ["-i", join(BUILD, "bom.txt"), join(expandedComponent, "Bom")]);
const bomEntries = capture("lsbom", ["-s", join(expandedComponent, "Bom")]).trim().split("\n");
const infoFile = join(expandedComponent, "PackageInfo");
const info = readFileSync(infoFile, "utf8");
if (!/numberOfFiles="\d+"/.test(info)) die("PackageInfo has no payload numberOfFiles");
writeFileSync(infoFile, info.replace(/numberOfFiles="\d+"/, `numberOfFiles="${bomEntries.length}"`));
rmSync(component);
run("pkgutil", ["--flatten", expandedComponent, component]);
rmSync(expandedComponent, { recursive: true, force: true });

log("Building the signed product archive");
const res = join(BUILD, "resources");
mkdirSync(res, { recursive: true });
for (const page of ["welcome.html", "conclusion.html"])
  writeFileSync(join(res, page), readFileSync(join(PKG_SRC, "resources", page), "utf8").replaceAll("@VERSION@", version));
for (const image of ["background-light.tiff", "background-dark.tiff"]) copyFileSync(join(PKG_SRC, "resources", image), join(res, image));
const dist = join(BUILD, "distribution.xml");
writeFileSync(dist, readFileSync(join(PKG_SRC, "distribution.xml"), "utf8").replaceAll("@VERSION@", version).replaceAll("@COMPONENT_PKG@", componentName));
mkdirSync(OUT_DIR, { recursive: true });
const pkg = join(OUT_DIR, `Surehand-MCP-${version}.pkg`);
rmSync(pkg, { force: true });
run("productbuild", ["--distribution", dist, "--resources", res, "--package-path", BUILD, "--sign", INSTALLER_IDENTITY, "--timestamp", pkg]);

// payload sanity: exactly the expected files, with the node binary signed as above
const files = capture("pkgutil", ["--payload-files", pkg]).trim().split("\n").sort();
const expected = [".", "./node", "./node/LICENSE", "./node/bin", "./node/bin/node", "./server", "./server/ae-mcp.mjs"];
if (files.join("\n") !== expected.join("\n")) die(`unexpected payload files:\n${files.join("\n")}`);
console.log(`payload (relative to ~/.aemcp): ${files.filter((f) => f !== ".").join("  ")}`);
// unpack the finished product and check the files came through byte-for-byte with the node signature intact
const unpacked = join(BUILD, "unpacked");
run("pkgutil", ["--expand-full", pkg, unpacked]);
const unpackedRoot = join(unpacked, componentName, "Payload");
for (const rel of ["node/bin/node", "node/LICENSE", "server/ae-mcp.mjs"])
  if (sha256(join(unpackedRoot, rel)) !== sha256(join(payload, rel))) die(`${rel} differs after unpacking the pkg`);
run("codesign", ["--verify", "--strict", join(unpackedRoot, "node", "bin", "node")]);
if (!existsSync(join(unpacked, componentName, "Scripts", "postinstall"))) die("postinstall script missing from the pkg");
rmSync(unpacked, { recursive: true, force: true });

if (flag("--no-notarize")) {
  verifyPkg(pkg, false);
  console.log(`\nBuilt (signed, NOT notarized): ${pkg} (${mb(pkg)})\nNotarize later with: npm run package:mac-pkg -- --notarize-only ${pkg}`);
} else {
  notarize(pkg);
  console.log(`\nDone (signed, notarized, stapled): ${pkg} (${mb(pkg)})`);
}
