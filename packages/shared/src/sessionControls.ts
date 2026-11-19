// Composer commands maru runs with its own screen instead of sending them as text (DESIGN.md 6m).
//
// Claude Code's `/model`, `/effort`, `/permissions` and the like open a screen inside the CLI
// (local-jsx). A session maru drives runs the CLI through the Agent SDK, where those screens do
// not exist: in 2.1.325 a few print a line of text instead (`/model` without a name prints the
// current model and the names it takes) and the rest answer "/x isn't available in this
// environment". The SDK has control requests for some of them (setModel, applyFlagSettings,
// setPermissionMode, mcpServerStatus, toggleMcpServer, reconnectMcpServer, accountInfo), so maru
// shows its own picker for those or runs them on the server, and says in one line above the
// composer that the others are not supported.
// Codex: the daemon reads no slash command at all; its TUI's `/model` becomes a model and effort
// for this server's next turn/start.
import type { ProviderId, SettablePermissionMode } from "./index.ts";
import { isOneMillionModel, withoutOneMillion } from "./oneMillion.ts";

/** The pickers the composer opens (components/chat/SessionPicker.tsx). */
export type SessionPickerKind = "model" | "effort" | "permissions" | "mcp" | "output-style" | "fast";

/**
 * What maru does with `/name` typed in the composer.
 * picker       `/name` alone opens maru's picker; `/name <arg>` goes to the server, which does
 *              the same as picking <arg> (also from the terminal mode and the app)
 * unsupported  not sent: the composer says it in one line, the `/` menu shows it dimmed with `reason`
 * server       the composer sends it as it is and this server runs it in the CLI's place (a notice
 *              or an action); the `/` menu lists it as a plain command
 */
export type CommandHandling =
  | { kind: "picker"; picker: SessionPickerKind }
  | { kind: "unsupported"; reason: string }
  | { kind: "server" };

/** A command maru handles itself, as the `/` menu lists it. */
export interface HandledCommand {
  name: string;
  /** Other names the provider takes for it (Codex `/cwd` for `/pwd`). */
  aliases?: readonly string[];
  description: string;
  argumentHint: string;
  handling: CommandHandling;
}

const NOT_HERE = "Not supported in maru";

function unsupported(name: string, description: string, why?: string, more: Partial<HandledCommand> = {}): HandledCommand {
  return { name, description, argumentHint: "", handling: { kind: "unsupported", reason: why ? `${NOT_HERE}: ${why}` : NOT_HERE }, ...more };
}

function picker(name: string, description: string, argumentHint: string, kind: SessionPickerKind): HandledCommand {
  return { name, description, argumentHint, handling: { kind: "picker", picker: kind } };
}

function server(name: string, description: string, argumentHint = ""): HandledCommand {
  return { name, description, argumentHint, handling: { kind: "server" } };
}

/**
 * Claude Code 2.1.325. Pickers and server commands: SDK control requests do what the CLI screen
 * does (status: Query.accountInfo and mcpServerStatus; plan: setPermissionMode; exit: closing the
 * process). Unsupported: no control request does it, and the CLI in an SDK session answers
 * "/name isn't available in this environment" with no model call (measured 2026-11-16 for every
 * one here, CLI in stream-json mode; /focus says "isn't available here yet"). A user's own command
 * or skill of the same name runs in its place (measured: commands/hooks.md and skills/plan ran as
 * prompts), so these are refused, or run by this server, only when the session's list lacks such a
 * command (commandHandling).
 */
