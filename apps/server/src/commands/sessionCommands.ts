// The composer's `/` menu (GET /api/session-commands) and the model picker's list
// (GET /api/session-models): what a session can run, per provider.
//
// Claude: the session's own process when this server runs it (Query.supportedCommands, which
// follows the CLI's commands_changed, and supportedModels). Otherwise a listing CLI that is sent
// no message (ClaudeDriver.probe), cached per account and working folder, since the lists come
// from the account (user skills and commands, plugins, user settings) and the folder (.claude/ of
// the folder and its parents). A cached answer is used while its fingerprint (commandSourcesStamp)
// still matches; refresh=1 reads it again. A run's list is not cached: a running process can hold
// commands of its own session.
//
// Codex: the commands this server runs through the daemon (codexCommands.ts), then the enabled
// skills the daemon lists for the session's folder, used as `$name` in the message text. Models
// come from the daemon's model/list.
//
// Every list carries maru's handling of a command (sessionControls.ts): a picker maru opens, or a
// command maru does not support, dimmed with its reason. Those the SDK does not list (the CLI's
// screens) are added after the provider's own.
import fs from "node:fs";
import path from "node:path";
import type { ModelInfo, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { CommandHandling, ModelOption, ProviderId, SessionCommand, SessionCommandsResponse, SessionModelsResponse } from "@maru/shared";
import { CLAUDE_HANDLED, CODEX_HANDLED, commandHandling, withOneMillionRows } from "@maru/shared";
import type { ClaudeAccount } from "../config.ts";
import type { SessionIndex } from "../index/store.ts";
import type { SkillMetadata } from "../codex/protocol/v2/SkillMetadata.ts";
import type { Model as CodexModel } from "../codex/protocol/v2/Model.ts";
import { DEFAULT_EXECUTABLE, type ProbeInfo } from "../claude/driver.ts";
import { CODEX_COMMANDS } from "../drive/codexCommands.ts";

/** A refused or failed listing. `status` is the HTTP status, `message` the text the UI shows. */
export class SessionCommandsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SessionCommandsError";
    this.status = status;
  }
}

/** What the process this server runs for a session says about its models (Query.supportedModels, initializationResult). */
export interface RunModels {
  models: ModelInfo[];
  outputStyles: string[];
}

export interface SessionCommandsDeps {
  index: Pick<SessionIndex, "get">;
  claudeAccounts: ClaudeAccount[];
  /** The list of the process this server runs for the session, or null when it runs none (ClaudeRuns.commandsOf). */
  claudeRun: (key: string) => Promise<SlashCommand[]> | null;
  /** Models of the process this server runs for the session, or null when it runs none (ClaudeRuns.modelsOf). */
  claudeRunModels?: (key: string) => Promise<RunModels> | null;
  /** A listing CLI for the account and folder (ClaudeDriver.probe). */
  claudeProbe: (opts: { accountDir: string; cwd: string }) => Promise<ProbeInfo>;
  /** Fingerprint of the files a Claude list comes from. Default: commandSourcesStamp. */
  claudeStamp?: (accountDir: string, cwd: string) => string;
  /** Enabled skills for a Codex session's folder (CodexRuns.skills). */
  codexSkills: (key: string, opts: { reload?: boolean }) => Promise<SkillMetadata[]>;
  /** The daemon's model/list for a Codex session's account (CodexRuns.models). */
  codexModels?: (key: string) => Promise<CodexModel[]>;
  now?: () => number;
}

interface Cached {
  stamp: string;
  commands: SessionCommand[];
  models: ModelOption[];
  outputStyles: string[];
  readAt: number;
}

