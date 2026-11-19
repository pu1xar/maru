import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createServer, parseSync } from "vite";
import { type UiNamed, uiNameLine } from "../lib/uiNameCopy.logic.ts";
import {
  applyInserts,
  componentRoots,
  type NoDomScan,
  rendersNoElement,
  scanProject,
  sourceFiles,
  uiNameInserts,
} from "./uiNames.ts";

const SRC = path.resolve(import.meta.dirname, "..");
const WEB = path.resolve(SRC, "..");
const relOf = (file: string) => path.relative(SRC, file).split(path.sep).join("/");

/** The scan of the real src, made once: several tests read real files through it. */
let srcScan: NoDomScan | null = null;
function realScan(): NoDomScan {
  srcScan ??= scanProject(sourceFiles(SRC).map((f) => ({ file: relOf(f), code: fs.readFileSync(f, "utf8") })));
  return srcScan;
}

function annotate(code: string, file = "x.tsx", scan?: NoDomScan): string {
  return applyInserts(code, uiNameInserts(code, file, scan), file).code;
}

test("a component's outermost tag gets its name, every tag its line", () => {
  const out = annotate(`function Card() {\n  return (\n    <div className="a">\n      <span>x</span>\n    </div>\n  );\n}\n`);
  assert.equal(
    out,
    `function Card() {\n  return (\n    <div data-ui="Card" data-ui-src={"x.tsx:3"} className="a">\n      <span data-ui-in="Card" data-ui-src={"x.tsx:4"}>x</span>\n    </div>\n  );\n}\n`,
  );
});

test("arrow functions, memo() and forwardRef() keep the declared name", () => {
  const code = [
    `const A = () => <p />;`,
    `const B = memo(function B() { return <p />; });`,
    `export const C = React.memo((props) => <p {...props} />);`,
    `const D = forwardRef(function D(props, ref) { return <p ref={ref} />; });`,
    `const E = memo(function inner() { return <p />; });`,
  ].join("\n");
  assert.deepEqual(
    componentRoots(code, "x.tsx").map((c) => [c.name, c.roots.map((r) => r.line)]),
    [
      ["A", [1]],
      ["B", [2]],
      ["C", [3]],
      ["D", [4]],
      ["E", [5]],
    ],
  );
});

test("every return and both sides of a condition are outermost", () => {
  const code = `function Row(p) {\n  if (p.a) return <A />;\n  return p.b ? <b /> : p.c && <i />;\n}`;
  assert.deepEqual(
    componentRoots(code, "x.tsx")[0]!.roots.map((r) => r.tag),
    ["A", "b", "i"],
  );
});

test("fragments get nothing and pass the name to their children", () => {
  const out = annotate(`function F() {\n  return (\n    <>\n      <div />\n      {x ? <span /> : null}\n      <Fragment key="k"><em /></Fragment>\n    </>\n  );\n}`);
  assert.match(out, /<div data-ui="F" data-ui-src=\{"x.tsx:4"\} \/>/);
  assert.match(out, /<span data-ui="F" data-ui-src=\{"x.tsx:5"\} \/>/);
  assert.match(out, /<Fragment key="k"><em data-ui="F" data-ui-src=\{"x.tsx:6"\} \/><\/Fragment>/);
});

test("tags that render no element pass the name inward and carry nothing", () => {
  const code = [
    `function Card() {`,
    `  return (`,
    `    <TooltipPrimitive.Root>`,
    `      <TooltipTrigger render={<button />} />`,
    `      <TooltipPopup>tip</TooltipPopup>`,
    `    </TooltipPrimitive.Root>`,
    `  );`,
    `}`,
    `function View() {`,
    `  return (`,
    `    <Suspense fallback={<p />}>`,
    `      <RowCtx value={v}><main /></RowCtx>`,
    `    </Suspense>`,
    `  );`,
    `}`,
  ].join("\n");
  const out = annotate(code);
  assert.match(out, /<TooltipPrimitive.Root>/);
  assert.match(out, /<TooltipTrigger data-ui="Card" data-ui-src=\{"x.tsx:4"\} render=\{<button data-ui-in="Card" data-ui-src=\{"x.tsx:4"\} \/>\} \/>/);
  assert.match(out, /<TooltipPopup data-ui="Card" data-ui-src=\{"x.tsx:5"\}>/);
  assert.match(out, /<Suspense fallback=\{<p data-ui="View" data-ui-src=\{"x.tsx:11"\} \/>\}>/);
  assert.match(out, /<RowCtx value=\{v\}><main data-ui="View" data-ui-src=\{"x.tsx:12"\} \/><\/RowCtx>/);
});

