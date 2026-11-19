import assert from "node:assert/strict";
import { test } from "node:test";

import type { FileTreeEntry } from "@maru/shared";
import {
  applyListing,
  buildTreeRows,
  compareTreeEntries,
  expandableFolders,
  foldersToLoad,
  normalizeFilePath,
  normalizeTreeQuery,
  openSingleChild,
  pruneExpanded,
  rowFolders,
  storedExpansionFor,
  treeAbsolutePath,
  treeAncestors,
  treeKeyAction,
  treeRelativePath,
  treeRowIndex,
  withStoredExpansion,
  type Listings,
} from "./fileTree.ts";

const dir = (name: string, extra: Partial<FileTreeEntry> = {}): FileTreeEntry => ({ name, kind: "directory", ...extra });
const file = (name: string, extra: Partial<FileTreeEntry> = {}): FileTreeEntry => ({ name, kind: "file", ...extra });

/** Listings from `{ dir: [entries] }`, each applied like a server answer. */
function listings(spec: Record<string, FileTreeEntry[]>): Listings {
  let out: Listings = new Map();
  for (const [d, entries] of Object.entries(spec)) out = applyListing(out, d, entries).listings;
  return out;
}

function rowsOf(l: Listings, expanded: string[] = [], query = "", loading: string[] = []) {
  return buildTreeRows({ listings: l, expanded: new Set(expanded), loading: new Set(loading), query: normalizeTreeQuery(query) });
}

const show = (rows: { depth: number; name: string; kind: string; expanded: boolean }[]) =>
  rows.map((r) => `${"  ".repeat(r.depth)}${r.kind === "directory" ? (r.expanded ? "v " : "> ") : ""}${r.name}`);

test("children sort folders first, then dot names, then names ignoring case (Pierre)", () => {
  const sorted = [file("b.ts"), file(".env"), dir("src"), file("A.md"), dir(".github"), file("a.ts")].sort(compareTreeEntries);
  assert.deepEqual(sorted.map((e) => e.name), [".github", "src", ".env", "A.md", "a.ts", "b.ts"]);
});

test("open folders show their children below them, closed ones do not", () => {
  const l = listings({ "": [file("README.md"), dir("src"), dir("docs")], src: [file("main.ts"), dir("lib")], docs: [file("a.md")] });
  assert.deepEqual(show(rowsOf(l, ["src"]).rows), ["> docs", "v src", "  > lib", "  main.ts", "README.md"]);
  // An open folder not read yet is open with no rows under it, and loads.
  const r = rowsOf(l, ["src", "src/lib"], "", ["src/lib"]).rows;
  const lib = r.find((x) => x.path === "src/lib")!;
  assert.equal(lib.expanded, true);
  assert.equal(lib.loading, true);
  assert.deepEqual(foldersToLoad(r, l, new Set(["src/lib"]), new Set()), [], "being read already");
  assert.deepEqual(foldersToLoad(rowsOf(l, ["src", "src/lib"]).rows, l, new Set(), new Set()), ["src/lib"]);
  assert.deepEqual(foldersToLoad(rowsOf(l, ["src", "src/lib"]).rows, l, new Set(), new Set(["src/lib"])), [], "a failed read waits for a retry");
  // An open folder under a closed one is not on screen and does not load.
  assert.deepEqual(foldersToLoad(rowsOf(l, ["src/lib"]).rows, l, new Set(), new Set()), []);
});