export const CLAUDE_HANDLED: readonly HandledCommand[] = [
  picker("model", "Change the model and effort", "[model]", "model"),
  picker("effort", "Change the effort", "[low|medium|high|xhigh|max|auto]", "effort"),
  picker("permissions", "Change the permission mode", "[default|acceptEdits|plan|bypassPermissions]", "permissions"),
  picker("mcp", "MCP server status, enable, disable, reconnect", "[enable|disable|reconnect <server>]", "mcp"),
  picker("output-style", "Change the output style", "[style]", "output-style"),
  picker("fast", "Turn fast mode on or off", "[on|off]", "fast"),
  server("status", "Session status: model, effort, mode, account, MCP"),
  server("plan", "Switch to plan mode, text after it is sent in that mode", "[message]"),
  server("exit", "Close the session"),
  unsupported("resume", "Resume a conversation", "open sessions from the sidebar"),
  unsupported("tasks", "List and manage background tasks", "use the Activity tab in the right panel"),
  unsupported("bashes", "List and manage background tasks", "use the Activity tab in the right panel"),
  unsupported("workflows", "View workflow runs", "use the Activity tab in the right panel"),
  unsupported("hooks", "Manage hook configurations"),
  unsupported("memory", "Edit Claude memory files"),
  unsupported("plugin", "Manage plugins", "reload plugins with /reload-plugins"),
  unsupported("skills", "List available skills", "skills appear in the / menu"),
  unsupported("login", "Sign in with your Anthropic account"),
  unsupported("logout", "Sign out from your Anthropic account"),
  unsupported("help", "Show help and available commands", "commands appear in the / menu"),
  unsupported("theme", "Change the theme"),
  unsupported("diff", "View uncommitted changes"),
  unsupported("export", "Export the current conversation"),
  unsupported("copy", "Copy the last response to the clipboard", "use the Copy button on a message"),
  unsupported("btw", "Ask a quick side question"),
  unsupported("add-dir", "Add a new working directory"),
  unsupported("ide", "Manage IDE integrations"),
  unsupported("vim", "Toggle Vim mode"),
  unsupported("terminal-setup", "Set up terminal keybindings"),
  unsupported("privacy-settings", "View and update privacy settings"),
  unsupported("sandbox", "Configure the sandbox"),
  unsupported("statusline", "Set up the status line"),
  unsupported("release-notes", "View release notes"),
  unsupported("focus", "Toggle focus view"),
  unsupported("usage-credits", "Configure usage credits"),
  unsupported("extra-usage", "Renamed to /usage-credits"),
];

const BYPASS = "turns run by maru always bypass permissions";
const NEW_SESSION = "use New session in the sidebar";
const TASKS_TAB = "use the Activity tab in the right panel";
const CLOSE = "use Close in the conversation header";

/**
 * codex-cli 0.169.0 TUI commands, in the TUI's order: the SlashCommand enum of
 * codex-rs/tui/src/slash_command.rs at tag rust-v0.169.0, whose descriptions appear in that
 * order in the installed binary (checked 2026-11-16). The daemon reads no slash command, so as
 * text each would reach the model: all are refused, and `/model` opens maru's picker. The ones
 * drive/codexCommands.ts runs (compact, review, goal, fork, rename) are not here. Left out on
 * purpose: rollout and test-approval (debug builds only), debug-m-drop and debug-m-update ("DO
 * NOT USE"). The TUI refuses any other `/name` as "Unrecognized command" and keeps the draft
 * (bottom_pane/chat_composer.rs); drive/codexRuns.ts does the same.
 */
