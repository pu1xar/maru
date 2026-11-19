// The shell's self update (DESIGN.md 2e), after T3 Code's DesktopUpdates.ts: check 15 s after the
// start and every 4 hours, and when asked (menu, page). Unlike T3 the feed is the paired maru
// server, the manifest is checked against the certificate built into the app, and a newer build
// downloads at once. It installs only when the user restarts into it from the page or the menu;
// quitting leaves it staged.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, type Session } from "electron";
import type { DesktopArtifact, DesktopUpdateState } from "@maru/shared";
import { parseVersion } from "@maru/shared";
import { macBundleOf, macInPlaceProblem, macStage, macSwap, windowsInstall } from "./install.ts";
import type { Pairing } from "./pairingStore.ts";
import { BlockMapError, decodeBlockMap } from "./blockmap.ts";
import { DeltaError, deltaAssemble } from "./deltaDownload.ts";
import { ApiError, RangeNotHonored, download, fetchBlockMap, fetchRange, fetchUpdate } from "./serverApi.ts";
import { findBaseline, pruneUpdates } from "./updateFiles.ts";
import { initialModel, reduce, type UpdateEvent, type UpdateModel } from "./updateMachine.ts";
import { isNewer, updateArtifact, verifyManifest } from "./updateManifest.ts";

/** T3 Code's cadence (DesktopUpdates.ts). */
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
/** Progress goes to the page at most this often. */
const PROGRESS_EVERY_MS = 250;
/** A failed download is tried again after this, doubling up to the cap. */
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 15 * 60 * 1000;

/** A downloaded file that does not match the signed SHA-256: its bytes are not kept. */
class IntegrityError extends Error {}

async function sha256OfFile(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const b of fs.createReadStream(file)) hash.update(b as Buffer);
  return hash.digest("hex");
}

export interface UpdaterDeps {
  session: Session;
  pairing: () => Pairing | null;
  /** The update certificate (PEM) built into the app; null when the build has none. */
  certificate: string | null;
  /** userData/updates: downloads and the unpacked Mac bundle. */
  dir: string;
  version: string;
  log: (line: string) => void;
}

interface Ready {
  version: string;
  /** Mac: the unpacked bundle. Windows: the installer. */
  path: string;
}

export class Updater {
  private deps: UpdaterDeps;
  private model: UpdateModel;
  private listeners = new Set<(s: DesktopUpdateState) => void>();
  private running: Promise<DesktopUpdateState> | null = null;
  private ready: Ready | null = null;
  private installing = false;
  private retryMs = 0;
  private timers: NodeJS.Timeout[] = [];
  private bundle: string | null = process.platform === "darwin" ? macBundleOf(app.getPath("exe")) : null;

  constructor(deps: UpdaterDeps) {
    this.deps = deps;
    this.model = initialModel(this.disabledReason());
  }

  private disabledReason(): string | null {
    if (!app.isPackaged) return "Updates are skipped in development runs";
    const v = parseVersion(this.deps.version);
    if (!v || v.dev) return `Not a release build (${this.deps.version})`;
    if (process.platform !== "darwin" && process.platform !== "win32") return "Automatic updates are not supported on this OS";
    if (!this.deps.certificate) return "The app has no update certificate";
    if (process.platform === "darwin") {
      return macInPlaceProblem(this.bundle, (p) => {
        try {
          fs.accessSync(p, fs.constants.W_OK);
          return true;
        } catch {
          return false;
        }
      });
    }
    return null;
  }

  state(): DesktopUpdateState {
    return this.model.state;
  }