test("a chain of folders that each hold one folder is one row, and the row stands for the last folder", () => {
  const l = listings({ "": [dir("a"), file("z.txt")], a: [dir("b")], "a/b": [dir("c")], "a/b/c": [file("x.ts"), file("y.ts")] });
  const closed = rowsOf(l, ["a"]).rows;
  assert.deepEqual(show(closed), ["> a / b / c", "z.txt"]);
  assert.equal(closed[0]!.path, "a/b/c");
  assert.deepEqual(closed[0]!.segments?.map((s) => s.path), ["a", "a/b", "a/b/c"]);
  assert.deepEqual(show(rowsOf(l, ["a/b/c"]).rows), ["v a / b / c", "  x.ts", "  y.ts", "z.txt"]);
  // Any folder of the chain finds the row.
  assert.equal(treeRowIndex(closed, "a/b"), 0);
  assert.equal(treeRowIndex(closed, "z.txt"), 1);
  assert.equal(treeRowIndex(closed, "nope"), -1);
  // A folder not read yet ends the chain; a second child breaks it.
  assert.deepEqual(show(rowsOf(listings({ "": [dir("a")], a: [dir("b")] })).rows), ["> a / b"]);
  assert.deepEqual(show(rowsOf(listings({ "": [dir("a")], a: [dir("b"), file("f")] }), ["a"]).rows), ["v a", "  > b", "  f"]);
});

test("opening a folder whose first listing is one folder opens that folder too", () => {
  const children = applyListing(new Map(), "a", [dir("b")]).listings.get("a")!;
  const next = openSingleChild(new Set(["a"]), "a", children);
  assert.deepEqual([...next], ["a", "a/b"]);
  assert.equal(openSingleChild(new Set(), "a", children).size, 0, "only an open folder");
  const two = applyListing(new Map(), "a", [dir("b"), file("c")]).listings.get("a")!;
  const same = new Set(["a"]);
  assert.equal(openSingleChild(same, "a", two), same);
});

test("a row is ignored when git ignores it or a folder above it", () => {
  const l = listings({ "": [dir("node_modules", { ignored: true }), file("a.log", { ignored: true }), file("a.ts")], node_modules: [dir("react"), file(".package-lock.json")] });
  const rows = rowsOf(l, ["node_modules"]).rows;
  assert.deepEqual(rows.map((r) => [r.path, r.ignored]), [
    ["node_modules", true],
    ["node_modules/react", true],
    ["node_modules/.package-lock.json", true],
    ["a.log", true],
    ["a.ts", false],
  ]);
});

test("search shows matches and the folders above them, opens them, and counts matches", () => {
  const l = listings({
    "": [dir("src"), dir("docs"), file("README.md")],
    src: [dir("components"), file("main.ts")],
    "src/components": [file("Button.tsx"), file("Card.tsx")],
    docs: [file("guide.md")],
  });
  const r = rowsOf(l, [], " BUTTON ");
  assert.equal(r.matchCount, 1);
  assert.deepEqual(show(r.rows), ["v src", "  v components", "    Button.tsx"]);
  assert.deepEqual(r.rows.map((x) => x.match), [false, false, true]);
  // The path counts, so a folder name matches its whole subtree's paths.
  assert.equal(rowsOf(l, [], "docs").matchCount, 2);
  // A matching folder shows open but its other children stay hidden.
  assert.deepEqual(show(rowsOf(l, [], "components").rows), ["v src", "  v components", "    Button.tsx", "    Card.tsx"]);
  assert.deepEqual(rowsOf(l, [], "zzz"), { rows: [], matchCount: 0 });
  // A backslash reads as a slash.
  assert.equal(rowsOf(l, [], "src\\main").matchCount, 1);
});

test("a new listing drops the folders under it that are gone", () => {
  let l = listings({ "": [dir("a"), dir("b")], a: [dir("x")], "a/x": [file("f")], b: [file("g")] });
  const result = applyListing(l, "", [dir("b"), file("new")]);
  l = result.listings;
  assert.deepEqual([...l.keys()].sort(), ["", "b"]);
  assert.deepEqual(result.removed.sort(), ["a", "a/x"]);
  // A folder that turned into a file is dropped too.
  const again = applyListing(l, "", [file("b")]);
  assert.deepEqual(again.removed, ["b"]);
});

