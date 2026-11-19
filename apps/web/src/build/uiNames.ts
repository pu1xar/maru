// Element names for debugging in the browser's element inspector (DESIGN.md 7e). A build step, not
// page code: vite.config.ts runs `uiNamesPlugin` over every .tsx file under src before JSX is
// compiled, in dev and in the release build alike.
//
// - Every JSX tag gets `data-ui-src="<path under src>:<line>"`, the line of its `<`.
// - The outermost tags a function component returns also get `data-ui="<component name>"`, and so
//   do the props a primitive hands base-ui's useRender (ui/button.tsx and its kin draw no JSX).
// - Every tag written inside a function component also gets `data-ui-in="<that component's name>"`
//   (the nearest one, so a tag in a nested component names the nested one). It is left out when it
//   equals the tag's own data-ui, and on JSX outside any component (module level constants).
//
// All of them go first among the tag's attributes, so a value that arrives later through a props spread
// wins: a component that spreads its props onto its root shows the name and position of the tag
// that used it, and a primitive such as ui/button.tsx shows the line that used `<Button>`.
//
// These attributes are for people reading the inspector. Page code selects on attributes of its
// own (uiNames.test.ts fails when src reads data-ui, data-ui-src or data-ui-in; lib/uiNameCopy.ts,
// the debugging copy of an element's name, is the one reader).
import fs from "node:fs";
import path from "node:path";
import { parseSync, type Plugin } from "vite";

/** An AST node of the oxc ESTree output, read loosely: the walk reads only a few fields. */
type Node = { type: string; start: number; end: number; [key: string]: any };

/** Text to insert into the source at an offset (UTF-16 code units, as the parser reports). */
export interface Insert {
  offset: number;
  text: string;
}

/** Tags that never reach React as an element with props: nothing is added to them. */
const FRAGMENT = /^(?:[A-Za-z_$][\w$]*\.)?Fragment$/;

/**
 * Tags whose props reach no DOM element, so a name put on them would show nowhere. When a
 * component's outermost tag is one of these, the name goes to the tags inside it instead (its JSX
 * children, a function child's result, a JSX-valued prop such as `fallback`).
 *
 * Most of them `scanProject` finds in src: contexts (`createContext`), components that draw no
 * element from their own JSX (they return their children, a render function's result, a renderer's
 * output or nothing), and `const X = Y.Root` aliases of such tags. What it cannot see is listed:
 * - React's own components, and members of React (`React.Suspense`)
 * - components that draw an element of their own but hand their props to a provider:
 *   ToastProvider and AnchoredToastProvider pass theirs to `Toast.Provider` beside a portal
 */
const NO_DOM_EXACT = new Set(["Suspense", "StrictMode", "Profiler", "Activity", "ViewTransition", "ToastProvider", "AnchoredToastProvider"]);
const NO_DOM_MEMBER =
  /^(?:React\.[A-Za-z]+|.+\.(?:Provider|Consumer)|(?:Dialog|AlertDialog|Sheet|Menu|ContextMenu|Popover|PreviewCard|Select|Tooltip|Combobox|Autocomplete)(?:Primitive)?\.(?:Root|SubmenuRoot))$/;
/**
 * Context-like names (`<SomeContext value>`, dnd-kit's `DndContext`), for tags defined outside src.
 * A component in src under such a name that draws an element is not caught by it.
 */
const CONTEXT_NAME = /^(?:.+\.)?[A-Za-z_$][\w$]*(?:Context|Ctx)$/;

/** What a scan of src knows about tag names. */
export interface NoDomScan {
  /** Contexts, components and aliases whose props reach no DOM element. */
  noDom: ReadonlySet<string>;
  /** Components that draw an element of their own (JSX outermost tags or useRender). */
  drawsDom: ReadonlySet<string>;
}

export const EMPTY_SCAN: NoDomScan = { noDom: new Set(), drawsDom: new Set() };

export function rendersNoElement(tag: string, scan: NoDomScan = EMPTY_SCAN): boolean {
  if (FRAGMENT.test(tag) || NO_DOM_EXACT.has(tag) || NO_DOM_MEMBER.test(tag) || scan.noDom.has(tag)) return true;
  return CONTEXT_NAME.test(tag) && !scan.drawsDom.has(tag);
}

/** Function-like nodes: a component's return statements are searched without entering these. */
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassDeclaration",
  "ClassExpression",
]);

/** Wrappers around an expression that leave its value as is. */
const TRANSPARENT_EXPRESSIONS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "ChainExpression",
]);

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const key in node) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

