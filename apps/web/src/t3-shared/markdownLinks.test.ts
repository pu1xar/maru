// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: packages/shared/src/markdownLinks.test.ts (vitest cases on node:test).
// Local changes: the composer link cases (serializeComposerFileLink) are left out with the
// composer; added a case for fileLinkLabel's separators.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildFileLinkParentSuffixByPath, fileLinkLabel } from "./fileLinks.ts";
import {
  absoluteFilePathMatches,
  extractMarkdownLinkHrefs,
  inlineCodeFilePathCandidate,
  isMarkdownFileLinkLabel,
  parseMarkdownFileLink,
  resolveMarkdownFileLinkTarget,
} from "./markdownLinks.ts";
import { workspaceRelativeFilePath } from "./path.ts";

describe("isMarkdownFileLinkLabel", () => {
  for (const [label, href, expected] of [
    ["validates the input", "/repo/src/example.ts:12", false],
    ["example.ts:12", "/repo/src/example.ts:12", true],
    ["example.ts:99", "/repo/src/example.ts:12", false],
    ["example.ts:12-20", "/repo/src/example.ts:12-20", true],
    ["example.ts:12-20", "/repo/src/example.ts:12", false],
  ] as const) {
    test(`classifies ${label} for ${href}`, () => {
      assert.equal(isMarkdownFileLinkLabel(label, href), expected);
    });
  }
});

describe("inlineCodeFilePathCandidate", () => {
  for (const [source, candidate] of [
    ["src\\main.ts", "src/main.ts"],
    ["allocator.cc:217", "allocator.cc:217"],
    ["src/http.ts:42-64", "src/http.ts:42-64"],
    ["http.ts:42-64", "http.ts:42-64"],
    ["origin/main", null],
    ["z-ai/glm-5.3", null],
    ["share/man/ls.1", "share/man/ls.1"],
    ["src/main.ts/", null],
    ["./patches/", "./patches/"],
    ["/tmp/claude-1000/...", null],
    ["/tmp/claude-1000/...:12", null],
    ["/tmp/.../scratchpad/notes.md", null],
    ["~/projects/…/notes.md", null],
    ["src/.../main.ts", null],
    ["I/W217:220", null],
    ["bin/run:12", null],
    ["docs/README:12", "docs/README:12"],
    ["./bin/run:12", "./bin/run:12"],
    ["src/資料.備份:12", "src/資料.備份:12"],
    ["src/foo.c++:12", "src/foo.c++:12"],
  ] as const) {
    test(`distinguishes file paths from code and hostnames in ${source}`, () => {
      assert.equal(inlineCodeFilePathCandidate(source), candidate);
    });
  }
});

const USER_EXAMPLE =
  "~/projects/notes/summaries/한글 파일 이름 예시 Track C 2,5,6,7.md";

