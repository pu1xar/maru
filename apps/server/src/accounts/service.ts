// The accounts routes (DESIGN.md 6y, packages/shared/src/accounts.ts): the accounts screen's list
// with each login status, and the edits of the config file (userConfig.ts).
//
// Sign-in belongs to the provider's CLI. This service never receives, stores or passes on a
// token, password or code: "login" opens a shell and types the CLI's own sign-in command into it,
// and the person finishes it there. Whether an account is signed in is asked of the CLI (status.ts).
//
// The server's accounts are fixed when it starts (main.ts hands them to the sources, watchers and
// runs), so an edit is written to the file and applies at the next start; `pending` and
// `restartNeeded` tell the page what waits for it.
import fs from "node:fs";
import type http from "node:http";
import type { AccountRow, AccountsStatus, AddAccountRequest, ProviderId, ShellInfo } from "@maru/shared";
import { defaultAccountDir } from "@maru/shared";
import {
  ConfigEditError,
  ConfigError,
  addAccountToFile,
  configFile,
  expandHome,
  loadUserConfig,
  removeAccountFromFile,
  resolveClaudeBin,
  resolveCodexBin,
  setClaudeUsageInFile,
  setCodexUsageInFile,
  type ClaudeAccount,
  type CodexAccount,
} from "../userConfig.ts";
import { ShellError } from "../shell/service.ts";
import { hasControlChars, TmuxError } from "../shell/tmux.ts";
import { accountLoginStatus, type CliRunner } from "./status.ts";

export class AccountsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface AccountsServiceOptions {
  env: NodeJS.ProcessEnv;
  home: string;
  /** What the running server started with (config.ts). */
  running: { claude: readonly ClaudeAccount[]; codex: readonly CodexAccount[]; claudeUsage: boolean; codexUsage: boolean };
  /** The shells the login opens one in; null when there is no tmux. */
  shells: { create(req: { cwd: string | null }): Promise<ShellInfo>; typeLine(id: string, text: string): Promise<void> } | null;
  run?: CliRunner;
  codexBin?: string;
  log?: (line: string) => void;
}

interface Row {
  id: string;
  provider: ProviderId;
  dir: string;
}

/** A value for a POSIX shell (and fish): single-quoted, a quote inside as `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The line typed into the login shell. `env` carries the variable so the line reads the same in
 * bash, zsh and fish.
 */
export function loginCommand(provider: ProviderId, dir: string, claudeBin: string, codexBin = "codex"): string {
  return provider === "claude"
    ? `env CLAUDE_CONFIG_DIR=${shellQuote(dir)} ${shellQuote(claudeBin)} auth login`
    : `env CODEX_HOME=${shellQuote(dir)} ${shellQuote(codexBin)} login`;
}

export class AccountsService {
  private readonly opts: AccountsServiceOptions;
  /** Status reads in flight by account, so a page's burst of refreshes runs each CLI once. */
  private readonly inflight = new Map<string, Promise<AccountRow["status"]>>();

  constructor(opts: AccountsServiceOptions) {
    this.opts = opts;
  }

  private runningRows(): Row[] {
    return [
      ...this.opts.running.claude.map((a): Row => ({ id: a.id, provider: "claude", dir: a.dir })),
      ...this.opts.running.codex.map((a): Row => ({ id: a.id, provider: "codex", dir: a.home })),
    ];
  }

  private claudeBin(configured: string | null): string {
    return resolveClaudeBin(configured, this.opts.home);
  }

  private codexBin(): string {
    return this.opts.codexBin ?? resolveCodexBin(this.opts.env.PATH);
  }