export const CODEX_HANDLED: readonly HandledCommand[] = [
  picker("model", "choose what model and reasoning effort to use", "[model] [effort]", "model"),
  // maru's own: the TUI changes the effort inside /model only.
  picker("effort", "Change the reasoning effort only", "[level]", "effort"),
  // A service-tier command: the TUI adds one per tier of the current model (model/list serviceTiers, name lowercased).
  unsupported("fast", "toggle the fast service tier", "the Codex service tier is not chosen in maru"),
  unsupported("presets", "run or save reusable prompts and slash commands"),
  unsupported("daybreak", "turn Daybreak on or off"),
  unsupported("ide", "include current selection, open files, and other context from your IDE"),
  unsupported("permissions", "choose what Codex is allowed to do", BYPASS),
  unsupported("keymap", "remap TUI shortcuts"),
  unsupported("vim", "toggle Vim mode for the composer"),
  unsupported("setup-default-sandbox", "set up elevated agent sandbox"),
  unsupported("experimental", "toggle experimental features"),
  unsupported("approve", "approve one retry of a recent auto-review denial", BYPASS),
  unsupported("memories", "configure memory use and generation"),
  unsupported("skills", "use skills to improve how Codex performs specific tasks", "pick skills from the $ menu"),
  unsupported("import", "import setup, this project, and recent chats from Claude Code"),
  unsupported("hooks", "view and manage lifecycle hooks"),
  unsupported("new", "start a new chat during a conversation", NEW_SESSION),
  unsupported("archive", "archive this session"),
  unsupported("delete", "permanently delete this session", "use Delete in the session menu"),
  unsupported("resume", "resume a saved chat", "open sessions from the sidebar"),
  unsupported("worktree", "start or continue a conversation in a new worktree"),
  unsupported("app", "continue this session in the Desktop app", "open the app on the Mac running Codex"),
  unsupported("init", "create an AGENTS.md file with instructions for Codex"),
  unsupported("config", "configure Codex preferences"),
  unsupported("recap", "summarize the current conversation now"),
  unsupported("plan", "switch to Plan mode"),
  unsupported("voice", "start or stop voice; use /voice settings to choose a voice"),
  unsupported("agents", "open the agent command center", TASKS_TAB),
  unsupported("side", "start a side conversation"),
  unsupported("btw", "start a side conversation"),
  unsupported("copy", "copy the last response or part of it", "use the Copy button on a message"),
  unsupported("export", "export the conversation as markdown"),
  unsupported("raw", "toggle raw scrollback mode for copy-friendly terminal selection"),
  unsupported("tui", "choose the TUI mode for the next launch"),
  unsupported("diff", "show git diff (including untracked files)"),
  unsupported("mention", "mention a file"),
  unsupported("status", "show current session configuration and token usage"),
  unsupported("daemon", "Manage the local background server"),
  unsupported("warnings", "view retained warnings and diagnostic details"),
  unsupported("cd", "change the current working directory"),
  unsupported("pwd", "show the current working directory", undefined, { aliases: ["cwd"] }),
  unsupported("usage", "view account usage or use a usage limit reset"),
  unsupported("debug-config", "show config layers and requirement sources for debugging"),
  unsupported("title", "configure which items appear in the terminal title"),
  unsupported("statusline", "configure which items appear in the status line"),
  unsupported("theme", "choose a syntax highlighting theme"),
  unsupported("pets", "choose or hide the terminal pet", undefined, { aliases: ["pet"] }),
  unsupported("mcp", "list MCP tools; use /mcp verbose or /mcp login <name>"),
  unsupported("apps", "manage apps"),
  unsupported("plugins", "browse plugins"),
  unsupported("logout", "log out of Codex"),
  unsupported("quit", "exit Codex", CLOSE),
  unsupported("exit", "exit Codex", CLOSE),
  unsupported("feedback", "send logs to maintainers or save a ZIP"),
  unsupported("ps", "list background terminals"),
  unsupported("stop", "stop all background terminals", undefined, { aliases: ["clean"] }),
  unsupported("clear", "clear the terminal and start a new chat", NEW_SESSION),
  unsupported("subagents", "switch between this session's subagents", TASKS_TAB),
];

/** A session's own `/` list, as far as commandHandling reads it. */
export type ListedCommands = ReadonlyArray<{ name: string; aliases?: readonly string[]; source?: "builtin" | "custom"; handling?: CommandHandling }>;

function handledOf(provider: ProviderId, name: string): HandledCommand | null {
  return (provider === "claude" ? CLAUDE_HANDLED : CODEX_HANDLED).find((c) => c.name === name || c.aliases?.includes(name)) ?? null;
}

/**
 * How maru handles `/name` for the provider, or null when it goes on as text (to the CLI, or to
 * the daemon's own commands). `listed` is the session's own `/` list; null or absent while it is
 * not known.
 * - Codex: every command here is handled; the daemon has no slash commands of its own.
 * - Claude: a command maru does not support (or runs in the CLI's place) is handled only when the
 *   list is known and holds no custom command or skill of that name, which would run instead (the
 *   SDK's list never holds the CLI screens). While the list is unknown it goes to the CLI, which
 *   runs the user's own command or says the screen is not available.
 */
export function commandHandling(provider: ProviderId, name: string, listed?: ListedCommands | null): CommandHandling | null {
  const own = handledOf(provider, name);
  if (!own) return null;
  if (own.handling.kind === "picker" || provider === "codex") return own.handling;
  if (!listed) return null;
  if (listed.some((c) => c.source === "custom" && !c.handling && (c.name === name || c.aliases?.includes(name)))) return null;
  return own.handling;
}

/**
 * The row of the session's `/` list that `/name` runs, or null when the list is unknown or holds
 * no such name. The rule is the SDK's (`SlashCommand.builtin`, which the list carries as `source`):
 * of the rows named `name`, a built-in one runs, and an unmarked one only when no built-in row
 * shares its name; a name no row has runs the row that lists it as an alias.
 */
export function commandRunning<T extends ListedCommands[number]>(name: string, listed: readonly T[] | null | undefined): T | null {
  if (!listed) return null;
  const pick = (rows: readonly T[]) => rows.find((c) => c.source === "builtin") ?? rows[0] ?? null;
  const named = listed.filter((c) => c.name === name);
  return named.length > 0 ? pick(named) : pick(listed.filter((c) => c.aliases?.includes(name)));
}

