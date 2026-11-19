// How a typed folder name filters the subfolders of a folder (DESIGN.md 6z): names that start
// with it come first, names that only contain it follow, case is ignored. The server filters with
// this (`completeFolder`), and the clients rank what they already hold with the same function.

/** 0 when `name` starts with `prefix`, 1 when it only contains it, null when it does not match. An empty prefix matches everything. */
export function folderMatchRank(prefix: string, name: string): 0 | 1 | null {
  if (prefix === "") return 0;
  const at = name.toLowerCase().indexOf(prefix.toLowerCase());
  if (at < 0) return null;
  return at === 0 ? 0 : 1;
}

/**
 * The names that match `prefix`, starting-with matches first, each group in plain code-point
 * order. A name starting with a dot is listed only when `prefix` starts with a dot.
 */
export function filterFolderNames(prefix: string, names: readonly string[]): string[] {
  const starts: string[] = [];
  const contains: string[] = [];
  for (const name of names) {
    if (name.startsWith(".") && !prefix.startsWith(".")) continue;
    const rank = folderMatchRank(prefix, name);
    if (rank === 0) starts.push(name);
    else if (rank === 1) contains.push(name);
  }
  const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...starts.sort(byCode), ...contains.sort(byCode)];
}
