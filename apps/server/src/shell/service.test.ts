// The shell terminals end to end with the real tmux and node-pty: the web server's routes and view
// socket, a tmux server on a socket of the test's own, /bin/sh as the shell. Skipped without tmux.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { parseShellServerFrame, type ShellInfo, type ShellServerFrame } from "@maru/shared";
import { SessionIndex } from "../index/store.ts";
import { ProjectStore } from "../projects/store.ts";
import { ChosenStore } from "../state/chosen.ts";
import { VisibleIndex } from "../index/visible.ts";
import { createServer } from "../http/server.ts";
import { ShellService, type ShellServiceOptions } from "./service.ts";
import { nodePtySpawn } from "./pty.ts";
import { resolveTmux, shellEnv, shellUser, tmuxRunner } from "./tmux.ts";

const TMUX = resolveTmux();

async function rig(extra: Partial<ShellServiceOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maru-shell-"));
  const socket = path.join(dir, "shell.sock");
  const env = shellEnv(process.env, { ...shellUser(), shell: "/bin/sh" });
  const make = () => new ShellService({ tmux: TMUX, socket, shell: "/bin/sh", env, pingMs: 60_000, ...extra });
  let shells = make();
  const projects = new ProjectStore(":memory:");
  const chosen = new ChosenStore(":memory:");
  const view = new VisibleIndex(new SessionIndex((s) => s), chosen);
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const webDir = path.join(dir, "web");
  fs.mkdirSync(webDir);
  // The route object stays; a "restart" swaps the service behind it.
  const routes = { handle: (...a: Parameters<ShellService["handle"]>) => shells.handle(...a), attach: (...a: Parameters<ShellService["attach"]>) => shells.attach(...a) };
  const web = createServer({ view, projects, chosen, guard, webDir, shells: routes });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
  const port = (web.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  guard.origins.add(`http://127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    port,
    dir,
    socket,
    env,
    restart() {
      shells.shutdown();
      shells = make();
    },
    async create(body: Record<string, unknown>): Promise<ShellInfo> {
      const res = await fetch(`${base}/api/shells`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json()) as ShellInfo;
    },
    async list(): Promise<ShellInfo[]> {
      const res = await fetch(`${base}/api/shells`);
      return ((await res.json()) as { shells: ShellInfo[] }).shells;
    },
    async close() {
      shells.shutdown();
      web.closeAllConnections();
      await new Promise((r) => web.close(r));
      await tmuxRunner(TMUX!, socket, env)(["kill-server"]).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A view socket that collects output as text and control frames. */
function openView(base: string, id: string, cols: number, rows: number, origin?: string) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/shell?id=${id}&cols=${cols}&rows=${rows}`, origin ? { origin } : {});
  const frames: ShellServerFrame[] = [];
  let output = "";
  let closeCode: number | null = null;
  const waiters: (() => void)[] = [];
  const poke = () => waiters.splice(0).forEach((w) => w());
  ws.on("message", (data, isBinary) => {
    if (isBinary) output += Buffer.from(data as Buffer).toString("utf8");
    else {
      const f = parseShellServerFrame(String(data));
      if (f) frames.push(f);
    }
    poke();
  });
  ws.on("close", (code) => {
    closeCode = code;
    poke();
  });
  const until = (cond: () => boolean, what: string, ms = 8000) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; output: ${JSON.stringify(output.slice(-400))}`)), ms);
      const check = () => {
        if (cond()) {
          clearTimeout(timer);
          resolve();
        } else waiters.push(check);
      };
      check();
    });
  return {
    ws,
    frames,
    get output() {
      return output;
    },
    get closeCode() {
      return closeCode;
    },
    type: (s: string) => ws.send(Buffer.from(s, "utf8")),
    resize: (c: number, r: number) => ws.send(JSON.stringify({ type: "resize", cols: c, rows: r })),
    until,
    opened: new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
      ws.once("error", reject);
    }),
  };
}

test("a shell opens, runs commands with Korean text, resizes, survives a server restart and keeps its scrollback", { skip: !TMUX }, async () => {
  const r = await rig();
  try {
    const cwd = fs.realpathSync(os.tmpdir());
    const shell = await r.create({ cwd });
    assert.equal(shell.cwd, cwd);
    assert.deepEqual((await r.list()).map((s) => s.id), [shell.id]);

    const v = openView(r.base, shell.id, 80, 10);
    await v.opened;
    await v.until(() => v.frames.some((f) => f.type === "attached"), "attached");
    v.type("pwd; echo 'mark-'\"한글\"'-end'\r");
    await v.until(() => v.output.includes("mark-한글-end"), "echo output");
    assert.ok(v.output.includes(cwd), "pwd prints the session folder");
    v.resize(100, 20);
    // tmux redraws for the new size (its scroll region spans the 20 rows); the pane's own tty may
    // take its size a moment later, so the shell is asked until it answers with the new one.
    await v.until(() => v.output.includes("\x1b[1;20r"), "redraw at 20 rows");
    for (let i = 0; i < 20 && !/20 100/.test(v.output); i++) {
      v.type("stty size\r");
      await new Promise((r) => setTimeout(r, 150));
    }
    await v.until(() => /20 100/.test(v.output), "stty size after resize");
    v.type("i=1; while [ $i -le 40 ]; do echo \"hist $i\"; i=$((i+1)); done\r");
    await v.until(() => v.output.includes("hist 40"), "40 lines");

    // The web server restarts: the attached client ends, the shell does not.
    r.restart();
    await v.until(() => v.closeCode !== null, "socket closed by the restart");
    assert.equal(v.frames.filter((f) => f.type === "ended").length, 0, "a restart is no end");
    assert.deepEqual((await r.list()).map((s) => s.id), [shell.id]);

    const again = openView(r.base, shell.id, 100, 20);
    await again.opened;
    await again.until(() => again.output.includes("hist 1\r\n"), "scrollback read back from tmux");
    again.type("echo after-restart\r");
    await again.until(() => again.output.includes("after-restart"), "the same shell answers");

    // Closing from the button ends every view with "closed".
    const res = await fetch(`${r.base}/api/shells/${shell.id}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    await again.until(() => again.frames.some((f) => f.type === "ended"), "ended");
    assert.deepEqual(again.frames.at(-1), { type: "ended", reason: "closed" });
    assert.deepEqual(await r.list(), []);
    assert.equal((await fetch(`${r.base}/api/shells/${shell.id}`, { method: "DELETE" })).status, 404);
  } finally {
    await r.close();
  }
});

