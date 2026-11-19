// The accounts routes through the real web server: the config file in a scratch home, the CLIs
// replaced by a runner and a stand-in script, the login in a real tmux shell (skipped without tmux).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { AccountsStatus, ShellInfo } from "@maru/shared";
import { SessionIndex } from "../index/store.ts";
import { ProjectStore } from "../projects/store.ts";
import { ChosenStore } from "../state/chosen.ts";
import { VisibleIndex } from "../index/visible.ts";
import { createServer } from "../http/server.ts";
import { ShellService } from "../shell/service.ts";
import { resolveTmux, shellEnv, shellUser } from "../shell/tmux.ts";
import { AccountsService, loginCommand, shellQuote } from "./service.ts";
import type { CliRunner } from "./status.ts";

const TMUX = resolveTmux();

interface Rig {
  base: string;
  home: string;
  file: string;
  claudeCalls: { bin: string; args: string[]; dir: string | undefined }[];
  post(p: string, body?: unknown): Promise<{ status: number; body: any }>;
  req(method: string, p: string, body?: unknown): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

async function rig(opts: { config?: unknown; claudeDirs?: string[]; signedIn?: (provider: string, dir: string) => boolean; running?: "file" | { claude: { id: string; dir: string }[]; codex: { id: string; home: string }[]; claudeUsage: boolean; codexUsage: boolean } } = {}): Promise<Rig> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maru-acc-")));
  const file = path.join(home, ".config", "maru", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const shellDir = path.join(home, "sh");
  const env = shellEnv({ ...process.env, HOME: home }, { ...shellUser(), shell: "/bin/sh", home });
  const shells = new ShellService({ tmux: TMUX, socket: path.join(shellDir, "s.sock"), shell: "/bin/sh", env, pingMs: 60_000 });
  const claudeCalls: Rig["claudeCalls"] = [];
  const run: CliRunner = async (bin, args, e) => {
    // The process environment may carry either variable already; the command tells the provider.
    const isClaude = args[0] === "auth";
    const dir = isClaude ? e.CLAUDE_CONFIG_DIR : e.CODEX_HOME;
    if (isClaude) claudeCalls.push({ bin, args, dir });
    const signed = opts.signedIn?.(isClaude ? "claude" : "codex", dir!) ?? false;
    return isClaude
      ? { code: signed ? 0 : 1, stdout: JSON.stringify({ loggedIn: signed }), stderr: "", missing: false, timedOut: false }
      : { code: signed ? 0 : 1, stdout: signed ? "Logged in using ChatGPT\n" : "Not logged in\n", stderr: "", missing: false, timedOut: false };
  };
  // No MARU_CONFIG: the default path under the scratch home, which is `file`, and a missing file means "detect".
  const envFile = {} as NodeJS.ProcessEnv;
  if (opts.config !== undefined) fs.writeFileSync(file, JSON.stringify(opts.config));
  for (const d of opts.claudeDirs ?? []) fs.mkdirSync(d, { recursive: true });
  const { loadUserConfig } = await import("../userConfig.ts");
  const startup = opts.running && opts.running !== "file" ? opts.running : (() => {
    const c = loadUserConfig(envFile, home).config;
    return { claude: c.claudeAccounts, codex: c.codexAccounts, claudeUsage: c.claudeUsage, codexUsage: c.codexUsage };
  })();
  const service = new AccountsService({ env: envFile, home, running: startup, shells, run });
  const projects = new ProjectStore(":memory:");
  const chosen = new ChosenStore(":memory:");
  const view = new VisibleIndex(new SessionIndex((s) => s), chosen);
  const guard = { hosts: new Set<string>(), origins: new Set<string>() };
  const webDir = path.join(home, "web");
  fs.mkdirSync(webDir);
  const web = createServer({ view, projects, chosen, guard, webDir, shells, accountSettings: service });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
  const port = (web.address() as AddressInfo).port;
  guard.hosts.add(`127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;
  const req: Rig["req"] = async (method, p, body) => {
    const r = await fetch(base + p, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return {
    base, home, file, claudeCalls, req,
    post: (p, body) => req("POST", p, body ?? {}),
    async close() {
      shells.shutdown();
      for (const s of await shells.list()) await shells.close(s.id);
      web.close();
      web.closeAllConnections();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("shellQuote and loginCommand build lines the shell reads back as the same words", () => {
  assert.equal(shellQuote("/a b/it's"), `'/a b/it'\\''s'`);
  assert.equal(loginCommand("claude", "/h/.claude-w", "/h/bin/claude"), "env CLAUDE_CONFIG_DIR='/h/.claude-w' '/h/bin/claude' auth login");
  assert.equal(loginCommand("codex", "/h/.codex-w", "/x", "codex"), "env CODEX_HOME='/h/.codex-w' 'codex' login");
});

test("GET /api/accounts/status lists the file's accounts with the CLI's answer and marks the detected ones", async () => {
  const r = await rig({ claudeDirs: [], signedIn: (_p, dir) => dir.endsWith(".claude") });
  try {
    fs.mkdirSync(path.join(r.home, ".claude"));
    // No file yet is not the case here: the file exists but lists only codex, so Claude is detected.
    fs.writeFileSync(r.file, JSON.stringify({ codexAccounts: [{ id: "cx", home: "~/.codex-cx" }] }));
    fs.mkdirSync(path.join(r.home, ".codex-cx"));
    const out = (await r.req("GET", "/api/accounts/status")).body as AccountsStatus;
    assert.deepEqual(out.accounts.map((a) => [a.id, a.provider, a.status, a.detected]), [
      ["claude", "claude", "signed-in", true],
      ["cx", "codex", "not-signed-in", false],
    ]);
    assert.equal(out.configFile, r.file);
    assert.equal(out.configError, null);
  } finally {
    await r.close();
  }
});

test("adding an account writes the file, makes the folder, and shows it as waiting for a restart", async () => {
  const r = await rig();
  try {
    const bad = await r.post("/api/accounts", { provider: "claude", id: "bad id" });
    assert.equal(bad.status, 400);
    const added = await r.post("/api/accounts", { provider: "claude", id: "work" });
    assert.equal(added.status, 200);
    const out = added.body as AccountsStatus;
    assert.deepEqual(JSON.parse(fs.readFileSync(r.file, "utf8")).claudeAccounts, [{ id: "work", dir: "~/.claude-work" }]);
    assert.equal(fs.statSync(path.join(r.home, ".claude-work")).isDirectory(), true);
    assert.deepEqual(out.accounts.map((a) => [a.id, a.pending, a.status]), [["work", "add", "not-signed-in"]]);
    assert.equal(out.restartNeeded, true);
    assert.equal((await r.post("/api/accounts", { provider: "codex", id: "work" })).status, 409, "ids are unique across providers");
    assert.equal((await r.post("/api/accounts", { provider: "other", id: "x" })).status, 400);
    const codex = await r.post("/api/accounts", { provider: "codex", id: "gpt", dir: "~/elsewhere" });
    assert.equal(codex.status, 200);
    assert.equal(fs.existsSync(path.join(r.home, "elsewhere")), true);
  } finally {
    await r.close();
  }
});

test("removing an account edits the file only, and the running account shows as pending removal", async () => {
  const r = await rig({ config: { claudeAccounts: [{ id: "a", dir: "~/.claude-a" }, { id: "b", dir: "~/.claude-b" }] }, claudeDirs: [] });
  try {
    fs.mkdirSync(path.join(r.home, ".claude-b"));
    const res = await r.req("DELETE", "/api/accounts/b");
    assert.equal(res.status, 200);
    const out = res.body as AccountsStatus;
    assert.deepEqual(out.accounts.map((a) => [a.id, a.pending]), [["a", null], ["b", "remove"]]);
    assert.equal(fs.existsSync(path.join(r.home, ".claude-b")), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(r.file, "utf8")).claudeAccounts, [{ id: "a", dir: "~/.claude-a" }]);
    assert.equal((await r.req("DELETE", "/api/accounts/zzz")).status, 404);
    assert.equal((await r.req("DELETE", "/api/accounts/status")).status, 404, "status is a route, not an id");
  } finally {
    await r.close();
  }
});

