import assert from "node:assert/strict";
import test from "node:test";
import {
  isNewerVersion,
  latestReleaseUrl,
  parseLatestRelease,
  parseReleaseVersion,
  releaseCheckDue,
  releaseHeadline,
  releasesRepoOf,
  releaseTarget,
  releaseToOffer,
} from "./releaseCheck.logic.ts";

const release = {
  tag_name: "v0.1.60",
  html_url: "https://github.com/example/maru/releases/tag/v0.1.60",
  draft: false,
  prerelease: false,
  assets: [
    { name: "maru-0.1.60.apk.sha256", browser_download_url: "https://github.com/example/maru/releases/download/v0.1.60/maru-0.1.60.apk.sha256", size: 90 },
    { name: "maru-0.1.60.apk", browser_download_url: "https://github.com/example/maru/releases/download/v0.1.60/maru-0.1.60.apk", size: 70000000 },
  ],
};

test("versions parse with or without the tag's v and a dev suffix", () => {
  assert.deepEqual(parseReleaseVersion("0.1.52"), [0, 1, 52]);
  assert.deepEqual(parseReleaseVersion("v0.1.52"), [0, 1, 52]);
  assert.deepEqual(parseReleaseVersion("0.1.52-dev"), [0, 1, 52]);
  assert.equal(parseReleaseVersion("latest"), null);
  assert.equal(parseReleaseVersion("0.1"), null);
  assert.equal(parseReleaseVersion("0.1.x"), null);
});

test("newer is compared by number, not by text", () => {
  assert.equal(isNewerVersion("0.1.100", "0.1.99"), true);
  assert.equal(isNewerVersion("0.2.0", "0.1.999"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("v0.1.52", "0.1.52"), false);
  assert.equal(isNewerVersion("0.1.51", "0.1.52"), false);
  assert.equal(isNewerVersion("0.1.53", "0.1.52-dev"), true);
});

test("a version that does not parse is never offered", () => {
  assert.equal(isNewerVersion("nightly", "0.1.1"), false);
  assert.equal(isNewerVersion("0.1.2", "unknown"), false);
});

test("the releases repository comes from the APK's own config", () => {
  assert.equal(releasesRepoOf(JSON.stringify({ extra: { maruPush: false, maruReleasesRepo: "example/maru" } })), "example/maru");
  assert.equal(releasesRepoOf({ extra: { maruReleasesRepo: "example/maru" } }), "example/maru");
  assert.equal(releasesRepoOf({ extra: { maruPush: true } }), null);
  assert.equal(releasesRepoOf({ extra: { maruReleasesRepo: "no-slash" } }), null);
  assert.equal(releasesRepoOf({ extra: { maruReleasesRepo: "a/b/c" } }), null);
  assert.equal(releasesRepoOf({ extra: { maruReleasesRepo: "../x" } }), null);
  assert.equal(releasesRepoOf({ extra: { maruReleasesRepo: "x/.." } }), null);
  assert.equal(releasesRepoOf("{"), null);
  assert.equal(releasesRepoOf(null), null);
});

test("the endpoint is the repository's latest release", () => {
  assert.equal(latestReleaseUrl("example/maru"), "https://api.github.com/repos/example/maru/releases/latest");
});

test("a release response gives the version, page and the .apk asset", () => {
  assert.deepEqual(parseLatestRelease(release), {
    version: "0.1.60",
    pageUrl: "https://github.com/example/maru/releases/tag/v0.1.60",
    apkUrl: "https://github.com/example/maru/releases/download/v0.1.60/maru-0.1.60.apk",
    apkSize: 70000000,
  });
});

test("a release with no .apk asset falls back to its page", () => {
  const r = parseLatestRelease({ ...release, assets: [] })!;
  assert.equal(r.apkUrl, null);
  assert.equal(releaseTarget(r), release.html_url);
  assert.equal(releaseTarget(parseLatestRelease(release)!), release.assets[1]!.browser_download_url);
});

test("responses that are not usable releases are dropped", () => {
  assert.equal(parseLatestRelease(null), null);
  assert.equal(parseLatestRelease({ message: "Not Found" }), null);
  assert.equal(parseLatestRelease({ ...release, draft: true }), null);
  assert.equal(parseLatestRelease({ ...release, prerelease: true }), null);
  assert.equal(parseLatestRelease({ ...release, tag_name: "nightly" }), null);
  assert.equal(parseLatestRelease({ ...release, html_url: "javascript:alert(1)" }), null);
  assert.equal(parseLatestRelease({ ...release, html_url: undefined }), null);
});

test("only https asset addresses are kept", () => {
  const r = parseLatestRelease({ ...release, assets: [{ name: "x.apk", browser_download_url: "http://example.com/x.apk", size: 1 }] })!;
  assert.equal(r.apkUrl, null);
});

test("the release is offered only when newer than the installed APK", () => {
  const latest = parseLatestRelease(release);
  assert.equal(releaseToOffer(latest, "0.1.59")?.version, "0.1.60");
  assert.equal(releaseToOffer(latest, "0.1.60"), null);
  assert.equal(releaseToOffer(latest, "0.1.61"), null);
  assert.equal(releaseToOffer(latest, null), null);
  assert.equal(releaseToOffer(null, "0.1.1"), null);
  assert.equal(releaseHeadline(latest!), "maru 0.1.60 is available");
});

test("a foreground return checks again after a day", () => {
  assert.equal(releaseCheckDue(null, 1000), true);
  assert.equal(releaseCheckDue(0, 60 * 60 * 1000), false);
  assert.equal(releaseCheckDue(0, 24 * 60 * 60 * 1000), true);
});
