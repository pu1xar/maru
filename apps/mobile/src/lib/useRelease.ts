// The GitHub Releases notice (DESIGN.md 2d, public builds): a build made with MARU_RELEASES_REPO reads
// the repository's latest release when the app starts and again on a foreground return a day later,
// and offers the release's APK when it is newer than the installed one. A failed check is silent:
// the next foreground return tries again. One shared state, so the drawer and the settings sheet
// show the same release from a single request.
import { useEffect, useSyncExternalStore } from "react";
import { AppState, Linking } from "react-native";
import { requireOptionalNativeModule } from "expo";
import {
  latestReleaseUrl,
  parseLatestRelease,
  releaseCheckDue,
  releasesRepoOf,
  releaseTarget,
  releaseToOffer,
  type LatestRelease,
} from "./releaseCheck.logic.ts";
import { APP_VERSIONS } from "../version.ts";

/** The repository this APK watches, from its own app config; null for a build without MARU_RELEASES_REPO. */
export const RELEASES_REPO = releasesRepoOf(requireOptionalNativeModule<{ manifest?: unknown }>("ExponentConstants")?.manifest ?? null);

let offer: LatestRelease | null = null;
let lastCheckedAt: number | null = null;
let inFlight = false;
const listeners = new Set<() => void>();

function setOffer(next: LatestRelease | null): void {
  offer = next;
  for (const l of listeners) l();
}

async function check(repo: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await fetch(latestReleaseUrl(repo), { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return;
    setOffer(releaseToOffer(parseLatestRelease(await res.json()), APP_VERSIONS.apk));
    lastCheckedAt = Date.now();
  } catch {
    // Offline, rate limited or an unreadable answer: nothing to show, the next foreground tries again.
  } finally {
    inFlight = false;
  }
}

/** The newer release to offer, or null (also for every build without MARU_RELEASES_REPO). */
export function useRelease(): { release: LatestRelease | null; download: () => void } {
  const release = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    () => offer,
  );
  useEffect(() => {
    const repo = RELEASES_REPO;
    if (!repo) return;
    // The first mounted view checks at once (a start); foreground returns check when a day has passed.
    if (releaseCheckDue(lastCheckedAt, Date.now())) void check(repo);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && releaseCheckDue(lastCheckedAt, Date.now())) void check(repo);
    });
    return () => sub.remove();
  }, []);
  const download = () => {
    if (release) void Linking.openURL(releaseTarget(release)).catch(() => undefined);
  };
  return { release, download };
}