test("a render function given to such a tag is followed", () => {
  const scan = scanProject([{ file: "f.tsx", code: `function ThreadFolder(p) { return p.children(p.k); }` }]);
  const code = `function Folder() {\n  return <ThreadFolder sessionKey={k}>{(folder) => <div>{folder}</div>}</ThreadFolder>;\n}`;
  assert.match(annotate(code, "x.tsx", scan), /<ThreadFolder sessionKey=\{k\}>\{\(folder\) => <div data-ui="Folder" data-ui-src=\{"x.tsx:2"\}>/);
});

test("the scan finds contexts, children-only components, aliases and chains of them", () => {
  const scan = scanProject([
    { file: "ctx.ts", code: `export const GroupedRows = createContext(false);\nexport const Other = React.createContext<number>(0);` },
    {
      file: "a.tsx",
      code: [
        `const Menu = MenuPrimitive.Root;`,
        `const Plain = SomeLib.Thing;`,
        `function Boundary(p) { return p.children; }`,
        `function Wrapper(p) { return <Boundary>{p.children}</Boundary>; }`,
        `function Empty() { return null; }`,
        `function Card() { return <div />; }`,
        `function RowContext() { return <section />; }`,
        `function Btn(p) { return useRender({ props: p }); }`,
      ].join("\n"),
    },
  ]);
  for (const name of ["GroupedRows", "Other", "Menu", "Boundary", "Wrapper", "Empty"]) assert.equal(rendersNoElement(name, scan), true, name);
  // A component that draws an element, even under a context-like name, and a useRender primitive.
  for (const name of ["Plain", "Card", "RowContext", "Btn"]) assert.equal(rendersNoElement(name, scan), false, name);
  // So a component using GroupedRows as its outermost tag names the div inside.
  assert.match(annotate(`function List() { return <GroupedRows value><div /></GroupedRows>; }`, "x.tsx", scan), /<div data-ui="List"/);
});

test("a name defined both ways counts as drawing an element", () => {
  const scan = scanProject([
    { file: "a.tsx", code: `function Panel(p) { return p.children; }` },
    { file: "b.tsx", code: `function Panel() { return <aside />; }` },
  ]);
  assert.equal(rendersNoElement("Panel", scan), false);
});

test("tags that always render no element, and DOM tags that never do", () => {
  for (const tag of ["Fragment", "React.Fragment", "Suspense", "TooltipPrimitive.Root", "MenuPrimitive.SubmenuRoot", "Toast.Provider", "DndContext", "TimelineRowCtx", "ToastProvider"]) {
    assert.equal(rendersNoElement(tag), true, tag);
  }
  for (const tag of ["SidebarProvider", "Toast.Root", "CheckboxPrimitive.Root", "CollapsiblePrimitive.Root", "ScrollAreaPrimitive.Root", "Collapsible", "DialogPopup", "div"]) {
    assert.equal(rendersNoElement(tag), false, tag);
  }
});

test("a primitive drawn by useRender names the props it passes, under the caller's", () => {
  const code = [
    `function Button({ render, ...props }) {`,
    `  return useRender({ defaultTagName: "button", props: mergeProps(defaultProps, props), render });`,
    `}`,
    `function Badge(p) { const props = p; return useRender({ props }); }`,
    `function Odd(p) { return useRender({ props() { return p; } }); }`,
  ].join("\n");
  const out = annotate(code);
  assert.match(out, /props: \{ "data-ui": "Button", \.\.\.\(mergeProps\(defaultProps, props\)\) \}, render/);
  assert.match(out, /useRender\(\{ props: \{ "data-ui": "Badge", \.\.\.props \} \}\)/);
  assert.match(out, /useRender\(\{ props\(\) \{ return p; \} \}\)/);
  assert.equal(parseSync("x.tsx", out).errors.length, 0);
  assert.deepEqual(componentRoots(code, "x.tsx").map((c) => c.useRender), [true, true, false]);
});

test("the inserted attributes come first, so a later props spread wins", () => {
  const out = annotate(`function Button(props) {\n  return <Primitive {...props} data-slot="button" />;\n}`);
  assert.equal(out, `function Button(props) {\n  return <Primitive data-ui="Button" data-ui-src={"x.tsx:2"} {...props} data-slot="button" />;\n}`);
});

test("a hand-written data-ui stays", () => {
  const out = annotate(`function A() {\n  return <div data-ui="Other" />;\n}`);
  assert.equal(out, `function A() {\n  return <div data-ui-src={"x.tsx:2"} data-ui="Other" />;\n}`);
});

test("type arguments stay right after the tag name", () => {
  const out = annotate(`function A() {\n  return <Picker<string> value="a" />;\n}`);
  assert.equal(out, `function A() {\n  return <Picker<string> data-ui="A" data-ui-src={"x.tsx:2"} value="a" />;\n}`);
  assert.equal(parseSync("x.tsx", out).errors.length, 0);
});

test("a local const of JSX, a returned map, optional chaining and createPortal are followed", () => {
  const code = [
    `function A() { const body = <section />; return cond ? <Wrap>{body}</Wrap> : body; }`,
    `function B({ items }) { return <>{items.map((i) => { const t = <b />; return i ? t : <i />; })}</>; }`,
    `function C() { return createPortal(<aside />, document.body); }`,
    `function D({ items }) { return items?.map((i) => <li key={i} />); }`,
  ].join("\n");
  assert.deepEqual(
    componentRoots(code, "x.tsx").map((c) => [c.name, c.roots.map((r) => r.tag)]),
    [
      ["A", ["Wrap", "section"]],
      ["B", ["b", "i"]],
      ["C", ["aside"]],
      ["D", ["li"]],
    ],
  );
});

test("helpers and nested functions get no name; nested components get their own", () => {
  const code = [
    `function renderRow() { return <li />; }`,
    `function List() {`,
    `  function Item() { return <em />; }`,
    `  const cb = () => <u />;`,
    `  return <ul />;`,
    `}`,
    `class Panel extends Component { render() { return <div />; } }`,
  ].join("\n");
  assert.deepEqual(
    componentRoots(code, "x.tsx").map((c) => [c.name, c.roots.map((r) => r.tag)]),
    [
      ["List", ["ul"]],
      ["Item", ["em"]],
      ["Panel", ["div"]],
    ],
  );
  assert.match(annotate(code), /<li data-ui-src=\{"x.tsx:1"\} \/>/);
  // A tag in a nested callback belongs to the component around it; a nested component has its own.
  assert.match(annotate(code), /<u data-ui-in="List" data-ui-src=\{"x.tsx:4"\} \/>/);
  assert.match(annotate(code), /<em data-ui="Item" data-ui-src=\{"x.tsx:3"\} \/>/);
});

test("every tag inside a component names that component, and one equal to its data-ui says nothing more", () => {
  const out = annotate(`function Group() {\n  return (\n    <section>\n      <CollapsibleTrigger className="x" />\n      <div><span /></div>\n    </section>\n  );\n}`);
  assert.match(out, /<section data-ui="Group" data-ui-src=\{"x.tsx:3"\}>/);
  assert.match(out, /<CollapsibleTrigger data-ui-in="Group" data-ui-src=\{"x.tsx:4"\} className="x" \/>/);
  assert.match(out, /<div data-ui-in="Group" data-ui-src=\{"x.tsx:5"\}><span data-ui-in="Group" data-ui-src=\{"x.tsx:5"\} \/><\/div>/);
});

test("data-ui-in sits under the caller's props spread, so a part passing its props on shows the caller", () => {
  const out = annotate(`function Row(props) {\n  return <Primitive {...props} data-slot="row" />;\n}`);
  assert.equal(out, `function Row(props) {\n  return <Primitive data-ui="Row" data-ui-src={"x.tsx:2"} {...props} data-slot="row" />;\n}`);
  const inner = annotate(`function Outer() {\n  return <div><Row {...p} /></div>;\n}`);
  assert.match(inner, /<Row data-ui-in="Outer" data-ui-src=\{"x.tsx:2"\} \{\.\.\.p\} \/>/);
});

test("JSX outside any component, helpers and a hand-written data-ui-in carry no data-ui-in of their own making", () => {
  const code = [`const ICON = <svg />;`, `function renderRow() { return <li />; }`, `function A() { return <div data-ui-in="Mine" />; }`].join("\n");
  const out = annotate(code);
  assert.match(out, /const ICON = <svg data-ui-src=\{"x.tsx:1"\} \/>;/);
  assert.match(out, /<li data-ui-src=\{"x.tsx:2"\} \/>/);
  assert.match(out, /<div data-ui="A" data-ui-src=\{"x.tsx:3"\} data-ui-in="Mine" \/>/);
});

test("uiNameLine names an element for a bug report", () => {
  const el = (attrs: Record<string, string>, tag: string, parent: UiNamed | null = null): UiNamed => ({
    getAttribute: (n) => attrs[n] ?? null,
    parentElement: parent,
    tagName: tag,
  });
  const trigger = el({ "data-ui": "CollapsibleTrigger", "data-ui-in": "V2SubagentGroup", "data-ui-src": "components/chat/TimelineV2EventRow.tsx:66" }, "BUTTON");
  assert.equal(uiNameLine(trigger, "0.1.431"), "V2SubagentGroup > CollapsibleTrigger (chat/TimelineV2EventRow.tsx:66, v0.1.431)");
  // The component's own outermost tag: data-ui alone.
  const root = el({ "data-ui": "SubagentAvatar", "data-ui-src": "components/chat/V2LifecycleRow.tsx:90" }, "SPAN");
  assert.equal(uiNameLine(root, "0.1.431"), "SubagentAvatar (chat/V2LifecycleRow.tsx:90, v0.1.431)");
  // An inner tag with data-ui-in only: its tag name stands for data-ui.
  const inner = el({ "data-ui-in": "SessionRow", "data-ui-src": "components/SessionSidebar.tsx:812" }, "SPAN", root);
  assert.equal(uiNameLine(inner, null), "SessionRow > span (SessionSidebar.tsx:812)");
  // An svg path has no attributes: the position and names come from the parent, the tag from the named element.
  const path = el({}, "path", el({ "data-ui-in": "Icon", "data-ui-src": "components/ui/icon.tsx:7" }, "svg"));
  assert.equal(uiNameLine(path, "0.1.1"), "Icon > svg (ui/icon.tsx:7, v0.1.1)");
  // Names missing on the tag itself come from the nearest element above that has one.
  const bare = el({ "data-ui-src": "App.tsx:5" }, "DIV", el({ "data-ui": "Shell", "data-ui-src": "App.tsx:1" }, "MAIN"));
  assert.equal(uiNameLine(bare, null), "Shell (App.tsx:5)");
  assert.equal(uiNameLine(el({}, "DIV"), null), null);
});

test("the page code read check sees data-ui-in and the other attributes, in each way of reading them", () => {
  for (const text of [
    `document.querySelector('[data-ui-in="X"]')`,
    `el.dataset.uiIn`,
    `el.getAttribute("data-ui-in")`,
    `el.getAttribute('data-ui')`,
    `[data-ui-src^="a"]`,
    `[data-ui]`,
  ]) {
    assert.notDeepEqual(attributeReads(text), [], text);
  }
  assert.deepEqual(attributeReads(`<div data-ui-part="x" data-composer-model-button />`), []);
});

test("a file the parser rejects gets nothing", () => {
  assert.deepEqual(uiNameInserts(`function A() { return <div>; }`, "x.tsx"), []);
});

test("applyInserts refuses unsorted inserts and line breaks", () => {
  assert.throws(() => applyInserts("abc", [{ offset: 2, text: "x" }, { offset: 1, text: "y" }], "x.tsx"), /sorted/);
  assert.throws(() => applyInserts("abc", [{ offset: 1, text: "a\nb" }], "x.tsx"), /line break/);
});

/** Decodes source map mappings into [generated column, original line, original column] per line. */
function decode(mappings: string): Array<Array<[number, number, number]>> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let origLine = 0;
  let origCol = 0;
  return mappings.split(";").map((line) => {
    let genCol = 0;
    return line
      .split(",")
      .filter(Boolean)
      .map((segment) => {
        const values: number[] = [];
        let value = 0;
        let shift = 0;
        for (const ch of segment) {
          const digit = chars.indexOf(ch);
          value += (digit & 31) << shift;
          if (digit & 32) shift += 5;
          else {
            values.push(value & 1 ? -(value >>> 1) : value >>> 1);
            value = 0;
            shift = 0;
          }
        }
        genCol += values[0]!;
        origLine += values[2]!;
        origCol += values[3]!;
        return [genCol, origLine, origCol] as [number, number, number];
      });
  });
}

