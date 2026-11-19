import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { CreateShellRequest, ShellInfo } from "@maru/shared";
import { lastActiveShell, rememberActiveShell } from "../../../web/src/lib/shellTabs.ts";
import { endShell, shellGone, showShell } from "./actions.ts";
import type { ShellApi } from "./api.ts";
import { ShellListStore } from "./listStore.ts";

let n = 0;
const make = (command = "zsh"): ShellInfo => ({ id: `sh-${String(++n).padStart(12, "0")}`, cwd: "/", createdAt: n, command, path: "/", clients: 0 });

/** A server the tests steer: the shells it has, the requests it saw, and gates that hold an answer back. */
function rig(initial: ShellInfo[] = []) {
  const server = { shells: [...initial], creates: [] as CreateShellRequest[], closed: [] as string[], missingFolders: new Set<string>() };
  const gates: { list?: Promise<void>; create?: Promise<void> } = {};
  const api: ShellApi = {
    async list() {
      const snapshot = [...server.shells];
      await gates.list;
      return snapshot;
    },
    async create(req) {
      server.creates.push(req);
      await gates.create;
      if (req.cwd && server.missingFolders.has(req.cwd)) throw new Error(`Folder not found: ${req.cwd}`);
      const s = make();
      server.shells.push(s);
      return s;
    },
    async close(id) {
      server.closed.push(id);
      server.shells = server.shells.filter((s) => s.id !== id);
    },
  };
  return { server, gates, store: new ShellListStore(api) };
}

beforeEach(() => rememberActiveShell(null));

test("the list is null until the first read, then the server's", async () => {
  const { store, server } = rig([make(), make("vim")]);
  assert.equal(store.getSnapshot().shells, null);
  const alive = await store.refresh();
  assert.deepEqual(store.getSnapshot().shells?.map((s) => s.id), server.shells.map((s) => s.id));
  assert.deepEqual([...alive!], server.shells.map((s) => s.id));
});

test("a failed read leaves the list as it was", async () => {
  const shells = [make()];
  let fail = false;
  const store = new ShellListStore({
    list: async () => {
      if (fail) throw new Error("down");
      return shells;
    },
    create: async () => shells[0]!,
    close: async () => undefined,
  });
  await store.refresh();
  fail = true;
  assert.equal(await store.refresh(), null);
  assert.deepEqual(store.getSnapshot().shells, shells);
});

test("a read that began before a change this store made is not used", async () => {
  const { store, server, gates } = rig();
  let release!: () => void;
  gates.list = new Promise<void>((r) => (release = r));
  const stale = store.refresh();
  delete gates.create;
  const made = await store.create(null);
  release();
  assert.equal(await stale, null, "the old read could not list the new shell");
  assert.deepEqual(store.getSnapshot().shells?.map((s) => s.id), [made.id]);
  assert.equal(server.shells.length, 1);
});

test("a new shell starts in the session's folder, or the home folder when there is none or the folder is gone", async () => {
  const { store, server } = rig();
  await store.create("/Users/x/proj");
  await store.create(null);
  await store.create("relative/path");
  server.missingFolders.add("/gone");
  await store.create("/gone");
  assert.deepEqual(server.creates, [{ cwd: "/Users/x/proj" }, { cwd: null }, { cwd: null }, { cwd: "/gone" }, { cwd: null }]);
  assert.equal(store.getSnapshot().shells?.length, 4);
});

test("a second create while one is on its way gets that shell, so two taps make one shell", async () => {
  const { store, server, gates } = rig();
  let release!: () => void;
  gates.create = new Promise<void>((r) => (release = r));
  const a = store.create("/x");
  const b = store.create("/x");
  assert.equal(store.getSnapshot().creating, true);
  release();
  const [sa, sb] = await Promise.all([a, b]);
  assert.equal(sa.id, sb.id);
  assert.equal(server.creates.length, 1);
  assert.equal(store.getSnapshot().creating, false);
});

test("a create that fails clears `creating` and says why", async () => {
  const store = new ShellListStore({
    list: async () => [],
    create: async () => {
      throw new Error("tmux not found");
    },
    close: async () => undefined,
  });
  await assert.rejects(store.create(null), /tmux not found/);
  assert.equal(store.getSnapshot().creating, false);
  await assert.rejects(store.create(null), /tmux not found/, "and a later create tries again");
});

test("subscribers hear every change and can leave", async () => {
  const { store } = rig([make()]);
  let heard = 0;
  const off = store.subscribe(() => heard++);
  await store.refresh();
  assert.equal(heard, 1);
  off();
  await store.refresh();
  assert.equal(heard, 1);
});

test("ending a shell leaves its right neighbor, else its left, and closes the screen on the last", async () => {
  const [a, b, c] = [make(), make(), make()];
  const { store, server } = rig([a, b, c]);
  await store.refresh();
  showShell(b.id);
  assert.equal(lastActiveShell(), b.id);
  assert.deepEqual(await endShell(store, b.id), { closeScreen: false });
  assert.equal(lastActiveShell(), c.id, "the right neighbor");
  assert.deepEqual(server.closed, [b.id]);
  assert.deepEqual(store.getSnapshot().shells?.map((s) => s.id), [a.id, c.id]);
  assert.deepEqual(await endShell(store, c.id), { closeScreen: false });
  assert.equal(lastActiveShell(), a.id, "the left one when there is no right");
  assert.deepEqual(await endShell(store, a.id), { closeScreen: true });
  assert.deepEqual(store.getSnapshot().shells, []);
});

test("a shell that exits is gone once: the second report finds nothing to do", async () => {
  const [a, b] = [make(), make()];
  const { store } = rig([a, b]);
  await store.refresh();
  showShell(a.id);
  assert.deepEqual(shellGone(store, a.id), { closeScreen: false });
  assert.equal(lastActiveShell(), b.id);
  assert.deepEqual(shellGone(store, a.id), { closeScreen: false });
  assert.equal(lastActiveShell(), b.id);
  assert.deepEqual(shellGone(store, b.id), { closeScreen: true });
});

test("ending a shell that is not the shown one keeps the shown one", async () => {
  const [a, b] = [make(), make()];
  const { store } = rig([a, b]);
  await store.refresh();
  showShell(a.id);
  await endShell(store, b.id);
  assert.equal(lastActiveShell(), a.id);
});

test("a close the server refuses changes nothing", async () => {
  const [a] = [make()];
  const store = new ShellListStore({
    list: async () => [a],
    create: async () => a,
    close: async () => {
      throw new Error("tmux: boom");
    },
  });
  await store.refresh();
  showShell(a.id);
  await assert.rejects(endShell(store, a.id), /boom/);
  assert.deepEqual(store.getSnapshot().shells, [a]);
  assert.equal(lastActiveShell(), a.id);
});