/**
 * Claude Code 2.1.325's own commands that run inside the CLI (`type: "local"` and `"local-jsx"`
 * in its bundle, read 2026-11-16) instead of becoming a prompt to the model. A picture sent with
 * one is dropped and the attachment notes become its argument (measured: `/compact`, `/context`).
 * The CLI's other built-in rows are prompts and read pictures as a user's skill does: the skills
 * it ships (`dataviz`, `design`, `code-review` ...) and `init`, `insights`, `team-onboarding`
 * (measured: `/dataviz` with a picture answered from the picture, `/context` printed its table).
 * The SDK list marks both kinds built in and gives no type, hence this list. A command a later CLI
 * adds is not here and goes as the user's own would.
 */
export const CLAUDE_CLI_COMMANDS: ReadonlySet<string> = new Set([
  "__remote-workflow", "add-dir", "advisor", "agents", "artifacts", "auto-mode-setup", "autocompact",
  "autofix-pr", "background", "branch", "brief", "btw", "cd", "clear", "cloud-plugins", "color", "compact",
  "config", "context", "copy", "daemon", "design-consent", "design-login", "design-revoke", "desktop",
  "diff", "effort", "exit", "export", "extra-usage", "fast", "feedback", "focus", "fork", "goal", "heapdump",
  "help", "hooks", "ide", "import", "install", "install-github-app", "install-slack-app", "keybindings",
  "list-agents", "login", "logout", "loops", "mcp", "memory", "mobile", "model", "output-style", "passes",
  "pause-memory", "permissions", "plan", "plugin", "powerup", "privacy-settings", "pro-trial-expired",
  "project", "radio", "rate-limit-options", "recap", "reload-plugins", "reload-skills", "remote-control",
  "remote-env", "rename", "restart", "resume", "scroll-speed", "session", "setup-bedrock", "setup-vertex",
  "skill-doctor", "skills", "status", "stickers", "stop", "subtask", "tasks", "teleport", "terminal-setup",
  "theme", "tui", "ultraplan", "ultrareview", "upgrade", "usage", "usage-credits", "use-case", "version",
  "voice", "web-setup", "wellbeing", "workflow-launch-exec", "workflows",
]);

/**
 * Whether `/name` runs one of Claude Code's own CLI commands (CLAUDE_CLI_COMMANDS) by the session's
 * list: true or false, null while the list is unknown or holds no such name (it may be the user's,
 * so a caller treats null as not a CLI command). A user, project or plugin command or skill of the
 * name, and the CLI's own skills and prompt commands, are false.
 */
export function runsCliCommand(name: string, listed: ListedCommands | null | undefined): boolean | null {
  const row = commandRunning(name, listed);
  if (!row) return null;
  return row.source === "builtin" && CLAUDE_CLI_COMMANDS.has(row.name);
}

/** Whether commandHandling for `/name` reads the session's list, so a caller fetches the list only then. */
export function handlingNeedsList(provider: ProviderId, name: string): boolean {
  const kind = handledOf(provider, name)?.handling.kind;
  return provider === "claude" && (kind === "unsupported" || kind === "server");
}

/**
 * `/name rest` of a message, or null when it is not one command word at the very start. A
 * message that starts with a space is text, as in the Codex TUI and the `/` menu (slashQuery).
 */
export function splitCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trimEnd());
  return m ? { name: m[1]!, args: (m[2] ?? "").trim() } : null;
}

// ---- the pickers' data ----

/** One row of the model picker. */
export interface ModelOption {
  /** What the picker sends (`thread.configure` model): an alias ("opus", "default") or a model id. */
  value: string;
  /** The model id the value runs, when the provider said ("default" -> "claude-opus-5-5"). */
  resolved: string | null;
  label: string;
  description: string;
  /** Effort levels the model takes, lowest first; empty when it takes none. */
  efforts: string[];
  /** What each level means, by level (Codex model/list supportedReasoningEfforts[].description); absent when the provider gave none. */
  effortNotes?: Record<string, string>;
  /** The model's own effort when none is chosen (Codex defaultReasoningEffort); null when unknown. */
  defaultEffort: string | null;
  /** The provider's default model row. */
  isDefault: boolean;
  /** Fast mode can run this model (Claude supportsFastMode). */
  fast?: boolean;
  /** The 1M-context row of a model (value `claude-opus-4-6[1m]`), added by maru (oneMillion.ts). */
  oneMillion?: true;
}

