// Signs the After Effects extension with Adobe's ZXPSignCmd and stores the result in
// extension/ (META-INF/signatures.xml + mimetype), so it ships inside the build.
// A signed extension loads without PlayerDebugMode ("unsigned extensions") on macOS and Windows.
//
// Re-run after changing anything in extension/ or bumping the version (the version is stamped
// into the extension files); `npm test` fails while the signature is out of date.
//
//   npm run sign
//
// Needs (outside the repo, never committed):
//   ~/.aemcp-signing/aemcp-extension.p12           self-signed certificate (ZXPSignCmd -selfSignedCert)
//   ~/.aemcp-signing/aemcp-extension.p12.password  its password
//   ZXPSignCmd from https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD
// Override with AEMCP_SIGN_DIR / AEMCP_ZXPSIGNCMD.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CEP_ROOT, SIGNATURE_FILES, readCepFiles } from "./cep-files.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const signDir = process.env.AEMCP_SIGN_DIR || join(homedir(), ".aemcp-signing");
const tool = process.env.AEMCP_ZXPSIGNCMD || join(signDir, "zxpsigncmd-4.1.3", process.platform === "win32" ? "ZXPSignCmd.exe" : "ZXPSignCmd");
const p12 = join(signDir, "aemcp-extension.p12");
const passwordFile = p12 + ".password";
for (const f of [tool, p12, passwordFile]) if (!existsSync(f)) throw new Error(`missing ${f} (see the comment at the top of this script)`);

const work = mkdtempSync(join(tmpdir(), "aemcp-sign-"));
try {
  // stage exactly the files that get installed (version stamped), minus the old signature
  const stage = join(work, "com.aemcp");
  for (const [rel, content] of Object.entries(readCepFiles(pkg.version))) {
    if (SIGNATURE_FILES.includes(rel)) continue;
    const p = join(stage, ...rel.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  const zxp = join(work, "com.aemcp.zxp");
  const password = readFileSync(passwordFile, "utf8").trim();
  const run = (args) => {
    const r = spawnSync(tool, args, { encoding: "utf8" });
    if (r.status !== 0 || /error/i.test(r.stdout)) throw new Error(`ZXPSignCmd ${args[0]} failed: ${(r.stdout + r.stderr).trim()}`);
    return r.stdout.trim();
  };
  run(["-sign", stage, zxp, p12, password, "-tsa", "http://timestamp.digicert.com"]);

  const out = join(work, "out");
  mkdirSync(out);
  const unzip = spawnSync("unzip", ["-q", zxp, "-d", out]);
  if (unzip.status !== 0) throw new Error("could not unpack the signed .zxp (needs `unzip`)");
  console.log(run(["-verify", out]));
  for (const rel of SIGNATURE_FILES) {
    const p = join(CEP_ROOT, ...rel.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, readFileSync(join(out, ...rel.split("/"))));
  }
  console.log(`signed the After Effects extension for v${pkg.version} -> extension/${SIGNATURE_FILES.join(", extension/")}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
