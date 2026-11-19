// Renders resources/icon.svg to resources/icon.png (1024 px, transparent corners) with Electron's
// own Chromium. electron-builder makes the Mac .icns and the Windows .ico from the PNG.
//   node_modules/.bin/electron scripts/render-icon.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.join(__dirname, "..", "resources");
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true,
    webPreferences: { offscreen: true, zoomFactor: 1 } });
  const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = (await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })).resize({ width: 1024, height: 1024 });
  fs.writeFileSync(path.join(dir, "icon.png"), image.toPNG());
  console.log(`icon.png ${image.getSize().width}x${image.getSize().height}`);
  app.quit();
});
