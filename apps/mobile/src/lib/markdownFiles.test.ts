import { test } from "node:test";
import assert from "node:assert/strict";
import { Lexer } from "marked";
import { inlineImages, messageFiles } from "./markdownFiles.ts";

const cwd = "/Users/me/repo";
const OUTSIDE = "/private/tmp/claude-501/-Users-me-work-a/3296a420/scratchpad/d-S7.png";

test("an inline code span that is a file under the folder becomes a chip with the file's name", () => {
  const files = messageFiles("see `src/a.ts` and `npm run build`", cwd);
  assert.deepEqual(files.forCode("src/a.ts"), { label: "a.ts", folder: false, path: "/Users/me/repo/src/a.ts", image: null });
  assert.equal(files.forCode("npm run build"), null);
});

test("two files that share a name show their folders, and a line shows after the name", () => {
  const files = messageFiles("`src/a/index.ts` and `src/b/index.ts:12`", cwd);
  const a = files.forCode("src/a/index.ts");
  const b = files.forCode("src/b/index.ts:12");
  assert.ok(a && b);
  assert.match(a.label, /^index\.ts, .*a/);
  assert.match(b.label, /^index\.ts, .*b.*L12$/);
});

test("a link to a file is a chip and its words that are the file's own label fold into it; other links are not", () => {
  const files = messageFiles("[a.ts](/Users/me/repo/src/a.ts) [site](https://example.com)", cwd);
  assert.deepEqual(files.forLink("/Users/me/repo/src/a.ts"), { label: "a.ts", folder: false, path: "/Users/me/repo/src/a.ts", image: null });
  assert.equal(files.forLink("https://example.com"), null);
});

test("without a folder an absolute or home path is a chip and a relative one is not", () => {
  const files = messageFiles("`src/a.ts` `/x/y.ts` `~/p/z.ts`", undefined);
  assert.equal(files.forCode("src/a.ts"), null);
  assert.equal(files.forLink("/x/y.ts")?.label, "y.ts");
  assert.equal(files.forCode("~/p/z.ts")?.path, "~/p/z.ts");
});

test("a picture path outside the folder is a chip with a preview, a bitmap only", () => {
  const files = messageFiles(`\`${OUTSIDE}\` \`/tmp/v.svg\` \`/tmp/a.ts\``, cwd);
  assert.equal(files.forCode(OUTSIDE)?.image, OUTSIDE);
  assert.equal(files.forCode("/tmp/v.svg")?.image, null, "React Native's Image draws no SVG");
  assert.equal(files.forCode("/tmp/a.ts")?.image, null);
});

test("bare absolute paths in prose split the text around chips, with a Korean particle after the path", () => {
  const files = messageFiles(`그림은 ${OUTSIDE}를 보세요 그리고 /api/users.json 은 경로`, cwd);
  const parts = files.forText(`그림은 ${OUTSIDE}를 보세요 그리고 /api/users.json 은 경로`);
  assert.ok(parts);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[0], { text: "그림은 " });
  assert.equal("chip" in parts[1]! && parts[1].chip.image, OUTSIDE);
  assert.deepEqual(parts[2], { text: "를 보세요 그리고 /api/users.json 은 경로" });
  assert.equal(files.forText("경로 없음 /api/users.json"), null);
});

test("inlineImages lists a paragraph's pictures once each, from code, links and bare paths", () => {
  const second = "/private/tmp/x/second.png";
  const text = `a \`${OUTSIDE}\` b [shot](${second}) c ${OUTSIDE} d \`/tmp/a.ts\` e **${second}**`;
  const files = messageFiles(text, cwd);
  const paragraph = Lexer.lex(text, { gfm: true })[0] as { tokens: Parameters<typeof inlineImages>[0] };
  assert.deepEqual(inlineImages(paragraph.tokens, files), [
    { path: OUTSIDE, name: "d-S7.png" },
    { path: second, name: "second.png" },
  ]);
  // A find paints the code as typed, so that span names no picture.
  assert.deepEqual(inlineImages(paragraph.tokens, files, (t) => t.includes("d-S7")).map((i) => i.name), ["second.png"]);
});

test("a path inside a link's words that is not itself a file link is left as prose", () => {
  const text = `[see ${OUTSIDE}](https://example.com/page)`;
  const files = messageFiles(text, cwd);
  const paragraph = Lexer.lex(text, { gfm: true })[0] as { tokens: Parameters<typeof inlineImages>[0] };
  assert.deepEqual(inlineImages(paragraph.tokens, files), []);
});

test("an inline code span that is one path with spaces, Korean and commas is a chip; a command with spaces is not", () => {
  const name = "한글 파일 이름 예시 Track C 2,5,6,7.md";
  const path = `~/projects/notes/summaries/${name}`;
  const files = messageFiles(`see \`${path}\` and \`cat ~/a b.md\``, cwd);
  assert.deepEqual(files.forCode(path), {
    label: name,
    folder: false,
    path: `/Users/me/projects/notes/summaries/${name}`,
    image: null,
  });
  assert.equal(files.forCode("cat ~/a b.md"), null);
  assert.equal(files.forCode("~/a b.md | wc -l"), null);
});

test("an authored image previews a relative bitmap under the folder, and a bare relative file link does not", () => {
  const files = messageFiles("![shot](docs/a.png) ![v](v.svg) ![r](https://example.com/r.png) [a.png](docs/a.png)", cwd);
  assert.deepEqual(files.forImage("docs/a.png"), { label: "a.png", folder: false, path: "/Users/me/repo/docs/a.png", image: "/Users/me/repo/docs/a.png" });
  assert.equal(files.forImage("v.svg")?.image, null, "svg is a chip only on the phone");
  assert.equal(files.forImage("https://example.com/r.png"), null);
  assert.equal(files.forLink("docs/a.png")?.image, null);
  assert.equal(files.forImage("../up/a%20b.png")?.image, "/Users/me/up/a b.png", "dot segments collapse and %20 decodes");
});

test("inlineImages lists the picture of an image token, also inside a link", () => {
  const text = "![a](docs/a.png) and [![b](docs/b.png)](https://example.com)";
  const files = messageFiles(text, cwd);
  const paragraph = Lexer.lex(text, { gfm: true })[0] as { tokens: Parameters<typeof inlineImages>[0] };
  assert.deepEqual(
    inlineImages(paragraph.tokens, files).map((i) => i.path),
    ["/Users/me/repo/docs/a.png", "/Users/me/repo/docs/b.png"],
  );
});
