// The repository a public Android build watches for new versions (MARU_RELEASES_REPO, DESIGN.md 2d).
// Kept here, outside apps/mobile, so apps/mobile/app.config.ts can check the value without importing
// a file of the app: Expo hashes every app file that the config imports into the native fingerprint
// (the runtime version).

/** `owner/repo` as the host spells it; "." and ".." segments are not names. */
export function isReleasesRepo(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}
