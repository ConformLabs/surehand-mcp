// Authenticode-signs a Windows file (.exe, .dll, .ps1...) in place, from the Mac, with the Certum
// cloud code signing certificate (SimplySign). Used by `npm run package:win-installer -- --sign`.
//
//   node scripts/sign-win.mjs <file>      sign <file> in place (sha256 + Certum timestamp)
//   node scripts/sign-win.mjs --check     only check that the certificate is reachable
//
// Needs (Homebrew): osslsigncode, libp11 (pkcs11prov provider), opensc (pkcs11-tool), and SimplySign
// Desktop running and logged in (one-time code from the SimplySign phone app; only the owner can do it).
// Override paths with AEMCP_PKCS11_MODULE / AEMCP_PKCS11_PROVIDER / AEMCP_SIGN_CERT_ID.
import { spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";

const MODULE = process.env.AEMCP_PKCS11_MODULE || "/usr/local/lib/libSimplySignPKCS.dylib";
const PROVIDER = process.env.AEMCP_PKCS11_PROVIDER || "/opt/homebrew/lib/ossl-modules/pkcs11prov.dylib";
// key/cert id on the "Code Signing" token (public identifier, not a secret)
const CERT_ID = (process.env.AEMCP_SIGN_CERT_ID || "27C215D87BFD5776D5C750EF7AC3C4F074DCAD8C").toLowerCase();
const TIMESTAMP = "http://time.certum.pl";
const NAME = "Surehand MCP";
const URL = "https://github.com/ConformLabs/surehand-mcp";

const die = (msg) => {
  console.error(`sign-win: ${msg}`);
  process.exit(1);
};

function checkCertificate() {
  for (const tool of ["osslsigncode", "pkcs11-tool"])
    if (spawnSync("which", [tool]).status !== 0) die(`${tool} not found (brew install osslsigncode libp11 opensc)`);
  if (!existsSync(PROVIDER)) die(`missing ${PROVIDER} (brew install libp11)`);
  if (!existsSync(MODULE)) die(`missing ${MODULE} (install SimplySign Desktop)`);
  const r = spawnSync("pkcs11-tool", ["--module", MODULE, "--list-objects", "--type", "cert"], { encoding: "utf8", timeout: 60_000 });
  // newer pkcs11-tool prints the id as "27:c2:15:...", older ones as "27C215..."
  const ids = [...`${r.stdout}`.matchAll(/^\s*ID:\s*([0-9a-f:]+)/gim)].map((m) => m[1].replace(/:/g, "").toLowerCase());
  if (r.status !== 0 || !ids.includes(CERT_ID)) die("the code signing certificate is not available. Log in to SimplySign Desktop first.");
}

const pctId = CERT_ID.match(/../g).map((b) => `%${b.toUpperCase()}`).join("");
const uri = (type) => `pkcs11:token=Code%20Signing;id=${pctId};type=${type}`;

const args = process.argv.slice(2);
checkCertificate();
if (args[0] === "--check") {
  console.log("sign-win: certificate available");
  process.exit(0);
}
const file = args[0];
if (!file || !existsSync(file)) die(`usage: node sign-win.mjs <file> | --check`);

const out = `${file}.signing-${process.pid}`;
rmSync(out, { force: true });
const r = spawnSync(
  "osslsigncode",
  ["sign", "-provider", PROVIDER, "-pkcs11module", MODULE, "-pkcs11cert", uri("cert"), "-key", uri("private"),
    "-h", "sha256", "-ts", TIMESTAMP, "-n", NAME, "-i", URL, "-in", file, "-out", out],
  { stdio: "inherit", timeout: 300_000 },
);
if (r.status !== 0 || !existsSync(out)) {
  rmSync(out, { force: true });
  die(`osslsigncode failed for ${file}`);
}
renameSync(out, file);
console.log(`sign-win: signed ${file}`);