test("the source map puts every token of a real file back on its exact line and column", () => {
  const file = path.join(SRC, "components/chat/V2LifecycleRow.tsx");
  const code = fs.readFileSync(file, "utf8");
  const inserts = uiNameInserts(code, "components/chat/V2LifecycleRow.tsx", realScan());
  assert.ok(inserts.length > 10);
  const { code: out, map } = applyInserts(code, inserts, file);
  const lines = decode(map.mappings);
  const origLines = code.split("\n");
  const genLines = out.split("\n");
  assert.equal(lines.length, origLines.length);
  // Each original token's generated column is its column plus the length of the inserts placed at
  // or before it on its line; the text there must be the token, and the segment there must point
  // back at the token's original line and column.
  let lineStart = 0;
  let checked = 0;
  for (let l = 0; l < origLines.length; l += 1) {
    const before = (col: number) =>
      inserts.filter((i) => i.offset >= lineStart && i.offset <= lineStart + col).reduce((n, i) => n + i.text.length, 0);
    for (const m of origLines[l]!.matchAll(/[\w$]+|[^\s\w$]/g)) {
      const genCol = m.index + before(m.index);
      assert.equal(genLines[l]!.slice(genCol, genCol + m[0].length), m[0], `line ${l + 1}: ${m[0]}`);
      const segment = lines[l]!.find(([g]) => g === genCol);
      assert.ok(segment, `line ${l + 1} col ${m.index}: no segment at generated column ${genCol}`);
      assert.deepEqual([segment[1], segment[2]], [l, m.index], `line ${l + 1}: ${m[0]}`);
      checked += 1;
    }
    lineStart += origLines[l]!.length + 1;
  }
  assert.ok(checked > 1000, `checked ${checked} tokens`);
});

