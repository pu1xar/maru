module.exports = function (api) {
  api.cache(true);
  // babel/lucideImports.js: one import per lucide icon file, so the bundle holds only the icons used.
  return { presets: ["babel-preset-expo"], plugins: ["./babel/lucideImports.js"] };
};