describe("inlineCodeFilePathCandidate with spaces", () => {
  for (const source of [
    USER_EXAMPLE,
    "/Users/me/Library/Application Support/maru/state.json",
    "/Users/me/My Documents/report final.pdf",
    "~/Desktop/스크린샷 2026-11-19 오후 3.04.12.png",
    "~/notes/Plan, v2 (draft).md",
    "~/notes/R&D Notes.md",
    "./docs/My Folder/",
    "../shared docs/a b.txt",
    "~/Projects/My App/src/main.ts:42",
    "~/Projects/My App/src/main.ts:42:7",
    "/tmp/two  spaces.log",
    "/srv/data/Don't Stop.md",
    "C:\\Users\\me\\My Docs\\a.md",
    "~/work/My Project/Makefile",
  ]) {
    test(`links one path with spaces: ${source}`, () => {
      assert.equal(inlineCodeFilePathCandidate(source), source);
    });
  }

  for (const source of [
    "cat ~/notes/a b.md",
    "rm -rf ~/notes/My Folder/",
    "~/a b.md | wc -l",
    "~/a b.md && echo done",
    "~/a b.md; ls",
    "~/a b.md > out.txt",
    "~/a b.md $(whoami)",
    "/usr/bin/python script.py",
    "~/notes/a b.md ~/notes/c d.md",
    "/tmp/a.md /tmp/b.md",
    "~/notes/a b.md --verbose",
    '~/notes/"a b".md',
    "~/notes/'a b.md'",
    "~/notes/a b.md is the file",
    "~/notes/some words here",
    "~/notes/a\tb.md",
    "~/ notes.md",
    "/ slash first.md",
    "notes/a b.md",
    "docs/My Folder/a.md",
    "some words ./a.md",
  ]) {
    test(`leaves a command or sentence alone: ${source}`, () => {
      assert.equal(inlineCodeFilePathCandidate(source), null);
    });
  }

  test("a tab or line break inside the span is not a file name", () => {
    assert.equal(inlineCodeFilePathCandidate("~/notes/a\tb c.md"), null);
    assert.equal(inlineCodeFilePathCandidate("~/notes/a\nb c.md"), null);
  });

  test("the user's example resolves to one home path", () => {
    assert.equal(resolveMarkdownFileLinkTarget(inlineCodeFilePathCandidate(USER_EXAMPLE)!, undefined), USER_EXAMPLE);
  });
});

describe("parseMarkdownFileLink", () => {
  for (const [href, path] of [
    ["C:%5Crepo%5Cimage.png", "C:\\repo\\image.png"],
    ["</D:/Programme/t3code/ChatMarkdown.tsx:1>", "D:/Programme/t3code/ChatMarkdown.tsx"],
    ["file://localhost/home/me/notes.md", "/home/me/notes.md"],
    ["app/routes/posts.$postId.tsx", "app/routes/posts.$postId.tsx"],
    ["src/routes/+page.svelte", "src/routes/+page.svelte"],
    ["app/(marketing)/page.tsx:12", "app/(marketing)/page.tsx"],
    ["pages/posts/%5Bid%5D.tsx", "pages/posts/[id].tsx"],
    ["+page.svelte", "+page.svelte"],
    ["[id].tsx", "[id].tsx"],
    ["/\\server\\share\\x.ts", "/\\server\\share\\x.ts"],
  ] as const) {
    test(`recognizes ${href} as a file`, () => {
      assert.equal(parseMarkdownFileLink(href)?.path, path);
    });
  }

  for (const href of [
    "https://example.com/docs",
    "/chat/settings#L3",
    "TODO:12",
    "patches",
    "me@example.com",
    "foo(bar)",
    "$HOME",
    "/tmp/claude-1000/...",
    "/tmp/claude-1000/....:12",
    "/tmp/claude-1000/%2E%2E%2E",
    "\\foo.ts",
  ]) {
    test(`does not treat ${href} as a file`, () => {
      assert.equal(parseMarkdownFileLink(href), null);
    });
  }

  test("recognizes a relative folder that ends in a slash", () => {
    assert.deepEqual(parseMarkdownFileLink("patches/"), { path: "patches/" });
    assert.equal(parseMarkdownFileLink("docs/My%20Folder/")?.path, "docs/My Folder/");
  });

  test("recognizes relative paths with non-ASCII names", () => {
    assert.equal(
      parseMarkdownFileLink("pastexam/線性代數/exam_易志偉.pdf")?.path,
      "pastexam/線性代數/exam_易志偉.pdf",
    );
    assert.equal(parseMarkdownFileLink("Résumé%20final.pdf")?.path, "Résumé final.pdf");
    assert.equal(parseMarkdownFileLink("資料.備份")?.path, "資料.備份");
  });

  test("accepts conventional extensionless names with or without a position", () => {
    assert.deepEqual(parseMarkdownFileLink("Makefile"), { path: "Makefile" });
    assert.deepEqual(parseMarkdownFileLink("Dockerfile:8"), { path: "Dockerfile", line: 8 });
    assert.deepEqual(parseMarkdownFileLink("/srv/app/Makefile"), { path: "/srv/app/Makefile" });
  });

  test("reads line ranges and opens them at their first line", () => {
    assert.deepEqual(parseMarkdownFileLink("/repo/src/http.ts:42-64"), {
      path: "/repo/src/http.ts",
      line: 42,
      endLine: 64,
    });
    assert.deepEqual(parseMarkdownFileLink("/repo/src/http.ts#L42-L64"), {
      path: "/repo/src/http.ts",
      line: 42,
      endLine: 64,
    });
  });

  test("reads positions from suffixes and line anchors", () => {
    assert.deepEqual(parseMarkdownFileLink("/Users/julius/project/src/main.ts#L42C7"), {
      path: "/Users/julius/project/src/main.ts",
      line: 42,
      column: 7,
    });
    const unc = parseMarkdownFileLink("file://server/share/src/main.ts#L42C7");
    assert.equal(unc?.path, "\\\\server\\share\\src\\main.ts");
    assert.equal(unc?.line, 42);
    assert.equal(unc?.column, 7);
  });
});

