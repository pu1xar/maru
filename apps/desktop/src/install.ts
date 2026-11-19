// Putting a downloaded, verified shell build in place (DESIGN.md 2e).
//
// Mac: Squirrel.Mac (electron-updater's Mac path) accepts only an update whose code signature
// matches the running app's designated requirement, which an ad-hoc signed app (no Apple Developer
// ID) never does: its requirement is its own code hash. So the app replaces its bundle itself. It
// unpacks the zip next to its own data, then a small shell script waits for the app to exit, swaps
// the bundle, and opens the new one. The file was written by this app, not downloaded by a
// browser, so it carries no quarantine flag and Gatekeeper does not stop it.
//
// Windows: the NSIS installer, run as electron-updater runs it (`--updated /S`, `--force-run` to
// start the app afterwards). The installer is per user, so no elevation.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The .app folder the running Mac app is, from its executable (maru.app/Contents/MacOS/maru). */
export function macBundleOf(exe: string): string | null {
  const bundle = path.resolve(exe, "..", "..", "..");
  return bundle.endsWith(".app") ? bundle : null;
}

/** Why the app at `bundle` cannot replace itself, or null when it can. */
export function macInPlaceProblem(bundle: string | null, writable: (p: string) => boolean): string | null {
  if (!bundle) return "Cannot find the app bundle location";
  if (bundle.includes("/AppTranslocation/")) return "macOS opened the app from a temporary location. Move it to the Applications folder, then open it again";
  if (bundle.startsWith("/Volumes/")) return "The app is running from a disk image. Move it to the Applications folder, then open it again";
  if (!writable(path.dirname(bundle)) || !writable(bundle)) return `Cannot replace the app because ${path.dirname(bundle)} is not writable`;
  return null;
}

/**
 * The swap, as a shell script: $1 the app's pid, $2 the unpacked new bundle, $3 the bundle to
 * replace, $4 1 to open the new app afterwards, and after them the arguments for `open` (relaunch
 * options, the bundle, `--args`). The old bundle is kept until the new one is in place, and comes
 * back if the copy fails.
 */
export const MAC_SWAP_SCRIPT = `#!/bin/sh
pid="$1"; new="$2"; target="$3"; relaunch="$4"; shift 4
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
old="$target.old-$$"
if mv "$target" "$old"; then
  if ditto "$new" "$target"; then
    rm -rf "$old" "$new"
    xattr -dr com.apple.quarantine "$target" 2>/dev/null
    echo "maru update: replaced $target"
  else
    rm -rf "$target"
    mv "$old" "$target"
    echo "maru update: copy failed, kept the old app" >&2
  fi
else
  echo "maru update: could not move $target aside" >&2
fi
if [ "$relaunch" = 1 ]; then open "$@"; fi
`;

/** Unpacks the verified zip into `stageDir` and returns the new bundle's path. */
export function macStage(zip: string, stageDir: string, appName: string): string {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  // ditto keeps the bundle's symlinks, modes and code signature, as Finder's unzip does.
  execFileSync("ditto", ["-x", "-k", zip, stageDir]);
  const bundle = path.join(stageDir, `${appName}.app`);
  if (!fs.existsSync(path.join(bundle, "Contents", "Info.plist"))) throw new Error(`${appName}.app is not in the zip`);
  return bundle;
}

/**
 * How the new app is opened after a swap: with the app's own MARU_DESKTOP_* settings and its option
 * arguments, as Electron's app.relaunch keeps argv. A maru:// link it was started with is left out
 * so the link does not run twice (T3 DesktopLifecycle drops app links on relaunch), and so are the
 * debugger's options. With MARU_DESKTOP_SHOW_INACTIVE the app opens without taking focus.
 */
export function macRelaunchArgs(target: string, argv: string[], env: Record<string, string | undefined>): string[] {
  const envArgs = Object.entries(env)
    .filter(([k, v]) => k.startsWith("MARU_DESKTOP_") && v !== undefined)
    .flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  const args = argv.filter((a) => a.startsWith("--") && !/^--(inspect|remote-debugging)/.test(a));
  return [...(env.MARU_DESKTOP_SHOW_INACTIVE ? ["-g"] : []), ...envArgs, target, ...(args.length ? ["--args", ...args] : [])];
}

/** Starts the swap script detached; the caller quits the app right after. */
export function macSwap(opts: { scriptDir: string; staged: string; target: string; relaunch: boolean; log: string }): void {
  const script = path.join(opts.scriptDir, "swap.sh");
  fs.writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o755 });
  const out = fs.openSync(opts.log, "a");
  const open = macRelaunchArgs(opts.target, process.argv.slice(1), process.env);
  spawn("/bin/sh", [script, String(process.pid), opts.staged, opts.target, opts.relaunch ? "1" : "0", ...open], {
    detached: true,
    stdio: ["ignore", out, out],
  }).unref();
}

/** The NSIS installer's arguments, as electron-updater's NsisUpdater passes them. */
export function nsisArgs(relaunch: boolean): string[] {
  return relaunch ? ["--updated", "/S", "--force-run"] : ["--updated", "/S"];
}

/** Starts the installer detached; throws when it is gone, so the caller reports it instead of quitting. */
export function windowsInstall(installer: string, relaunch: boolean, log: (line: string) => void): void {
  if (!fs.existsSync(installer)) throw new Error(`Installer not found: ${installer}`);
  const child = spawn(installer, nsisArgs(relaunch), { detached: true, stdio: "ignore" });
  // A spawn failure arrives as an event; unheard, it would end the main process as it quits.
  child.on("error", (e) => log(`update: the installer did not start: ${String(e)}`));
  child.unref();
}