test("folder names and keys stay text: tmux formats, a trailing ';' and control characters", { skip: !TMUX }, async () => {
  const r = await rig();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maru-shell-names-")));
  try {
    // `#(cmd)` would run in the tmux server, whose folder is the socket folder.
    const marker = path.join(r.dir, "PWNED");
    for (const name of ["x#(touch PWNED)", "b#{session_name}#S", "a;"]) {
      const dir = path.join(base, name);
      fs.mkdirSync(dir);
      const shell = await r.create({ cwd: dir });
      assert.equal(shell.path, dir, `the shell starts in ${name}`);
      assert.equal(shell.cwd, dir);
    }
    assert.equal(fs.existsSync(marker), false, "no #(...) ran");
    for (const body of [{ cwd: `${base}/x\x1fy` }]) {
      const res = await fetch(`${r.base}/api/shells`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(res.status, 400);
    }
    // Input sent the moment the socket opens waits for the client's first output (its raw mode).
    const shell = await r.create({ cwd: base });
    const v = openView(r.base, shell.id, 80, 24);
    await v.opened;
    v.type("echo early-$((40+2))\r");
    await v.until(() => v.output.includes("early-42"), "early input ran once");
  } finally {
    await r.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("exit ends the view with 'exited'; a gone id, a bad grid and a foreign page are refused", { skip: !TMUX }, async () => {
  const r = await rig();
  try {
    const shell = await r.create({ cwd: null });
    assert.equal(shell.cwd, os.homedir());
    const v = openView(r.base, shell.id, 80, 24);
    await v.opened;
    await v.until(() => v.frames.some((f) => f.type === "attached"), "attached");
    v.type("exit\r");
    await v.until(() => v.frames.some((f) => f.type === "ended"), "ended");
    assert.deepEqual(v.frames.at(-1), { type: "ended", reason: "exited" });

    const gone = openView(r.base, shell.id, 80, 24);
    await gone.opened;
    await gone.until(() => gone.frames.length > 0, "a frame");
    assert.deepEqual(gone.frames[0], { type: "ended", reason: "missing" });

    const bad = openView(r.base, "sh-aaaaaaaaaaaa", 0, 24);
    await bad.opened;
    await bad.until(() => bad.frames.length > 0, "a frame");
    assert.equal(bad.frames[0]?.type, "ended");

    const foreign = openView(r.base, "sh-aaaaaaaaaaaa", 80, 24, "https://evil.example");
    await assert.rejects(foreign.opened, /status 403/);

    const missingDir = await fetch(`${r.base}/api/shells`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/no/such/dir" }),
    });
    assert.equal(missingDir.status, 400);
  } finally {
    await r.close();
  }
});

test("a shell made before shells were global (it carries a session key option) is listed and closable", { skip: !TMUX }, async () => {
  const r = await rig();
  try {
    const run = tmuxRunner(TMUX!, r.socket, r.env);
    await run(["start-server"]);
    // What an earlier version made: its own session option `@maru_key` on an `sh-` session.
    await run(["new-session", "-d", "-s", "sh-legacy000001", "-c", os.tmpdir(), "--", "/bin/sh"]);
    await run(["set-option", "-t", "sh-legacy000001", "@maru_key", "claude:acc:old"]);
    await run(["set-option", "-t", "sh-legacy000001", "@maru_cwd", os.tmpdir()]);
    const fresh = await r.create({ cwd: null });
    assert.deepEqual((await r.list()).map((s) => s.id).sort(), [fresh.id, "sh-legacy000001"].sort());
    assert.equal((await fetch(`${r.base}/api/shells/sh-legacy000001`, { method: "DELETE" })).status, 200);
    assert.deepEqual((await r.list()).map((s) => s.id), [fresh.id]);
  } finally {
    await r.close();
  }
});

test("a resize that reaches a view whose tmux client just ended does not take the server down", { skip: !TMUX }, async () => {
  // node-pty throws EBADF from resize() once the pty is closed; a view socket can still send one then.
  const real = nodePtySpawn();
  const r = await rig({
    spawnPty: (file, args, options) => {
      const pty = real(file, args, options);
      return new Proxy(pty, {
        get: (target, key) => {
          if (key === "resize") {
            return () => {
              throw new Error("ioctl(2) failed, EBADF");
            };
          }
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  });
  try {
    const shell = await r.create({ cwd: null });
    const v = openView(r.base, shell.id, 80, 10);
    await v.opened;
    await v.until(() => v.frames.some((f) => f.type === "attached"), "attached");
    v.resize(90, 12);
    v.type("echo still-alive\n");
    await v.until(() => /still-alive/.test(v.output.replace("echo still-alive", "")), "output after the failing resize");
    assert.deepEqual((await r.list()).map((s) => s.id), [shell.id]);
  } finally {
    await r.close();
  }
});