/** The called function's name: `f(...)` and `a.b.f(...)` both give "f". */
function calleeName(call: Node): string | null {
  const callee = call.callee as Node;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && isNode(callee.property)) return callee.property.name;
  return null;
}

/** The function a declarator's initializer defines, through memo() and forwardRef(). */
function functionOf(init: Node | null | undefined): Node | null {
  let node = init ?? null;
  while (node) {
    if (TRANSPARENT_EXPRESSIONS.has(node.type)) node = node.expression;
    else if (node.type === "CallExpression" && ["memo", "forwardRef"].includes(calleeName(node) ?? "")) node = node.arguments[0] ?? null;
    else break;
  }
  return node && (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") ? node : null;
}

function startsUpper(name: string | null | undefined): name is string {
  return typeof name === "string" && /^[A-Z]/.test(name);
}

/** Function components and class components of a file, with their names. */
function findComponents(program: Node): Array<{ name: string; fn: Node }> {
  const named = new Map<Node, string>();
  const visit = (node: Node) => {
    if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") && startsUpper(node.id?.name)) {
      named.set(node, node.id.name);
    } else if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
      // `const Row = memo(function row() {...})`: the function's own name if it is a component
      // name, else the variable's.
      const fn = functionOf(node.init);
      const name = startsUpper(fn?.id?.name) ? fn.id.name : node.id.name;
      if (fn && !named.has(fn) && startsUpper(name)) named.set(fn, name);
    } else if ((node.type === "ClassDeclaration" || node.type === "ClassExpression") && startsUpper(node.id?.name)) {
      for (const member of node.body?.body ?? []) {
        if (member.type === "MethodDefinition" && member.key?.name === "render" && member.value) {
          named.set(member.value, node.id.name);
        }
      }
    }
    for (const child of children(node)) visit(child);
  };
  visit(program);
  return [...named].map(([fn, name]) => ({ name, fn }));
}

/** The expressions a function returns, without entering nested functions. */
function returnedExpressions(fn: Node): Node[] {
  if (fn.type === "ArrowFunctionExpression" && fn.expression) return [fn.body];
  const out: Node[] = [];
  const visit = (node: Node) => {
    if (node.type === "ReturnStatement") {
      if (node.argument) out.push(node.argument);
      return;
    }
    for (const child of children(node)) if (!FUNCTION_TYPES.has(child.type)) visit(child);
  };
  if (fn.body) visit(fn.body);
  return out;
}

/** `const name = <init>` declarations among a function body's own statements. */
function localConsts(fn: Node): Map<string, Node> {
  const out = new Map<string, Node>();
  const visit = (node: Node) => {
    if (node.type === "VariableDeclaration") {
      for (const d of node.declarations) {
        if (d.id?.type === "Identifier" && d.init) out.set(d.id.name, d.init);
      }
    }
    for (const child of children(node)) if (!FUNCTION_TYPES.has(child.type)) visit(child);
  };
  if (fn.body && fn.body.type === "BlockStatement") visit(fn.body);
  return out;
}

export function tagName(code: string, element: Node): string {
  const name = element.openingElement.name as Node;
  return code.slice(name.start, name.end);
}

/**
 * The JSX elements a returned expression puts outermost: both sides of conditions, through
 * fragments and tags that render no element, through `createPortal(x, ...)`, through a returned
 * `.map()` callback or render function, and through a local `const` that holds JSX.
 */
function outermostElements(code: string, scan: NoDomScan, expr: Node, consts: Map<string, Node>, out: Set<Node>, seen = new Set<string>()): void {
  if (!expr) return;
  const recurse = (e: Node) => outermostElements(code, scan, e, consts, out, seen);
  if (TRANSPARENT_EXPRESSIONS.has(expr.type)) return recurse(expr.expression);
  switch (expr.type) {
    case "ConditionalExpression":
      recurse(expr.consequent);
      recurse(expr.alternate);
      return;
    case "LogicalExpression":
      recurse(expr.left);
      recurse(expr.right);
      return;
    case "SequenceExpression":
      recurse(expr.expressions[expr.expressions.length - 1]);
      return;
    case "Identifier": {
      const init = consts.get(expr.name);
      if (init && !seen.has(expr.name)) {
        seen.add(expr.name);
        recurse(init);
      }
      return;
    }
    case "CallExpression": {
      const name = calleeName(expr);
      const first = expr.arguments[0] as Node | undefined;
      if (name === "createPortal" && first) recurse(first);
      // `items.map((item) => <Row />)` returned as is: each item's tag is outermost.
      if ((name === "map" || name === "flatMap") && first) recurse(first);
      return;
    }
    case "ArrowFunctionExpression":
    case "FunctionExpression": {
      // A map callback, or a render function given to a tag that draws no element
      // (`<ThreadFolder>{(folder) => <div />}</ThreadFolder>`): what it returns is outermost.
      const inner = new Map([...consts, ...localConsts(expr)]);
      for (const e of returnedExpressions(expr)) outermostElements(code, scan, e, inner, out, seen);
      return;
    }
    case "JSXFragment":
      for (const child of expr.children) outermostChild(child, recurse);
      return;
    case "JSXElement": {
      if (!rendersNoElement(tagName(code, expr), scan)) {
        out.add(expr);
        return;
      }
      // A JSX-valued prop of such a tag (Suspense or RenderErrorBoundary `fallback`) shows in its place.
      for (const attr of expr.openingElement.attributes) {
        if (attr.type === "JSXAttribute" && attr.value?.type === "JSXExpressionContainer") recurse(attr.value.expression);
      }
      for (const child of expr.children) outermostChild(child, recurse);
      return;
    }
  }
}