test("PUT /api/settings/codex-usage writes the switch; it is a restart item until the running value matches", async () => {
  const r = await rig({ config: { claudeAccounts: [] } });
  try {
    assert.equal((await r.req("PUT", "/api/settings/codex-usage", { enabled: "yes" })).status, 400);
    const on = (await r.req("PUT", "/api/settings/codex-usage", { enabled: true })).body as AccountsStatus;
    assert.deepEqual([on.codexUsage, on.codexUsageRunning, on.claudeUsage, on.restartNeeded], [true, false, false, true]);
    assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).codexUsage, true);
    const off = (await r.req("PUT", "/api/settings/codex-usage", { enabled: false })).body as AccountsStatus;
    assert.deepEqual([off.codexUsage, off.restartNeeded], [false, false]);
  } finally {
    await r.close();
  }
});

test("PUT /api/settings/claude-usage writes the switch; it is a restart item until the running value matches", async () => {
  const r = await rig({ config: { claudeAccounts: [] } });
  try {
    assert.equal((await r.req("PUT", "/api/settings/claude-usage", { enabled: "yes" })).status, 400);
    const on = (await r.req("PUT", "/api/settings/claude-usage", { enabled: true })).body as AccountsStatus;
    assert.deepEqual([on.claudeUsage, on.claudeUsageRunning, on.restartNeeded], [true, false, true]);
    assert.equal(JSON.parse(fs.readFileSync(r.file, "utf8")).claudeUsage, true);
    const off = (await r.req("PUT", "/api/settings/claude-usage", { enabled: false })).body as AccountsStatus;
    assert.deepEqual([off.claudeUsage, off.restartNeeded], [false, false]);
  } finally {
    await r.close();
  }
});

