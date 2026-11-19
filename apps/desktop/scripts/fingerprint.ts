// The desktop shell's fingerprint (DESIGN.md 2e): one hash over everything that goes into a build,
// so release.sh rebuilds the app only when the shell changed (as host-fingerprint.ts does for the
// session host). Inputs, by path relative to apps/desktop:
//   dist-electron/**          the bundled code and local screens (bundle.ts output, no version or
//                             time in it), so only code the app runs counts, shared files included
//   package.json              Electron and electron-builder versions, the product name
//   scripts/builderConfig.ts  the electron-builder settings
//   resources/**              the icon
//   the update certificate    the key the app trusts (a new key is a new shell)
// The version is not an input: a build of an unchanged shell is the same shell.
//
//   node apps/desktop/scripts/fingerprint.ts [--cert <pem>] [--list]   (bundles first)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
  });
}

export function fingerprintInputs(appDir: string): string[] {
  return [
    ...walk(path.join(appDir, "dist-electron")),
    path.join(appDir, "package.json"),
    path.join(appDir, "scripts", "builderConfig.ts"),
    ...walk(path.join(appDir, "resources")),
  ].sort();
}

/** `v1-<sha256>` over each input's relative path and bytes, then the certificate. */
export function fingerprint(appDir: string, certificatePem: string): string {
  const h = crypto.createHash("sha256");
  for (const file of fingerprintInputs(appDir)) {
    const rel = path.relative(appDir, file).split(path.sep).join("/");
    h.update(`${rel}\0`);
    h.update(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    h.update("\n");
  }
  h.update(`certificate\0${crypto.createHash("sha256").update(certificatePem.trim()).digest("hex")}\n`);
  return `v1-${h.digest("hex")}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { APP_DIR, bundle } = await import("./bundle.ts");
  const { DEFAULT_CERT } = await import("./builderConfig.ts");
  const i = process.argv.indexOf("--cert");
  const cert = fs.readFileSync(i > 0 ? process.argv[i + 1]! : DEFAULT_CERT, "utf8");
  await bundle();
  if (process.argv.includes("--list")) for (const f of fingerprintInputs(APP_DIR)) console.log(path.relative(APP_DIR, f));
  console.log(fingerprint(APP_DIR, cert));
}
