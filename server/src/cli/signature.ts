// Checks the After Effects extension's signature (META-INF/signatures.xml, made by Adobe's
// ZXPSignCmd) against the files: every file must be listed with a matching SHA-256 digest.
// After Effects refuses to load a signed extension whose files changed, so this catches it early.
// (The certificate itself is self-signed: After Effects only checks integrity, not the issuer.)
import { createHash } from "node:crypto";

export interface SignatureCheck {
  signed: boolean; // a signatures.xml exists
  ok: boolean; // signed and every file matches
  problems: string[];
}

export const SIGNATURE_FILE = "META-INF/signatures.xml";

/** `files` maps "path/in/extension" -> content (utf8 string or bytes). */
export function checkSignature(files: Record<string, string | Uint8Array>): SignatureCheck {
  const xml = files[SIGNATURE_FILE];
  if (xml === undefined) return { signed: false, ok: false, problems: ["not signed (no META-INF/signatures.xml)"] };
  const text = typeof xml === "string" ? xml : Buffer.from(xml).toString("utf8");
  const digests = new Map<string, string>();
  const manifest = /<Manifest Id="PackageContents">([\s\S]*?)<\/Manifest>/.exec(text)?.[1] ?? "";
  for (const m of manifest.matchAll(/<Reference URI="([^"]+)">[\s\S]*?<DigestValue>([^<]+)<\/DigestValue>/g)) digests.set(m[1], m[2]);
  const problems: string[] = [];
  if (!digests.size) problems.push("signatures.xml lists no files");
  for (const [rel, content] of Object.entries(files)) {
    if (rel === SIGNATURE_FILE) continue;
    const want = digests.get(rel);
    if (!want) problems.push(`${rel} is not covered by the signature`);
    else if (createHash("sha256").update(content).digest("base64") !== want) problems.push(`${rel} changed since it was signed`);
    digests.delete(rel);
  }
  for (const rel of digests.keys()) problems.push(`${rel} is missing`);
  return { signed: true, ok: problems.length === 0, problems };
}