test("expanded folders whose parent no longer lists them are dropped; unknown ones are kept", () => {
  const l = listings({ "": [dir("a")], a: [file("x")] });
  const expanded = new Set(["a", "gone", "a/x", "far/away"]);
  assert.deepEqual([...pruneExpanded(expanded, l)].sort(), ["a", "far/away"]);
  const kept = new Set(["a"]);
  assert.equal(pruneExpanded(kept, l), kept);
});

test("expand all opens listed folders except ignored ones, their contents and links, inside a repository only", () => {
  const l = listings({
    "": [dir("src"), dir("node_modules", { ignored: true }), dir("linked", { link: true }), dir("vendor")],
    src: [dir("lib")],
    node_modules: [dir("react", { ignored: true })],
    vendor: [dir("pkg")],
  });
  assert.deepEqual(expandableFolders(l, new Set(["", "src", "node_modules", "vendor"])), ["src", "src/lib", "vendor", "vendor/pkg"]);
  // A listing without ignore labels (outside a repository) opens nothing below it.
  assert.deepEqual(expandableFolders(l, new Set(["", "src"])), ["src", "src/lib", "vendor"]);
  assert.deepEqual(expandableFolders(l, new Set()), []);
});

test("row keys move focus, open and close folders, and go to the parent (Pierre)", () => {
  const l = listings({ "": [dir("src"), file("a.ts")], src: [file("main.ts")] });
  const rows = rowsOf(l, ["src"]).rows;
  assert.deepEqual(treeKeyAction(rows, null, "ArrowDown"), { focus: "src" });
  assert.deepEqual(treeKeyAction(rows, "src", "ArrowDown"), { focus: "src/main.ts" });
  assert.deepEqual(treeKeyAction(rows, "a.ts", "ArrowDown"), { focus: "a.ts" });
  assert.deepEqual(treeKeyAction(rows, "src", "ArrowUp"), { focus: "src" });
  assert.deepEqual(treeKeyAction(rows, "src", "ArrowLeft"), { collapse: "src" });
  assert.deepEqual(treeKeyAction(rows, "src/main.ts", "ArrowLeft"), { focus: "src" });
  assert.equal(treeKeyAction(rows, "a.ts", "ArrowLeft"), null);
  assert.deepEqual(treeKeyAction(rows, "src", "ArrowRight"), { focus: "src/main.ts" });
  assert.deepEqual(treeKeyAction(rowsOf(l).rows, "src", "ArrowRight"), { expand: "src" });
  assert.deepEqual(treeKeyAction(rows, "src/main.ts", "End"), { focus: "a.ts" });
  assert.deepEqual(treeKeyAction(rows, "a.ts", "Home"), { focus: "src" });
  assert.equal(treeKeyAction(rows, "a.ts", "PageDown"), null);
  assert.equal(treeKeyAction([], null, "ArrowDown"), null);
});

test("open folders are stored per root, the last written root first, and bad values read as none", () => {
  assert.deepEqual(storedExpansionFor(null, "/r"), []);
  assert.deepEqual(storedExpansionFor([{ root: "/r", paths: [1] }], "/r"), []);
  const one = withStoredExpansion(null, "/a", ["src"]);
  const two = withStoredExpansion(one, "/b", ["x", "x/y"]);
  assert.deepEqual(two, [{ root: "/b", paths: ["x", "x/y"] }, { root: "/a", paths: ["src"] }]);
  assert.deepEqual(storedExpansionFor(two, "/a"), ["src"]);
  assert.deepEqual(withStoredExpansion(two, "/b", []), [{ root: "/a", paths: ["src"] }]);
});

test("a lone linked folder is not opened by itself, so a link cycle cannot open without end", () => {
  const children = applyListing(new Map(), "a", [dir("loop", { link: true })]).listings.get("a")!;
  const expanded = new Set(["a"]);
  assert.equal(openSingleChild(expanded, "a", children), expanded);
});