/**
 * GET /api/session-models?key=<session key> -> SessionModelsResponse
 * 400 not a top-level session key, 404 no such session, 409 the list cannot be read (missing
 * folder), 502 the provider failed to answer.
 */
export interface SessionModelsResponse {
  key: string;
  options: ModelOption[];
  /** run: the session's process; probe/cache: a listing CLI (Claude); daemon: model/list (Codex). */
  from: "run" | "probe" | "cache" | "daemon";
  /** Output styles the session can switch to (Claude), the first being the CLI's "default". */
  outputStyles?: string[];
}

/** One MCP server of a running Claude session (Query.mcpServerStatus). */
export interface McpServerView {
  name: string;
  /** connected, failed, needs-auth, pending, disabled (the SDK's McpServerStatus status). */
  status: string;
  /** The server's scope or source, as the CLI reports it (user, project, claudeai, plugin ...). */
  scope: string | null;
  error: string | null;
  tools: number;
}

/**
 * GET /api/session-mcp?key=<session key> -> SessionMcpResponse
 * 409 when this server runs no process for the session (MCP servers live in the process).
 */
export interface SessionMcpResponse {
  key: string;
  servers: McpServerView[];
}

/**
 * UI -> server over /ws: change what the session's next turns run with. Each field present is
 * applied, in this order; the answer is `command.result` (a notice) or `command.error`, and the
 * thread's `state.chosen` changes for every subscriber.
 * Claude: a running process gets it at once (setModel, applyFlagSettings, setPermissionMode,
 * toggleMcpServer, reconnectMcpServer); a closed session keeps model, effort and fast for its
 * next start. Codex: model and effort go with this server's next turn/start.
 */
export interface ThreadConfigure {
  type: "thread.configure";
  threadId: string;
  reqId?: string;
  /** A model option's value; "default" goes back to the account's default. */
  model?: string;
  /** An effort level; null goes back to the model's own (the CLI's "auto"). */
  effort?: string | null;
  permissionMode?: SettablePermissionMode;
  fast?: boolean;
  /** An output style name; null goes back to the CLI's "default". */
  outputStyle?: string | null;
  mcp?: { server: string; action: "enable" | "disable" | "reconnect" };
}

/**
 * The thread's `state.chosen`: what this server set for the session's next turns, or what its
 * process reported. A field is absent when nothing is known beyond the transcript (`state.model`,
 * `state.effort`). The object is replaced whole on a patch.
 */
export interface SessionChosen {
  /** A model option's value or a model id (the process's system/init reports the id). */
  model?: string;
  /** null: the model's own effort ("auto"). */
  effort?: string | null;
  fast?: boolean;
  outputStyle?: string;
  /** Fast mode is on and runs at standard speed for a while after a rate limit (fast_mode_state "cooldown"). */
  fastCooldown?: boolean;
  /** Only while pending: the mode a closed session starts in (a running one has state.permissionMode). */
  permissionMode?: string;
  /** The process has not started yet: these apply when it does (a closed Claude session, a Codex override waiting for its turn). */
  pending?: boolean;
}

const DATE_SUFFIX = /-\d{8}$/;

/**
 * The option that stands for `model` (an option value, or a model id as a transcript or system/init
 * writes it), or null. A value match wins; then the id, also without its date suffix
 * ("claude-haiku-4-5-20251001" is "claude-haiku-4-5"), preferring a non-default row.
 * A `[1m]` model is the 1M-context run of a model: it matches only the "(1M)" rows (oneMillion.ts),
 * and a model without `[1m]` only the other rows, so the two rows of a model never both stand for one name.
 */
export function optionFor(options: readonly ModelOption[], model: string | null | undefined): ModelOption | null {
  if (!model) return null;
  const exact = options.find((o) => o.value === model);
  if (exact) return exact;
  const wide = isOneMillionModel(model);
  const id = withoutOneMillion(model).replace(DATE_SUFFIX, "");
  const same = (o: ModelOption) => !!o.oneMillion === wide && [o.value, o.resolved].some((v) => v !== null && withoutOneMillion(v).replace(DATE_SUFFIX, "") === id);
  return options.find((o) => !o.isDefault && same(o)) ?? options.find(same) ?? null;
}
