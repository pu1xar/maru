// Rewrites `import { XIcon, Trash2Icon } from "lucide-react-native"` into one default import per
// icon file (`lucide-react-native/dist/esm/icons/x.js`), so the bundle holds only the icons the app uses. Metro
// does not tree-shake, and the package's main entry re-exports all of its icons (about 1.8 MB of
// Hermes bytecode measured on 2026-11-19). TypeScript still reads the package's main entry.
//
// The name-to-file table is read from that entry's own `export { default as X } from './icons/x.js'`
// lines, so every name the package exports resolves the way the package resolves it. A name the
// table lacks fails the build. Type-only specifiers are dropped.
//
// The output names a path inside the package, never an absolute one: Metro caches this output by
// source content, so an absolute path from one checkout (a release folder) would reach the next.
// The package's "exports" map lists no such path; metro.config.js resolves the prefix to the file.
// metro.config.js also puts this file's hash in Metro's cache version, so editing it starts fresh.
const fs = require("node:fs");
const path = require("node:path");

const PACKAGE = "lucide-react-native";
let table = null;

function readTable() {
  if (table) return table;
  // The package exports no ./package.json; its require entry is dist/cjs/<name>.js beside dist/esm.
  const cjsEntry = require.resolve(PACKAGE, { paths: [path.join(__dirname, "..")] });
  const esmDir = path.join(path.dirname(cjsEntry), "..", "esm");
  const entry = fs.readFileSync(path.join(esmDir, `${PACKAGE}.js`), "utf8");
  table = new Map();
  for (const m of entry.matchAll(/export \{([^}]+)\} from '(\.\/[^']+)';/g)) {
    const file = `${PACKAGE}/dist/esm/${m[2].slice(2)}`;
    for (const part of m[1].split(",")) {
      const alias = /default as (\w+)/.exec(part.trim());
      if (alias) table.set(alias[1], file);
    }
  }
  if (table.size === 0) throw new Error(`lucideImports: no exports read from ${PACKAGE}'s entry`);
  return table;
}

module.exports = function lucideImports({ types: t }) {
  return {
    name: "lucide-imports",
    visitor: {
      ImportDeclaration(p) {
        if (p.node.source.value !== PACKAGE || p.node.importKind === "type") return;
        const names = readTable();
        const out = [];
        for (const s of p.node.specifiers) {
          if (s.importKind === "type") continue;
          if (!t.isImportSpecifier(s)) throw p.buildCodeFrameError(`lucideImports: only named imports from ${PACKAGE}`);
          const name = t.isIdentifier(s.imported) ? s.imported.name : s.imported.value;
          const file = names.get(name);
          if (!file) throw p.buildCodeFrameError(`lucideImports: ${PACKAGE} has no export ${name}`);
          out.push(t.importDeclaration([t.importDefaultSpecifier(t.identifier(s.local.name))], t.stringLiteral(file)));
        }
        if (out.length === 0) p.remove();
        else p.replaceWithMultiple(out);
      },
    },
  };
};