function outermostChild(child: Node, recurse: (e: Node) => void): void {
  if (child.type === "JSXElement" || child.type === "JSXFragment") recurse(child);
  else if (child.type === "JSXExpressionContainer" && child.expression.type !== "JSXEmptyExpression") recurse(child.expression);
}

function hasAttribute(element: Node, name: string): boolean {
  return element.openingElement.attributes.some(
    (attr: Node) => attr.type === "JSXAttribute" && attr.name?.type === "JSXIdentifier" && attr.name.name === name,
  );
}

/** Start offsets of each line, for offset to line lookups. */
function lineStarts(code: string): number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i += 1) if (code.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * The `props` property of each `useRender({ props, ... })` call a function makes itself. base-ui's
 * useRender draws the element of primitives such as ui/button.tsx without JSX. A method or getter
 * written as `props` is left alone.
 */
function useRenderProps(fn: Node): Node[] {
  const out: Node[] = [];
  const visit = (node: Node) => {
    if (node.type === "CallExpression" && calleeName(node) === "useRender") {
      const options = node.arguments[0] as Node | undefined;
      if (options?.type === "ObjectExpression") {
        for (const prop of options.properties) {
          if (prop.type === "Property" && prop.kind === "init" && !prop.method && !prop.computed && prop.key?.type === "Identifier" && prop.key.name === "props") {
            out.push(prop);
          }
        }
      }
    }
    for (const child of children(node)) if (!FUNCTION_TYPES.has(child.type)) visit(child);
  };
  if (fn.body) visit(fn.body);
  return out;
}

function parse(code: string, file: string): Node | null {
  const parsed = parseSync(file, code, { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
  return parsed.errors.length > 0 ? null : (parsed.program as unknown as Node);
}

interface Component {
  name: string;
  fn: Node;
  roots: Set<Node>;
  renderProps: Node[];
}

function componentsOf(code: string, program: Node, scan: NoDomScan): Component[] {
  return findComponents(program).map(({ name, fn }) => {
    const consts = localConsts(fn);
    const roots = new Set<Node>();
    for (const expr of returnedExpressions(fn)) outermostElements(code, scan, expr, consts, roots);
    return { name, fn, roots, renderProps: useRenderProps(fn) };
  });
}

/** `const X = createContext(...)` and `const X = Y.Z` declarations anywhere in a file. */
function declarations(program: Node, code: string): { contexts: string[]; aliases: Array<[string, string]> } {
  const contexts: string[] = [];
  const aliases: Array<[string, string]> = [];
  const visit = (node: Node) => {
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init) {
      let init = node.init as Node;
      while (TRANSPARENT_EXPRESSIONS.has(init.type)) init = init.expression;
      if (init.type === "CallExpression" && calleeName(init) === "createContext") contexts.push(node.id.name);
      if (init.type === "MemberExpression" && !init.computed && startsUpper(node.id.name)) {
        aliases.push([node.id.name, code.slice(init.start, init.end)]);
      }
    }
    for (const child of children(node)) visit(child);
  };
  visit(program);
  return { contexts, aliases };
}

/**
 * Which tag names in src render no element of their own, and which components do. Contexts and
 * aliases come from declarations; a component counts as drawing no element when, with what is
 * known so far, it has no outermost tag and no useRender. Repeated until nothing changes, since a
 * component that only returns another such component joins on the next round. A name defined both
 * ways (two components sharing it) counts as drawing an element.
 */
export function scanProject(files: ReadonlyArray<{ file: string; code: string }>): NoDomScan {
  const parsed = files.flatMap(({ file, code }) => {
    const program = parse(code, file);
    return program ? [{ file, code, program, ...declarations(program, code) }] : [];
  });
  const noDom = new Set<string>(parsed.flatMap((p) => p.contexts));
  let drawsDom = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    const scan: NoDomScan = { noDom, drawsDom };
    const draws = new Set<string>();
    const none = new Set<string>();
    for (const p of parsed) {
      if (!p.file.endsWith(".tsx")) continue;
      for (const c of componentsOf(p.code, p.program, scan)) {
        (c.roots.size > 0 || c.renderProps.length > 0 ? draws : none).add(c.name);
      }
    }
    for (const p of parsed) for (const [alias, target] of p.aliases) if (rendersNoElement(target, scan)) none.add(alias);
    for (const name of none) {
      if (!draws.has(name) && !noDom.has(name)) {
        noDom.add(name);
        changed = true;
      }
    }
    if (draws.size !== drawsDom.size) changed = true;
    drawsDom = draws;
  }
  return { noDom, drawsDom };
}

/**
 * Each component of a file: the line of its function, the tags that get its name, and whether it
 * draws its element through useRender (that element gets the name too).
 */
export function componentRoots(
  code: string,
  file: string,
  scan: NoDomScan = EMPTY_SCAN,
): Array<{ name: string; line: number; roots: Array<{ tag: string; line: number }>; useRender: boolean }> {
  const program = parse(code, file);
  if (!program) return [];
  const starts = lineStarts(code);
  return componentsOf(code, program, scan).map(({ name, fn, roots, renderProps }) => ({
    name,
    line: lineOf(starts, fn.start),
    roots: [...roots].map((root) => ({ tag: tagName(code, root), line: lineOf(starts, root.start) })),
    useRender: renderProps.length > 0,
  }));
}

/**
 * What to insert into a .tsx file's source: `data-ui-src` on every tag that can carry props, and
 * `data-ui` on each component's outermost tags and on the props it gives useRender (put under the
 * props it already passes, so a caller's data-ui still wins), and `data-ui-in` on every tag inside
 * a component. `file` is the path shown in the
 * attribute; `scan` is what scanProject found in src. A file the parser rejects gets nothing (the
 * JSX compiler reports its error).
 */
export function uiNameInserts(code: string, file: string, scan: NoDomScan = EMPTY_SCAN): Insert[] {
  const program = parse(code, file);
  if (!program) return [];
  const components = componentsOf(code, program, scan);

  const names = new Map<Node, string>();
  // A tag outermost in two components (a nested component returning an outer one's const) keeps
  // the first name; the walk meets the outer function first.
  for (const { name, roots } of components) {
    for (const root of roots) if (!names.has(root)) names.set(root, name);
  }

  // The function nodes that are components, to find the nearest one around a tag.
  const componentOfFn = new Map<Node, string>(components.map((c) => [c.fn, c.name]));
  const inComponent: string[] = [];

  const starts = lineStarts(code);
  const inserts: Insert[] = [];
  const visit = (node: Node) => {
    const owner = componentOfFn.get(node);
    if (owner !== undefined) inComponent.push(owner);
    if (node.type === "JSXElement" && !rendersNoElement(tagName(code, node), scan)) {
      const opening = node.openingElement as Node;
      const parts: string[] = [];
      const name = names.get(node);
      if (name && !hasAttribute(node, "data-ui")) parts.push(`data-ui="${name}"`);
      const within = inComponent.at(-1);
      if (within !== undefined && within !== name && !hasAttribute(node, "data-ui-in")) parts.push(`data-ui-in="${within}"`);
      if (!hasAttribute(node, "data-ui-src")) {
        parts.push(`data-ui-src={${JSON.stringify(`${file}:${lineOf(starts, node.start)}`)}}`);
      }
      if (parts.length > 0) {
        const after = (opening.typeArguments as Node | null) ?? (opening.name as Node);
        inserts.push({ offset: after.end, text: ` ${parts.join(" ")}` });
      }
    }
    for (const child of children(node)) visit(child);
    if (owner !== undefined) inComponent.pop();
  };
  visit(program);
  for (const { name, renderProps } of components) {
    for (const prop of renderProps) {
      const value = prop.value as Node;
      if (prop.shorthand) {
        inserts.push({ offset: prop.end, text: `: { "data-ui": "${name}", ...${code.slice(value.start, value.end)} }` });
      } else {
        inserts.push({ offset: value.start, text: `{ "data-ui": "${name}", ...(` });
        inserts.push({ offset: value.end, text: ") }" });
      }
    }
  }
  return inserts.sort((a, b) => a.offset - b.offset);
}

const VLQ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function vlq(value: number): string {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += VLQ_CHARS[digit];
  } while (v > 0);
  return out;
}