/** Every .tsx file under src, transformed with the scan of src. */
function transformedSrc(): Array<{ rel: string; code: string; out: string }> {
  return sourceFiles(SRC)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => {
      const code = fs.readFileSync(f, "utf8");
      return { rel: relOf(f), code, out: annotate(code, relOf(f), realScan()) };
    });
}

test("every .tsx file under src still parses, keeps its lines, and every DOM tag gets data-ui-src", () => {
  const files = transformedSrc();
  assert.ok(files.length > 100);
  for (const { rel, code, out } of files) {
    const reparsed = parseSync(rel, out, { lang: "tsx" });
    assert.equal(reparsed.errors.length, 0, rel);
    assert.equal(out.split("\n").length, code.split("\n").length, rel);
    // Lowercase tags are DOM elements: none may be skipped, whatever the skip rule says.
    const missing: string[] = [];
    const visit = (node: any) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(visit);
      if (node.type === "JSXElement" && node.openingElement.name.type === "JSXIdentifier" && /^[a-z]/.test(node.openingElement.name.name)) {
        if (!node.openingElement.attributes.some((a: any) => a.name?.name === "data-ui-src")) missing.push(node.openingElement.name.name);
      }
      for (const key in node) visit(node[key]);
    };
    visit(reparsed.program);
    assert.deepEqual(missing, [], rel);
  }
});