  private statusOf(r: Row, claudeBin: string): Promise<AccountRow["status"]> {
    const key = `${r.provider}\0${r.id}\0${r.dir}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = accountLoginStatus(r.provider, r.dir, { run: this.opts.run, claudeBin, codexBin: this.codexBin() }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  async status(): Promise<AccountsStatus> {
    const { env, home } = this.opts;
    const file = configFile(env, home);
    const running = this.runningRows();
    let fileRows: Row[];
    let detectedClaude = false;
    let detectedCodex = false;
    let claudeUsage = this.opts.running.claudeUsage;
    let codexUsage = this.opts.running.codexUsage;
    let claudeBinConfigured: string | null = null;
    let configError: string | null = null;
    try {
      const loaded = loadUserConfig(env, home);
      fileRows = [
        ...loaded.config.claudeAccounts.map((a): Row => ({ id: a.id, provider: "claude", dir: a.dir })),
        ...loaded.config.codexAccounts.map((a): Row => ({ id: a.id, provider: "codex", dir: a.home })),
      ];
      detectedClaude = !loaded.explicit.claudeAccounts;
      detectedCodex = !loaded.explicit.codexAccounts;
      claudeUsage = loaded.config.claudeUsage;
      codexUsage = loaded.config.codexUsage;
      claudeBinConfigured = loaded.config.claudeBin;
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      configError = err.message;
      fileRows = running;
    }
    const same = (a: Row, b: Row) => a.id === b.id && a.provider === b.provider && a.dir === b.dir;
    const claudeBin = this.claudeBin(claudeBinConfigured);
    const rows: { row: Row; detected: boolean; pending: AccountRow["pending"] }[] = [
      ...fileRows.map((row) => ({
        row,
        detected: row.provider === "claude" ? detectedClaude : detectedCodex,
        pending: configError || running.some((r) => same(r, row)) ? null : ("add" as const),
      })),
      ...(configError ? [] : running.filter((r) => !fileRows.some((f) => same(f, r))).map((row) => ({ row, detected: false, pending: "remove" as const }))),
    ];
    const statuses = await Promise.all(rows.map((r) => this.statusOf(r.row, claudeBin)));
    const accounts: AccountRow[] = rows.map((r, i) => ({ ...r.row, status: statuses[i]!, detected: r.detected, pending: r.pending }));
    return {
      accounts,
      configFile: file,
      claudeUsage,
      claudeUsageRunning: this.opts.running.claudeUsage,
      codexUsage,
      codexUsageRunning: this.opts.running.codexUsage,
      restartNeeded:
        accounts.some((a) => a.pending !== null) ||
        claudeUsage !== this.opts.running.claudeUsage ||
        codexUsage !== this.opts.running.codexUsage,
      configError,
    };
  }

  async add(req: Partial<AddAccountRequest> | null): Promise<AccountsStatus> {
    const { env, home } = this.opts;
    if (!req || (req.provider !== "claude" && req.provider !== "codex") || typeof req.id !== "string") {
      throw new AccountsError(400, "provider and id are required");
    }
    const given = typeof req.dir === "string" ? req.dir.trim() : "";
    const where = given || defaultAccountDir(req.provider, req.id);
    this.guard(() => addAccountToFile(env, home, req.provider!, req.id!, where));
    // The CLI's sign-in needs the folder to exist (codex refuses a CODEX_HOME that does not).
    const abs = expandHome(where, home)!;
    try {
      fs.mkdirSync(abs, { recursive: true, mode: 0o700 });
    } catch (err) {
      this.opts.log?.(`accounts: cannot create ${abs}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.opts.log?.(`accounts: added ${req.provider} account ${req.id} (${abs})`);
    return this.status();
  }

  async remove(id: string): Promise<AccountsStatus> {
    this.guard(() => removeAccountFromFile(this.opts.env, this.opts.home, id));
    this.opts.log?.(`accounts: removed account ${id} from the config file`);
    return this.status();
  }

  async setClaudeUsage(enabled: unknown): Promise<AccountsStatus> {
    if (typeof enabled !== "boolean") throw new AccountsError(400, "enabled must be true or false");
    this.guard(() => setClaudeUsageInFile(this.opts.env, this.opts.home, enabled));
    return this.status();
  }