describe("workspaceRelativeFilePath", () => {
  for (const [path, workspaceRoot, relativePath] of [
    ["/repo/project", "/repo/project", "."],
    ["C:/", "c:/", "."],
    ["/repo/project/a.ts", undefined, null],
  ] as const) {
    test(`relates ${path} to ${workspaceRoot}`, () => {
      assert.equal(workspaceRelativeFilePath(path, workspaceRoot), relativePath);
    });
  }
});

describe("extractMarkdownLinkHrefs", () => {
  for (const [markdown, hrefs] of [
    ["[".repeat(32_000), []],
    ["[a](<foo)bar> invalid [b](ok)", ["<foo", "ok"]],
    ["[[[nested](src/main.ts) [unfinished", ["src/main.ts"]],
  ] as const) {
    test(`extracts links from incomplete and nested text: ${markdown.slice(0, 40)}`, () => {
      assert.deepEqual(extractMarkdownLinkHrefs(markdown), hrefs);
    });
  }
});

describe("resolveMarkdownFileLinkTarget", () => {
  test("resolves a relative folder with a trailing slash against cwd", () => {
    assert.equal(resolveMarkdownFileLinkTarget("patches/", "/repo/project"), "/repo/project/patches/");
    assert.equal(resolveMarkdownFileLinkTarget("patches", "/repo/project"), null);
  });

  for (const [href, target] of [
    ["src/Example.cs", "C:\\repo\\src\\Example.cs"],
    ["src\\Example.cs", "C:\\repo\\src\\Example.cs"],
    ["src%5CExample.cs", "C:\\repo\\src\\Example.cs"],
    ["src\\Example.cs:3", "C:\\repo\\src\\Example.cs:3"],
  ] as const) {
    test(`resolves the relative link ${href} against a windows cwd`, () => {
      assert.equal(resolveMarkdownFileLinkTarget(href, "C:\\repo"), target);
    });
  }

  test("keeps a backslash in a relative link that already names a file", () => {
    assert.equal(resolveMarkdownFileLinkTarget("./foo%5Cbar.ts", "/repo"), "/repo/./foo\\bar.ts");
  });

  test("does not treat filename line references as external schemes", () => {
    assert.equal(
      resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project"),
      "/Users/julius/project/script.ts:10",
    );
  });

  test("maps #L line anchors to editor line suffixes", () => {
    assert.equal(
      resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7"),
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  test("ignores external urls", () => {
    assert.equal(resolveMarkdownFileLinkTarget("https://example.com/docs"), null);
    assert.equal(resolveMarkdownFileLinkTarget("//cdn.example.com/clip.mp4", "/workspace"), null);
  });

  test("does not double-decode file URLs", () => {
    assert.equal(
      resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md"),
      "/Users/julius/project/file%20name.md",
    );
  });

  test("links a network path only inside the project's share", () => {
    const cwd = "\\\\server\\share";
    assert.equal(
      resolveMarkdownFileLinkTarget("file://server/share/workspace-image.svg", cwd),
      "\\\\server\\share\\workspace-image.svg",
    );
    for (const href of ["file://attacker.test/s/x.ts", "\\\\attacker.test\\s\\x.ts"]) {
      assert.equal(resolveMarkdownFileLinkTarget(href, cwd), null);
    }
  });

  test("normalizes slash-prefixed windows drive paths before resolving", () => {
    assert.equal(
      resolveMarkdownFileLinkTarget(
        "/D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
      "D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx:69",
    );
  });
});

describe("absoluteFilePathMatches", () => {
  const png = "/private/tmp/claude-501/-Users-x-work-a/3296a420-1796/scratchpad/d-S7.png";
  const found = (text: string) => absoluteFilePathMatches(text).map((m) => m.path);

  test("links an absolute path outside any session folder, after whitespace or a bracket", () => {
    assert.deepEqual(found(`그림은 ${png} 에 있다`), [png]);
    assert.deepEqual(found(`(${png})`), [png]);
    assert.deepEqual(found(png), [png]);
  });

  test("ends the path at its extension when a Korean particle is glued on", () => {
    assert.deepEqual(found(`${png}를 봐`), [png]);
    assert.deepEqual(found(`${png}입니다.`), [png]);
    assert.deepEqual(found(`${png}에서`), [png]);
  });

  test("keeps a Korean file name that ends the path", () => {
    assert.deepEqual(found("/Users/me/문서/보고서.pdf"), ["/Users/me/문서/보고서.pdf"]);
    assert.deepEqual(found("/Users/me/한글.png"), ["/Users/me/한글.png"]);
  });

  test("starts after the colon of a non-ASCII label, not after an ASCII scheme or drive", () => {
    assert.deepEqual(found(`그림:${png}`), [png]);
    assert.deepEqual(found(`see https://example.com/tmp/a.png`), []);
    assert.deepEqual(found("C:/Users/me/a.png"), []);
    assert.deepEqual(found("file:///Users/me/a.png"), []);
  });

  test("links ~/ paths only with an extension", () => {
    assert.deepEqual(found("보기 ~/pics/a.png 끝"), ["~/pics/a.png"]);
    assert.deepEqual(found("보기 ~/pics 끝"), []);
  });

  test("leaves routes, protocol-relative URLs and bare folders alone", () => {
    assert.deepEqual(found("GET /api/users.json now"), []);
    assert.deepEqual(found("//cdn.example.com/a.png"), []);
    assert.deepEqual(found("/Users/me/Library/Application Support/x"), []);
  });
});

describe("resolveMarkdownFileLinkTarget without a session folder", () => {
  test("keeps absolute and home paths, drops relative ones", () => {
    assert.equal(resolveMarkdownFileLinkTarget("/tmp/a.png"), "/tmp/a.png");
    assert.equal(resolveMarkdownFileLinkTarget("~/pics/a.png"), "~/pics/a.png");
    assert.equal(resolveMarkdownFileLinkTarget("src/a.ts"), null);
  });
});

describe("fileLinkLabel", () => {
  test("joins the name, a disambiguating folder and the position with commas", () => {
    const suffixes = buildFileLinkParentSuffixByPath(["/repo/a/index.ts", "/repo/b/index.ts"]);
    assert.equal(fileLinkLabel({ path: "/repo/a/index.ts", line: 12 }, suffixes), "index.ts, repo/a, L12");
    assert.equal(
      fileLinkLabel({ path: "/repo/src/http.ts", line: 42, endLine: 64 }, suffixes),
      "http.ts, L42-64",
    );
    assert.equal(fileLinkLabel({ path: "/repo/src/http.ts" }, suffixes), "http.ts");
  });
});