test("real src: tags under contexts and children-only wrappers get the name of the component using them", () => {
  const byFile = new Map(transformedSrc().map((f) => [f.rel, f.out]));
  // WorkLogList's outermost tag is a context named without Context or Ctx (createContext in the file).
  assert.match(byFile.get("components/chat/WorkLog.tsx")!, /<GroupedRows value>\s*<div data-ui="WorkLogList"/);
  // RightPanelContent returns <SessionFolder>{(folder) => <div ...>}</SessionFolder>.
  assert.match(byFile.get("components/files/RightPanel.tsx")!, /\{\(folder\) => \(\s*<div data-ui="RightPanelContent"/);
  // The composer's model button: <Tooltip> holds state only, so the name goes to the trigger.
  assert.match(byFile.get("components/chat/ComposerModelButton.tsx")!, /<TooltipTrigger data-ui="ComposerModelButton"/);
});

/** Reads of the build's attributes in a source text: selectors, dataset and getAttribute. */
function attributeReads(text: string): string[] {
  // \x60 is a backtick (a literal one in the pattern trips Node's type stripping).
  const pattern =
    /\[data-ui(?:-src|-in)?[\]=~|^$*]|dataset\.ui(?:Src|In)?\b|Attribute\(\s*["'\x60]data-ui(?:-src|-in)?["'\x60]/g;
  return [...text.matchAll(pattern)].map((m) => m[0]);
}

/** The one page module that reads them: the debugging copy of an element's name (DESIGN.md 7e). */
const ATTRIBUTE_READERS = new Set(["lib/uiNameCopy.logic.ts"]);

test("page code never reads data-ui, data-ui-src or data-ui-in, except the name copy", () => {
  // They are labels for people; behavior selects on attributes of its own (data-session-picker,
  // data-composer-model-button and the like), so a change to the naming cannot break it.
  const reads: string[] = [];
  for (const f of [...sourceFiles(SRC), path.join(WEB, "index.html")]) {
    if (f.startsWith(path.join(SRC, "build") + path.sep)) continue;
    if (ATTRIBUTE_READERS.has(relOf(f))) continue;
    for (const read of attributeReads(fs.readFileSync(f, "utf8"))) reads.push(`${relOf(f)}: ${read}`);
  }
  assert.deepEqual(reads, []);
  // The exception is real: the module does read them, and nothing else is listed.
  assert.ok(attributeReads(fs.readFileSync(path.join(SRC, "lib/uiNameCopy.logic.ts"), "utf8")).length > 0);
  assert.equal(ATTRIBUTE_READERS.size, 1);
});

test("the dev server runs the plugin before the JSX compiler", async () => {
  // Through vite.config.ts itself, so a plugin added in front of it or a narrower filter shows here.
  const server = await createServer({
    root: WEB,
    configFile: path.join(WEB, "vite.config.ts"),
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "silent",
  });
  try {
    const result = await server.transformRequest("/src/components/MaruMark.tsx");
    assert.ok(result);
    assert.match(result.code, /"data-ui": "MaruMark"/);
    assert.match(result.code, /"data-ui-src": "components\/MaruMark.tsx:\d+"/);
  } finally {
    await server.close();
  }
});
