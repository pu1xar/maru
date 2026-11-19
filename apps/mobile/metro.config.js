// This app is its own package root (excluded from the pnpm workspace above it): Metro resolves
// packages only from this folder's node_modules. Two folders of the repository come in as source:
//   packages/shared   the server contract (`@maru/shared`, mostly `import type`)
//   apps/web/src      the web's pure session, thread and timeline logic (model.ts, threadState.ts,
//                     session-logic.ts, components/chat/*.logic.ts and what they import), so the
//                     phone groups sessions, applies live events and lays out a conversation
//                     exactly as the web does. src/lib/webShared.test.ts keeps that set pure.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const repo = path.resolve(__dirname, "../..");
const config = getDefaultConfig(__dirname);
config.watchFolders = [__dirname, path.join(repo, "packages", "shared"), path.join(repo, "apps", "web", "src")];
config.resolver.nodeModulesPaths = [path.join(__dirname, "node_modules")];
config.resolver.disableHierarchicalLookup = true;
config.resolver.extraNodeModules = { "@maru/shared": path.join(repo, "packages", "shared") };

// lucide icons one file each (babel/lucideImports.js): the plugin writes paths under the package's
// dist/, which its "exports" map does not list. They resolve here to the file in node_modules.
const LUCIDE_DIST = "lucide-react-native/dist/";
const resolveDefault = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(LUCIDE_DIST)) {
    return { type: "sourceFile", filePath: path.join(__dirname, "node_modules", moduleName) };
  }
  return resolveDefault ? resolveDefault(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
};
// Metro caches transformed files by content and does not hash Babel plugins, so a plugin edit
// would keep old output. The plugin's own hash in the cache version starts the cache fresh.
const pluginHash = require("node:crypto")
  .createHash("sha256")
  .update(require("node:fs").readFileSync(path.join(__dirname, "babel", "lucideImports.js")))
  .digest("hex")
  .slice(0, 12);
config.cacheVersion = `${config.cacheVersion ?? ""}lucide-${pluginHash}`;

module.exports = config;