export interface SourceMapV3 {
  version: 3;
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
}

/** Character classes whose boundaries get a source map segment: a word, a space run, each other character. */
function charClass(ch: string): number {
  if (/[\w$]/.test(ch)) return 1;
  if (ch === " " || ch === "\t" || ch === "\r") return 2;
  return 3;
}

/**
 * Applies inserts and builds the source map back to the original. Inserts come sorted by offset
 * and hold no line break, so every line keeps its number. Each line gets a segment at every token
 * boundary (a word, a space run, each other character), shifted by the inserts before it, and one
 * at each insert's start pointing at the column it was inserted at. Tools that compose maps (Vite
 * chains this one under the JSX compiler's) keep exact columns that way.
 */
export function applyInserts(code: string, inserts: Insert[], source: string): { code: string; map: SourceMapV3 } {
  for (let i = 0; i < inserts.length; i += 1) {
    if (i > 0 && inserts[i]!.offset < inserts[i - 1]!.offset) throw new Error("applyInserts: inserts are not sorted by offset");
    if (/[\r\n\u2028\u2029]/.test(inserts[i]!.text)) throw new Error("applyInserts: an insert holds a line break");
  }
  const starts = lineStarts(code);
  let out = "";
  let last = 0;
  for (const insert of inserts) {
    out += code.slice(last, insert.offset) + insert.text;
    last = insert.offset;
  }
  out += code.slice(last);

  const lines: string[] = [];
  let prevOrigLine = 0;
  let prevOrigCol = 0;
  let next = 0;
  for (let line = 0; line < starts.length; line += 1) {
    const start = starts[line]!;
    const end = line + 1 < starts.length ? starts[line + 1]! - 1 : code.length;
    const segments: string[] = [];
    let prevGenCol = 0;
    const segment = (genCol: number, origCol: number) => {
      segments.push(vlq(genCol - prevGenCol) + vlq(0) + vlq(line - prevOrigLine) + vlq(origCol - prevOrigCol));
      prevGenCol = genCol;
      prevOrigLine = line;
      prevOrigCol = origCol;
    };
    let shift = 0;
    for (let col = 0; col <= end - start; col += 1) {
      const offset = start + col;
      while (next < inserts.length && inserts[next]!.offset === offset) {
        segment(col + shift, col);
        shift += inserts[next]!.text.length;
        next += 1;
      }
      if (offset === end) break;
      const ch = code[offset]!;
      if (col === 0 || charClass(ch) === 3 || charClass(ch) !== charClass(code[offset - 1]!)) segment(col + shift, col);
    }
    lines.push(segments.join(","));
  }
  return {
    code: out,
    map: { version: 3, sources: [source], sourcesContent: [code], names: [], mappings: lines.join(";") },
  };
}