const KEY_RE = /^(claude|codex):[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class SessionCommands {
  private deps: SessionCommandsDeps;
  /** `<account dir>\0<cwd>` -> the last probe's answer. */
  private cache = new Map<string, Cached>();
  /** Probes running now, so one menu opened twice starts one CLI. */
  private probes = new Map<string, Promise<Cached>>();

  constructor(deps: SessionCommandsDeps) {
    this.deps = deps;
  }

  async list(key: string, opts: { refresh?: boolean } = {}): Promise<SessionCommandsResponse> {
    const { provider, session } = this.session(key);
    if (provider === "codex") {
      let skills: SkillMetadata[];
      try {
        skills = await this.deps.codexSkills(key, { reload: opts.refresh === true });
      } catch (err) {
        throw new SessionCommandsError(502, `Could not read the Codex skill list: ${errorMessage(err)}`);
      }
      return { key, commands: withHandling("codex", [...CODEX_COMMANDS, ...skills.map(skillCommand)]), from: "daemon", readAt: this.now() };
    }
    const live = this.deps.claudeRun(key);
    if (live) {
      try {
        return { key, commands: withHandling("claude", (await live).map(slashCommand)), from: "run", readAt: this.now() };
      } catch (err) {
        throw new SessionCommandsError(502, `Could not read the command list: ${errorMessage(err)}`);
      }
    }
    const { entry, from } = await this.probed(session, opts.refresh === true);
    return { key, commands: entry.commands, from, readAt: entry.readAt };
  }

  /** The model picker's rows (GET /api/session-models). */
  async models(key: string): Promise<SessionModelsResponse> {
    const { provider, session } = this.session(key);
    if (provider === "codex") {
      if (!this.deps.codexModels) throw new SessionCommandsError(503, "Codex model list is disabled");
      let models: CodexModel[];
      try {
        models = await this.deps.codexModels(key);
      } catch (err) {
        throw new SessionCommandsError(502, `Could not read the Codex model list: ${errorMessage(err)}`);
      }
      return { key, options: models.filter((m) => !m.hidden).map(codexModelOption), from: "daemon" };
    }
    const live = this.deps.claudeRunModels?.(key) ?? null;
    if (live) {
      try {
        const r = await live;
        return { key, options: claudeModelOptions(r.models), outputStyles: r.outputStyles, from: "run" };
      } catch (err) {
        throw new SessionCommandsError(502, `Could not read the model list: ${errorMessage(err)}`);
      }
    }
    const { entry, from } = await this.probed(session, false);
    return { key, options: entry.models, outputStyles: entry.outputStyles, from };
  }

  private session(key: string) {
    const m = KEY_RE.exec(key);
    if (!m) throw new SessionCommandsError(400, `Not a session key: ${key}`);
    const session = this.deps.index.get(key);
    if (!session) throw new SessionCommandsError(404, `Session not found: ${key}`);
    return { provider: m[1] as ProviderId, session };
  }

  /** The listing CLI's answer for the session's account and folder, from the cache while its stamp holds. */
  private async probed(s: { account: string; cwd: string | null }, refresh: boolean): Promise<{ entry: Cached; from: "probe" | "cache" }> {
    const account = this.deps.claudeAccounts.find((a) => a.id === s.account);
    if (!account) throw new SessionCommandsError(404, `Unknown account: ${s.account}`);
    if (!s.cwd || !fs.existsSync(s.cwd)) {
      throw new SessionCommandsError(409, `Cannot read the command list because the working folder is missing: ${s.cwd ?? "(none)"}`);
    }
    const cacheKey = `${account.dir}\0${s.cwd}`;
    const stamp = (this.deps.claudeStamp ?? commandSourcesStamp)(account.dir, s.cwd);
    const hit = this.cache.get(cacheKey);
    if (!refresh && hit && hit.stamp === stamp) return { entry: hit, from: "cache" };
    let probe = this.probes.get(cacheKey);
    if (!probe) {
      const cwd = s.cwd;
      probe = (async () => {
        const info = await this.deps.claudeProbe({ accountDir: account.dir, cwd });
        const entry: Cached = {
          stamp,
          commands: withHandling("claude", info.commands.map(slashCommand)),
          models: claudeModelOptions(info.models),
          outputStyles: info.outputStyles,
          readAt: this.now(),
        };
        this.cache.set(cacheKey, entry);
        return entry;
      })();
      this.probes.set(cacheKey, probe);
      const settle = () => {
        if (this.probes.get(cacheKey) === probe) this.probes.delete(cacheKey);
      };
      probe.then(settle, settle);
    }
    try {
      return { entry: await probe, from: "probe" };
    } catch (err) {
      throw new SessionCommandsError(502, `Could not read the command list: ${errorMessage(err)}`);
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

/**
 * The provider's list with maru's handling on each command it covers, then the commands maru
 * handles that the list lacks (the CLI screens the SDK leaves out): pickers, then the ones this
 * server runs, then the unsupported. A command this server runs carries no handling: to the
 * composer it is a plain command.
 */
export function withHandling(provider: ProviderId, commands: SessionCommand[]): SessionCommand[] {
  const shown = (handling: CommandHandling | null) => (handling && handling.kind !== "server" ? handling : null);
  const out = commands.map((c) => {
    if (c.sigil !== "/") return c;
    const handling = shown(commandHandling(provider, c.name, commands));
    return handling ? { ...c, handling } : c;
  });
  const names = new Set(commands.filter((c) => c.sigil === "/").flatMap((c) => [c.name, ...c.aliases]));
  const handled = provider === "claude" ? CLAUDE_HANDLED : CODEX_HANDLED;
  const missing = handled.filter((h) => !names.has(h.name));
  const rank = { picker: 0, server: 1, unsupported: 2 } as const;
  const ordered = [...missing].sort((a, b) => rank[a.handling.kind] - rank[b.handling.kind]);
  for (const h of ordered) {
    const handling = shown(h.handling);
    out.push({
      name: h.name, sigil: "/", description: h.description, argumentHint: h.argumentHint, aliases: [...(h.aliases ?? [])], source: "builtin",
      ...(handling ? { handling } : {}),
    });
  }
  return out;
}

export function slashCommand(c: SlashCommand): SessionCommand {
  return {
    name: c.name,
    sigil: "/",
    description: c.description ?? "",
    argumentHint: c.argumentHint ?? "",
    aliases: c.aliases ?? [],
    source: c.builtin ? "builtin" : "custom",
  };
}

export function skillCommand(s: SkillMetadata): SessionCommand {
  return {
    name: s.name,
    sigil: "$",
    description: s.interface?.shortDescription ?? s.shortDescription ?? s.description,
    argumentHint: "",
    aliases: [],
    source: "custom",
  };
}

/** The CLI writes " · " between a model's name and its blurb; the UI uses no middle dot. */
function plain(text: string): string {
  return text.replace(/\s*·\s*/g, ", ");
}

/** The picker's Claude rows: the SDK's models, each that can run at 1M followed by its "(1M)" row (oneMillion.ts). */
export function claudeModelOptions(models: readonly ModelInfo[]): ModelOption[] {
  return withOneMillionRows(models.map(claudeModelOption));
}

export function claudeModelOption(m: ModelInfo): ModelOption {
  return {
    value: m.value,
    resolved: m.resolvedModel ?? null,
    label: plain(m.displayName),
    description: plain(m.description),
    efforts: m.supportsEffort ? [...(m.supportedEffortLevels ?? [])] : [],
    defaultEffort: null,
    isDefault: m.value === "default",
    ...(m.supportsFastMode ? { fast: true } : {}),
  };
}

export function codexModelOption(m: CodexModel): ModelOption {
  return {
    value: m.model,
    resolved: m.model,
    label: plain(m.displayName),
    description: plain(m.description),
    efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    effortNotes: Object.fromEntries(m.supportedReasoningEfforts.filter((e) => e.description).map((e) => [e.reasoningEffort, plain(e.description)])),
    defaultEffort: m.defaultReasoningEffort ?? null,
    isDefault: m.isDefault,
  };
}

/**
 * Fingerprint of the files a Claude session's commands come from: the CLI version (its builtins);
 * in the account, settings.json (enabled plugins), plugins/installed_plugins.json, the SKILL.md of
 * every folder under skills/ and the .md files under commands/; for the working folder and each
 * parent, .claude/settings.json, .claude/settings.local.json, the same skills/ and commands/
 * files under .claude/, and .mcp.json. A directory's own entry counts too, so an added or removed
 * skill or command changes it.
 */
export function commandSourcesStamp(accountDir: string, cwd: string, executable: string = DEFAULT_EXECUTABLE): string {
  const parts: string[] = [];
  const add = (p: string) => {
    try {
      const st = fs.statSync(p);
      parts.push(`${p} ${st.mtimeMs} ${st.size}`);
    } catch {
      parts.push(`${p} -`);
    }
  };
  const seen = new Set<string>();
  const tree = (dir: string) => {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      parts.push(`${dir} -`);
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    add(dir);
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const p = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) tree(p);
      else if (name.endsWith(".md")) add(p);
    }
  };
  const skills = (dir: string) => {
    add(dir);
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) add(path.join(dir, name, "SKILL.md"));
  };
  try {
    parts.push(fs.realpathSync(executable));
  } catch {
    parts.push(`${executable} -`);
  }
  add(path.join(accountDir, "settings.json"));
  add(path.join(accountDir, "plugins", "installed_plugins.json"));
  skills(path.join(accountDir, "skills"));
  tree(path.join(accountDir, "commands"));
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const claudeDir = path.join(dir, ".claude");
    add(path.join(claudeDir, "settings.json"));
    add(path.join(claudeDir, "settings.local.json"));
    tree(path.join(claudeDir, "commands"));
    skills(path.join(claudeDir, "skills"));
    add(path.join(dir, ".mcp.json"));
    if (path.dirname(dir) === dir) break;
  }
  return parts.join("\n");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
