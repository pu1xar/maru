// The new-version check of builds that take their APK from GitHub Releases (DESIGN.md 2d, public
// builds). A build made with MARU_RELEASES_REPO carries that repository in its app config
// (`extra.maruReleasesRepo`); the app reads the repository's latest release and offers its APK when
// the release is newer than the installed one. React Native-free, so node tests run it.

import { isReleasesRepo } from "../../../../packages/shared/src/releasesRepo.ts";

/**
 * The repository the APK was built to watch: `extra.maruReleasesRepo` of the APK's own app config
 * (expo-constants' native manifest, a JSON string on Android). Null for a build without one, which
 * keeps the server-driven install notice (apkUpdate.logic.ts).
 */
export function releasesRepoOf(apkConfig: unknown): string | null {
  let config = apkConfig;
  if (typeof config === "string") {
    try {
      config = JSON.parse(config);
    } catch {
      return null;
    }
  }
  const extra = config && typeof config === "object" ? (config as { extra?: unknown }).extra : null;
  const repo = extra && typeof extra === "object" ? (extra as { maruReleasesRepo?: unknown }).maruReleasesRepo : null;
  return isReleasesRepo(repo) ? repo : null;
}

/** GitHub's "latest release" endpoint (it leaves out drafts and prereleases). */
export function latestReleaseUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

/** `[major, minor, patch]` of "0.1.52", "v0.1.52" or "0.1.52-dev"; null for anything else. */
export function parseReleaseVersion(value: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `candidate` is a higher version than `installed`; false when either does not parse. */
export function isNewerVersion(candidate: string, installed: string): boolean {
  const a = parseReleaseVersion(candidate);
  const b = parseReleaseVersion(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

export interface LatestRelease {
  /** The version without the tag's leading "v". */
  version: string;
  /** The release page. */
  pageUrl: string;
  /** The `.apk` asset's download address; null when the release has none. */
  apkUrl: string | null;
  apkSize: number | null;
}

function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

/** The fields the app reads from a GitHub "latest release" response; null when it is not a usable release. */
export function parseLatestRelease(json: unknown): LatestRelease | null {
  if (!json || typeof json !== "object") return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  if (typeof r.tag_name !== "string" || !parseReleaseVersion(r.tag_name)) return null;
  const pageUrl = httpsUrl(r.html_url);
  if (!pageUrl) return null;
  const assets = Array.isArray(r.assets) ? r.assets : [];
  let apkUrl: string | null = null;
  let apkSize: number | null = null;
  for (const a of assets) {
    if (!a || typeof a !== "object") continue;
    const asset = a as Record<string, unknown>;
    const url = httpsUrl(asset.browser_download_url);
    if (typeof asset.name === "string" && asset.name.toLowerCase().endsWith(".apk") && url) {
      apkUrl = url;
      apkSize = typeof asset.size === "number" && asset.size > 0 ? asset.size : null;
      break;
    }
  }
  return { version: r.tag_name.trim().replace(/^v/, ""), pageUrl, apkUrl, apkSize };
}

/** The release to offer: the latest one when it is newer than the installed APK's version. */
export function releaseToOffer(release: LatestRelease | null, installedVersion: string | null): LatestRelease | null {
  if (!release || !installedVersion) return null;
  return isNewerVersion(release.version, installedVersion) ? release : null;
}

/** What the Download button opens: the APK, or the release page when the release has no APK. */
export function releaseTarget(release: LatestRelease): string {
  return release.apkUrl ?? release.pageUrl;
}

/** The notice's headline. */
export function releaseHeadline(release: LatestRelease): string {
  return `maru ${release.version} is available`;
}

/** A day between checks while the app stays open; a start always checks. */
export const RELEASE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Whether a foreground return should check again: never checked, or a full interval ago. */
export function releaseCheckDue(lastCheckedAt: number | null, now: number): boolean {
  return lastCheckedAt === null || now - lastCheckedAt >= RELEASE_CHECK_INTERVAL_MS;
}
