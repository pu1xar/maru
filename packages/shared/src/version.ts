// maru's version (DESIGN.md 2c): "<series>.<N>", where N is the number of commits in the history
// of the released commit (`git rev-list --count <commit>`). One commit always gets one version, and
// a commit made on top of another gets a larger one. A build outside a release (a working tree, a
// dev server) carries "-dev": it names the commit the work started from.
// gitVersion.ts reads N from git; this file is pure so the web bundle can use it.

/** major.minor. Raised by hand in a commit when maru starts a new line (DESIGN.md 2c). */
export const VERSION_SERIES = "0.1";

export interface ParsedVersion {
  /** major.minor. */
  series: string;
  /** The commit count: the patch number, and the Android versionCode. */
  count: number;
  /** Built outside a release. */
  dev: boolean;
}

export function formatVersion(count: number, opts: { series?: string; dev?: boolean } = {}): string {
  return `${opts.series ?? VERSION_SERIES}.${count}${opts.dev ? "-dev" : ""}`;
}

export function parseVersion(value: string): ParsedVersion | null {
  const m = /^(\d+\.\d+)\.(\d+)(-dev)?$/.exec(value);
  return m ? { series: m[1]!, count: Number(m[2]), dev: m[3] !== undefined } : null;
}
