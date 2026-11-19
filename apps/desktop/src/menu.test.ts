import { test } from "node:test";
import assert from "node:assert/strict";
import type { MenuItemConstructorOptions } from "electron";
import { menuTemplate } from "./menu.ts";

const noop = { checkForUpdates() {}, closeWindow() {}, openSettings() {}, unpair() {}, zoom() {}, toggleKeepOnTop() {} };

function items(menu: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return menu.flatMap((m) => [m, ...items((m.submenu as MenuItemConstructorOptions[] | undefined) ?? [])]);
}

test("menu: T3's layout, the update check in the app menu on a Mac and in Help everywhere", () => {
  const mac = menuTemplate("darwin", "maru", noop);
  assert.deepEqual(mac.map((m) => m.label), ["maru", "File", "Edit", "View", "Window", "Help"]);
  assert.equal(items(mac).filter((i) => i.label === "Check for updates...").length, 2);
  const win = menuTemplate("win32", "maru", noop);
  assert.deepEqual(win.map((m) => m.label), ["File", "Edit", "View", "Window", "Help"]);
  assert.equal(items(win).filter((i) => i.label === "Check for updates...").length, 1);
  assert.ok(items(win).some((i) => i.role === "quit"));
});

test("menu: no item takes ⌘W (the page's pane close), copy and paste have their roles", () => {
  for (const platform of ["darwin", "win32"] as const) {
    const all = items(menuTemplate(platform, "maru", noop));
    assert.ok(!all.some((i) => typeof i.accelerator === "string" && /^(CmdOrCtrl|Cmd|Command|Ctrl)\+W$/i.test(i.accelerator)), platform);
    for (const role of ["copy", "paste", "cut", "selectAll", "undo"]) assert.ok(all.some((i) => i.role === role), `${platform} ${role}`);
  }
  const close = items(menuTemplate("darwin", "maru", noop)).find((i) => i.label === "Close window");
  assert.ok(close && !close.role && !close.accelerator, "a plain item, not the close role with its default ⌘W");
});

test("menu: Zoom in and out are click items on the zoom keys, Actual size stays the reset role", () => {
  for (const platform of ["darwin", "win32"] as const) {
    const calls: number[] = [];
    const all = items(menuTemplate(platform, "maru", { ...noop, zoom: (d) => void calls.push(d) }));
    assert.ok(!all.some((i) => i.role === "zoomIn" || i.role === "zoomOut"), `${platform} no page-zoom roles`);
    const ins = all.filter((i) => i.label === "Zoom in");
    const out = all.filter((i) => i.label === "Zoom out");
    assert.deepEqual(ins.map((i) => i.accelerator), ["CmdOrCtrl+Plus", "CmdOrCtrl+="], platform);
    assert.deepEqual(out.map((i) => i.accelerator), ["CmdOrCtrl+-"], platform);
    assert.deepEqual(ins.map((i) => i.visible), [undefined, false], "the = twin is hidden");
    assert.equal(ins[1]!.acceleratorWorksWhenHidden, true);
    for (const i of [...ins, ...out]) assert.ok(!i.role && typeof i.click === "function");
    (ins[0]!.click as () => void)();
    (ins[1]!.click as () => void)();
    (out[0]!.click as () => void)();
    assert.deepEqual(calls, [1, 1, -1], platform);
    assert.equal(all.filter((i) => i.role === "resetZoom").length, 1);
  }
});

test("menu: the Window menu has Keep on top, a checkbox that starts off and disabled and calls the action", () => {
  for (const platform of ["darwin", "win32"] as const) {
    let calls = 0;
    const menu = menuTemplate(platform, "maru", { ...noop, toggleKeepOnTop: () => void calls++ });
    const windowMenu = menu.find((m) => m.label === "Window")!;
    const item = (windowMenu.submenu as MenuItemConstructorOptions[]).find((i) => i.id === "keep-on-top");
    assert.ok(item, platform);
    assert.equal(item.label, "Keep on top");
    assert.equal(item.type, "checkbox");
    assert.equal(item.checked, false);
    assert.equal(item.enabled, false);
    assert.ok(!item.accelerator, "no accelerator: a key would reach the page's own keys first");
    (item.click as () => void)();
    assert.equal(calls, 1, platform);
    assert.equal(items(menu).filter((i) => i.id === "keep-on-top").length, 1);
  }
});