/** The page's .ts and .tsx files under `dir`: outside node_modules, without tests and .d.ts. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(entry.name) && !/\.(?:test|d)\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/**
 * Vite plugin: names the elements of every .tsx file under `srcDir`. It scans src once before the
 * first transform, and again before the next transform after the dev server sees a source file
 * change.
 */
export function uiNamesPlugin(srcDir: string): Plugin {
  const root = path.resolve(srcDir);
  let scan: NoDomScan | null = null;
  const inSrc = (file: string): string | null => {
    const rel = path.relative(root, file);
    if (rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).includes("node_modules")) return null;
    return rel.split(path.sep).join("/");
  };
  return {
    name: "maru:ui-names",
    enforce: "pre",
    buildStart() {
      scan = null;
    },
    watchChange(id) {
      if (/\.tsx?$/.test(id) && inSrc(id) !== null) scan = null;
    },
    transform: {
      filter: { id: /\.tsx(?:\?|$)/ },
      handler(code, id) {
        const file = id.split("?")[0]!;
        const rel = inSrc(file);
        if (rel === null) return null;
        scan ??= scanProject(sourceFiles(root).map((f) => ({ file: f, code: fs.readFileSync(f, "utf8") })));
        const inserts = uiNameInserts(code, rel, scan);
        if (inserts.length === 0) return null;
        return applyInserts(code, inserts, file);
      },
    },
  };
}