test("a flattened row opens and closes all its folders, and keys still find it by its first folder", () => {
  const l = listings({ "": [dir("a"), file("z")], a: [dir("b")], "a/b": [file("x")] });
  const rows = rowsOf(l, ["a", "a/b"]).rows;
  assert.deepEqual(rowFolders(rows[0]!), ["a", "a/b"]);
  assert.deepEqual(rowFolders(rows.at(-1)!), ["z"]);
  // Focus was on "a" before the chain formed; the keys go on from the chain's row.
  assert.deepEqual(treeKeyAction(rows, "a", "ArrowDown"), { focus: "a/b/x" });
  assert.deepEqual(treeKeyAction(rows, "a", "ArrowLeft"), { collapse: "a/b" });
});

test("while searching, up and down move between matches and the other keys do nothing (Pierre)", () => {
  const l = listings({ "": [dir("src"), file("readme.md")], src: [file("a.md"), file("b.ts")] });
  const rows = rowsOf(l, [], ".md").rows;
  assert.deepEqual(rows.map((r) => `${r.path}${r.match ? "*" : ""}`), ["src", "src/a.md*", "readme.md*"]);
  assert.deepEqual(treeKeyAction(rows, null, "ArrowDown", true), { focus: "src/a.md" });
  assert.deepEqual(treeKeyAction(rows, "src/a.md", "ArrowDown", true), { focus: "readme.md" });
  assert.deepEqual(treeKeyAction(rows, "readme.md", "ArrowDown", true), { focus: "readme.md" });
  assert.deepEqual(treeKeyAction(rows, "readme.md", "ArrowUp", true), { focus: "src/a.md" });
  assert.deepEqual(treeKeyAction(rows, "src", "ArrowUp", true), { focus: "src/a.md" });
  assert.equal(treeKeyAction(rows, "src", "ArrowLeft", true), null);
  assert.equal(treeKeyAction(rows, "src", "ArrowRight", true), null);
  assert.equal(treeKeyAction(rows, "src", "End", true), null);
});

test("file paths drop . segments, apply .., and lose a trailing slash", () => {
  assert.equal(normalizeFilePath("/Users/me/proj/./src/../lib/a.ts"), "/Users/me/proj/lib/a.ts");
  assert.equal(normalizeFilePath("/a//b/"), "/a/b");
  assert.equal(normalizeFilePath("/.."), "/");
  assert.equal(normalizeFilePath("~/x/./y"), "~/x/y");
  assert.equal(normalizeFilePath("~"), "~");
  assert.equal(normalizeFilePath("relative/./x"), "relative/./x");
  assert.equal(treeRelativePath("/Users/me/proj", "/Users/me/proj/./src/a.ts"), "src/a.ts");
  assert.equal(treeRelativePath("/Users/me/proj", "/Users/me/proj/src/../README.md"), "README.md");
  // Another user's folder under /Users is not this home.
  assert.equal(treeRelativePath("/Users/me/proj", "/Users/Shared/proj/a.ts"), null);
  assert.equal(treeRelativePath("~/proj", "/Users/other/proj/a.ts"), "a.ts", "a ~ root takes the home from the target");
});

test("paths compare with the home folder as ~ and map in and out of the root", () => {
  assert.deepEqual(treeAncestors("a/b/c"), ["a", "a/b"]);
  assert.deepEqual(treeAncestors("a"), []);
  assert.equal(treeRelativePath("/Users/me/proj", "/Users/me/proj/src/a.ts"), "src/a.ts");
  assert.equal(treeRelativePath("/Users/me/proj/", "~/proj/src/"), "src");
  assert.equal(treeRelativePath("~/proj", "/Users/me/proj/x"), "x");
  assert.equal(treeRelativePath("/Users/me/proj", "/Users/me/proj"), "");
  assert.equal(treeRelativePath("/Users/me/proj", "/Users/me/project/x"), null);
  assert.equal(treeRelativePath("/", "/etc/hosts"), "etc/hosts");
  assert.equal(treeAbsolutePath("/Users/me/proj", "src/a.ts"), "/Users/me/proj/src/a.ts");
  assert.equal(treeAbsolutePath("/", "etc"), "/etc");
});