  async setCodexUsage(enabled: unknown): Promise<AccountsStatus> {
    if (typeof enabled !== "boolean") throw new AccountsError(400, "enabled must be true or false");
    this.guard(() => setCodexUsageInFile(this.opts.env, this.opts.home, enabled));
    return this.status();
  }

  /** Opens a shell and types the CLI's own sign-in into it; the person finishes it there. */
  async login(id: string): Promise<ShellInfo> {
    const { env, home, shells } = this.opts;
    if (!shells) throw new AccountsError(503, "tmux not found");
    let loaded;
    try {
      loaded = loadUserConfig(env, home);
    } catch (err) {
      if (err instanceof ConfigError) throw new AccountsError(409, err.message);
      throw err;
    }
    const claude = loaded.config.claudeAccounts.find((a) => a.id === id);
    const codex = loaded.config.codexAccounts.find((a) => a.id === id);
    const provider: ProviderId | null = claude ? "claude" : codex ? "codex" : null;
    const dir = claude?.dir ?? codex?.home;
    if (!provider || !dir) throw new AccountsError(404, `No account named "${id}"`);
    if (hasControlChars(dir)) throw new AccountsError(400, "The account folder contains control characters");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = loginCommand(provider, dir, this.claudeBin(loaded.config.claudeBin), this.codexBin());
    const shell = await shells.create({ cwd: null });
    await shells.typeLine(shell.id, line);
    this.opts.log?.(`accounts: sign-in for ${id} typed into shell ${shell.id}`);
    return shell;
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ConfigEditError) throw new AccountsError(err.status, err.message);
      if (err instanceof ConfigError) throw new AccountsError(400, err.message);
      throw err;
    }
  }

  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    io: { readJson(req: http.IncomingMessage): Promise<unknown>; sendJson(res: http.ServerResponse, code: number, body: unknown): void },
  ): Promise<boolean> {
    const p = url.pathname;
    const m = req.method;
    const idRoute = /^\/api\/accounts\/([^/]+)(\/login)?$/.exec(p);
    const known =
      p === "/api/accounts/status" || (p === "/api/accounts" && m === "POST") || p === "/api/settings/claude-usage" || p === "/api/settings/codex-usage" ||
      (idRoute !== null && idRoute[1] !== "status");
    if (!known) return false;
    try {
      if (p === "/api/accounts/status" && m === "GET") {
        io.sendJson(res, 200, await this.status());
        return true;
      }
      if (p === "/api/accounts" && m === "POST") {
        io.sendJson(res, 200, await this.add((await io.readJson(req)) as Partial<AddAccountRequest> | null));
        return true;
      }
      if (p === "/api/settings/claude-usage" && m === "PUT") {
        const body = (await io.readJson(req)) as { enabled?: unknown } | null;
        io.sendJson(res, 200, await this.setClaudeUsage(body?.enabled));
        return true;
      }
      if (p === "/api/settings/codex-usage" && m === "PUT") {
        const body = (await io.readJson(req)) as { enabled?: unknown } | null;
        io.sendJson(res, 200, await this.setCodexUsage(body?.enabled));
        return true;
      }
      if (idRoute) {
        const id = decodeURIComponent(idRoute[1]!);
        if (!idRoute[2] && m === "DELETE") {
          io.sendJson(res, 200, await this.remove(id));
          return true;
        }
        if (idRoute[2] && m === "POST") {
          // The body is empty; reading it holds the route to the JSON content type like every other POST.
          await io.readJson(req);
          io.sendJson(res, 200, await this.login(id));
          return true;
        }
      }
      io.sendJson(res, 404, { error: "not found" });
      return true;
    } catch (err) {
      if (err instanceof AccountsError || err instanceof ShellError) io.sendJson(res, err.status, { error: err.message });
      else if (err instanceof TmuxError) io.sendJson(res, 500, { error: `tmux: ${err.message}` });
      else throw err;
      return true;
    }
  }
}