test("a file that cannot be read is reported with its reason and the running accounts", async () => {
  const r = await rig({ config: { claudeAccounts: [{ id: "a", dir: "~/.claude-a" }] } });
  try {
    fs.writeFileSync(r.file, "{ broken");
    const out = (await r.req("GET", "/api/accounts/status")).body as AccountsStatus;
    assert.match(out.configError ?? "", /not valid JSON/);
    assert.deepEqual(out.accounts.map((a) => [a.id, a.pending]), [["a", null]]);
    assert.equal((await r.post("/api/accounts", { provider: "claude", id: "x" })).status, 400);
    assert.equal(fs.readFileSync(r.file, "utf8"), "{ broken");
  } finally {
    await r.close();
  }
});

test("the routes take JSON only and answer nothing for a method they do not have", async () => {
  const r = await rig();
  try {
    const res = await fetch(`${r.base}/api/accounts`, { method: "POST", body: "{}" });
    assert.equal(res.status, 415);
    const login = await fetch(`${r.base}/api/accounts/x/login`, { method: "POST" });
    assert.equal(login.status, 415, "the sign-in start takes the JSON content type like every POST");
    assert.equal((await r.req("PUT", "/api/accounts/status", {})).status, 404);
  } finally {
    await r.close();
  }
});

test("login opens a shell and types the CLI's own sign-in into it (a stand-in CLI records what it was given)", { skip: !TMUX }, async () => {
  const r = await rig();
  try {
    const record = path.join(r.home, "record.txt");
    const fake = path.join(r.home, "bin dir", "fake claude");
    fs.mkdirSync(path.dirname(fake), { recursive: true });
    fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s|%s\\n' "$CLAUDE_CONFIG_DIR" "$*" > ${shellQuote(record)}\n`, { mode: 0o755 });
    fs.writeFileSync(r.file, JSON.stringify({ claudeBin: fake, claudeAccounts: [{ id: "w", dir: "~/.claude-w" }] }));
    assert.equal((await r.post("/api/accounts/nope/login")).status, 404);
    const res = await r.post("/api/accounts/w/login");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const shell = res.body as ShellInfo;
    assert.match(shell.id, /^sh-[a-z0-9]{12}$/);
    for (let i = 0; i < 100 && !fs.existsSync(record); i++) await new Promise((x) => setTimeout(x, 50));
    assert.equal(fs.readFileSync(record, "utf8"), `${path.join(r.home, ".claude-w")}|auth login\n`);
    assert.equal(fs.statSync(path.join(r.home, ".claude-w")).isDirectory(), true);
  } finally {
    await r.close();
  }
});