  onState(fn: (s: DesktopUpdateState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private dispatch(e: UpdateEvent): void {
    const next = reduce(this.model, e);
    if (next === this.model) return;
    this.model = next;
    for (const fn of this.listeners) fn(next.state);
  }

  start(): void {
    if (this.model.state.status === "disabled") {
      this.deps.log(`update: disabled (${this.model.state.reason})`);
      return;
    }
    this.timers.push(setTimeout(() => void this.check(), FIRST_CHECK_MS));
    this.timers.push(setInterval(() => void this.check(), CHECK_EVERY_MS));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** One check at a time; a second call while one runs gets the same answer. */
  check(): Promise<DesktopUpdateState> {
    if (this.model.state.status === "disabled") return Promise.resolve(this.model.state);
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<DesktopUpdateState> {
    const pairing = this.deps.pairing();
    if (!pairing) return this.model.state;
    this.dispatch({ type: "check-start" });
    let manifest;
    try {
      const res = await fetchUpdate(this.deps.session, pairing);
      if (!res) {
        this.dispatch({ type: "no-update", at: Date.now() });
        return this.model.state;
      }
      manifest = verifyManifest(res.manifest, res.signature, this.deps.certificate!);
    } catch (e) {
      this.deps.log(`update: check failed: ${String(e)}`);
      this.dispatch({ type: "check-failed", message: e instanceof Error ? e.message : String(e), at: Date.now() });
      return this.model.state;
    }
    const artifact = updateArtifact(manifest, process.platform, process.arch);
    if (!artifact || !isNewer(manifest.version, this.deps.version) || this.ready?.version === manifest.version) {
      this.deps.log(`update: none (server ${manifest.version}, this ${this.deps.version}, ${artifact ? artifact.file : `no ${process.platform}-${process.arch} file`})`);
      this.dispatch({ type: "no-update", at: Date.now() });
      return this.model.state;
    }
    this.deps.log(`update: downloading ${artifact.file} (${manifest.version})`);
    this.dispatch({ type: "download-start", version: manifest.version, total: artifact.size });
    const dir = path.join(this.deps.dir, manifest.version);
    const file = path.join(dir, artifact.file);
    const partial = `${file}.partial`;
    try {
      // A newer build replaces one downloaded earlier: its files go, and so does the record of it.
      // The running build's folder stays (its update file is the baseline for a differential
      // download), and so does this version's own folder (a partial file there resumes).
      this.ready = null;
      this.model = { ...this.model, downloaded: null };
      pruneUpdates(this.deps.dir, [this.deps.version, manifest.version]);
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(file) && (await sha256OfFile(file)) === artifact.sha256) {
        this.deps.log(`update: ${artifact.file} was already downloaded`);
      } else {
        fs.rmSync(file, { force: true });
        await this.fetchFile(pairing, artifact, partial);
        fs.renameSync(partial, file);
      }
      const ready = process.platform === "darwin" ? macStage(file, path.join(dir, "stage"), app.getName()) : file;
      this.ready = { version: manifest.version, path: ready };
      this.retryMs = 0;
      this.deps.log(`update: ${manifest.version} ready at ${ready}`);
      this.dispatch({ type: "downloaded", version: manifest.version });
    } catch (e) {
      this.deps.log(`update: download failed: ${String(e)}`);
      // Bytes that were received stay for the next attempt; a file that failed its check does not.
      if (e instanceof IntegrityError) fs.rmSync(partial, { force: true });
      fs.rmSync(path.join(dir, "stage"), { recursive: true, force: true });
      this.dispatch({ type: "download-failed", message: e instanceof Error ? e.message : String(e), at: Date.now() });
      if (!(e instanceof IntegrityError)) this.scheduleRetry();
    }
    return this.model.state;
  }

  /** A failed download is tried again soon (30 s, doubling to 15 min), continuing what was received. */
  private scheduleRetry(): void {
    this.retryMs = Math.min(this.retryMs === 0 ? RETRY_FIRST_MS : this.retryMs * 2, RETRY_MAX_MS);
    this.deps.log(`update: trying again in ${this.retryMs / 1000} s`);
    this.timers.push(setTimeout(() => void this.check(), this.retryMs));
  }

  /**
   * Gets `artifact` into `partial` and checks it against the signed SHA-256. With a block map and
   * a baseline only the changed blocks are fetched (deltaDownload.ts). When that path fails for a
   * reason of its own (a block or the assembled file does not match the signed values, the server
   * does not do ranges, no block map there) the whole file is downloaded the plain way; a network
   * failure is thrown, since the plain way would meet it too.
   */
  private async fetchFile(pairing: Pairing, artifact: DesktopArtifact, partial: string): Promise<void> {
    let last = 0;
    const progress = (received: number, total: number) => {
      const now = Date.now();
      if (now - last < PROGRESS_EVERY_MS && received < total) return;
      last = now;
      this.dispatch({ type: "download-progress", received });
    };
    if (artifact.blockmap) {
      const t0 = Date.now();
      try {
        const map = decodeBlockMap(await fetchBlockMap(this.deps.session, pairing, artifact.blockmap), artifact.size);
        const baseline = findBaseline(this.deps.dir, this.deps.version, path.extname(artifact.file));
        const result = await deltaAssemble({
          map, size: artifact.size, sha256: artifact.sha256, partial, baseline,
          fetchRange: (start, end) => fetchRange(this.deps.session, pairing, artifact.file, artifact.size, artifact.sha256, start, end),
          onPlan: (plan) => {
            this.deps.log(`update: differential, ${plan.toFetch} of ${artifact.size} bytes to fetch in ${plan.ranges} ranges `
              + `(${plan.reused} from ${baseline ? path.basename(baseline) : "no baseline"}, ${plan.resumed} already received)`);
            this.dispatch({ type: "download-total", total: plan.toFetch });
          },
          onProgress: (fetched) => progress(fetched, Number.MAX_SAFE_INTEGER),
        });
        this.deps.log(`update: assembled ${artifact.file}, fetched ${result.fetched} bytes in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        return;
      } catch (e) {
        const own = e instanceof DeltaError || e instanceof BlockMapError || e instanceof RangeNotHonored || (e instanceof ApiError && e.status === 404);
        if (!own) throw e;
        this.deps.log(`update: the differential download failed (${String(e)}); downloading the whole file`);
        fs.rmSync(partial, { force: true });
        this.dispatch({ type: "download-total", total: artifact.size });
      }
    }
    const sha = await download(this.deps.session, pairing, artifact.file, artifact.size, artifact.sha256, partial, (received) => progress(received, artifact.size));
    if (sha !== artifact.sha256) throw new IntegrityError("The SHA-256 of the downloaded file differs from the signed value");
  }

  hasDownloaded(): boolean {
    return this.ready !== null && !this.installing;
  }

  /**
   * Hands the downloaded build to the installer and returns true when the app should quit now.
   * `relaunch`: open the new build afterwards (a restart); false when the app is quitting anyway.
   */
  install(relaunch: boolean): boolean {
    const ready = this.ready;
    if (!ready || this.installing) return false;
    try {
      if (process.platform === "darwin") {
        macSwap({ scriptDir: this.deps.dir, staged: ready.path, target: this.bundle!, relaunch, log: path.join(this.deps.dir, "swap.log") });
      } else {
        windowsInstall(ready.path, relaunch, this.deps.log);
      }
      this.installing = true;
      this.deps.log(`update: installing ${ready.version}${relaunch ? " and restarting" : " on quit"}`);
      return true;
    } catch (e) {
      this.dispatch({ type: "install-failed", message: e instanceof Error ? e.message : String(e), at: Date.now() });
      return false;
    }
  }
}
