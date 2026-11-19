// The version of this page and of the server it talks to (DESIGN.md 2c). The page's is built in
// (vite.config.ts `define`); the server's comes in every /ws hello (serverVersion.ts). A page left
// open across a deploy keeps running its old code against the new server, so when the two differ
// the sidebar offers a reload (components/VersionNotice.tsx).
import { parseVersion } from "@maru/shared";

declare const __MARU_VERSION__: string | null;

/**
 * "0.1.N" in a release build, "0.1.N-dev" from a working tree, null when the build could not tell.
 * Also null where no build defined it (node tests).
 */
export const PAGE_VERSION: string | null = typeof __MARU_VERSION__ === "undefined" ? null : __MARU_VERSION__;

/** The version part of the last hello: absent from a server older than the field, null when unknown. */
export interface HelloVersion {
  version?: string | null;
}

/**
 * Whether a reload would bring another page: this page is a release build (a working tree's page
 * reloads into the same) and the server runs another version, or one from before versions.
 */
export function reloadSuggested(page: string | null, hello: HelloVersion | null): boolean {
  if (!hello || !page || parseVersion(page)?.dev !== false) return false;
  if (!("version" in hello)) return true;
  return typeof hello.version === "string" && hello.version !== page;
}
