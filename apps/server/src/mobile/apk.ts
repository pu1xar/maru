import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type { MobileApkInfo } from "@maru/shared";

/**
 * The APKs apps/mobile/scripts/build-apk.sh builds on this Mac (DESIGN.md 2d), kept outside the
 * releases in <mobile dir>/apk with latest.json naming the newest. The web settings' 기기 tab
 * offers it for download, so a phone signed in to maru in its browser can install it.
 */
export class MobileApks {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  latest(): MobileApkInfo | null {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(this.dir, "apk", "latest.json"), "utf8")) as MobileApkInfo;
      return path.basename(info.file) === info.file && info.file.endsWith(".apk") ? info : null;
    } catch {
      return null;
    }
  }

  /** The path of a built APK by its file name (no folder part), or null when it is gone. */
  fileOf(name: string): string | null {
    if (path.basename(name) !== name || !name.endsWith(".apk")) return null;
    const file = path.join(this.dir, "apk", name);
    return fs.existsSync(file) ? file : null;
  }

  /** `name` defaults to the newest APK; a one-time link names the file it was issued for. */
  send(res: http.ServerResponse, name?: string): void {
    const file = this.fileOf(name ?? this.latest()?.file ?? "");
    if (!file) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify({ error: "No built APK" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/vnd.android.package-archive",
      "content-length": fs.statSync(file).size,
      "content-disposition": `attachment; filename="${path.basename(file)}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    fs.createReadStream(file).pipe(res);
  }
}
