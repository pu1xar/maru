// What maru's pickers for /model, /effort, /permissions, /mcp, /output-style and /fast show
// (DESIGN.md 6m): rows, the current one, and what picking a row sends (`thread.configure`). The
// rows follow Claude Code 2.1.325's own screens: the model list with the current one checked and
// an effort line under it that ← and → change, the permission modes, the MCP servers with their
// state and then a server's actions. Pure functions; the hook is sessionPicker.ts.
import type {
  McpServerView, ModelOption, ProviderId, SessionCommand, SessionMcpResponse, SessionModelsResponse, SessionPickerKind, ThreadConfigure,
  ThreadProjectionState,
} from "@maru/shared";
import { SETTABLE_PERMISSION_MODES, commandHandling, optionFor, splitCommand } from "@maru/shared";
import { currentModel } from "./modelLabel.ts";
import { plural } from "./plural.ts";

export type PickerChange = Omit<ThreadConfigure, "type" | "threadId" | "reqId">;

/** What a composer does with a message before sending it (sessionControls.ts). */
export type ComposerIntercept =
  | { kind: "picker"; picker: SessionPickerKind }
  | { kind: "unsupported"; notice: string };

/**
 * `/name` alone that maru opens a picker for, or a command maru does not support (a one-line
 * notice instead of a send); null when the message goes to the server as it is. `listed` is the
 * session's `/` list when loaded (a custom command of the same name runs as itself).
 */
export function interceptMessage(provider: ProviderId, text: string, listed?: readonly SessionCommand[] | null): ComposerIntercept | null {
  const cmd = splitCommand(text);
  if (!cmd) return null;
  const handling = commandHandling(provider, cmd.name, listed);
  // A command the server runs in the CLI's place goes as it is.
  if (!handling || handling.kind === "server") return null;
  if (handling.kind === "unsupported") return { kind: "unsupported", notice: `/${cmd.name}: ${handling.reason}` };
  // With an argument the server runs it (the same as picking it).
  return cmd.args ? null : { kind: "picker", picker: handling.picker };
}

export interface PickerRow {
  id: string;
  label: string;
  description: string;
  /** The session runs with this one now (or will at its next start). */
  current: boolean;
  /** Why it cannot be picked now, or null. */
  disabled: string | null;
  /** What picking it sends; null for a row that opens `next`. */
  change: PickerChange | null;
  /** A second list the row opens (an MCP server's actions). */
  next?: { title: string; rows: PickerRow[] };
  /** The model row's option (the effort line reads it). */
  option?: ModelOption;
}

export interface PickerData {
  models?: SessionModelsResponse;
  mcp?: McpServerView[];
}

export interface PickerView {
  title: string;
  /** The current value, as a label. */
  current: string | null;
  /** The value waits for the session's next start (or Codex's next turn). */
  pending: boolean;
  rows: PickerRow[];
}

/** The data a picker needs from the server before it can show rows. */
export function pickerNeeds(kind: SessionPickerKind): "models" | "mcp" | null {
  if (kind === "model" || kind === "effort" || kind === "fast" || kind === "output-style") return "models";
  if (kind === "mcp") return "mcp";
  return null;
}

/**
 * What the pickers fetched (GET /api/session-models, /api/session-mcp), tied to the session and
 * the request it answers: an answer to an older request, or for another session, is dropped.
 */
export interface PickerLoad {
  /** The latest request's number (each open makes one, also when nothing is fetched). */
  seq: number;
  /** The session the latest request was for; `data` is that session's. */
  key: string | null;
  loading: boolean;
  error: string | null;
  data: PickerData;
}

export type PickerLoadAction =
  | { type: "open"; seq: number; key: string; need: "models" | "mcp" | null }
  | { type: "loaded"; seq: number; need: "models" | "mcp"; body: SessionModelsResponse | SessionMcpResponse }
  | { type: "failed"; seq: number; need: "models" | "mcp"; error: string };

export const INITIAL_PICKER_LOAD: PickerLoad = { seq: 0, key: null, loading: false, error: null, data: {} };

export function pickerLoadReducer(s: PickerLoad, a: PickerLoadAction): PickerLoad {
  switch (a.type) {
    case "open":
      return { seq: a.seq, key: a.key, loading: a.need !== null, error: null, data: s.key === a.key ? s.data : {} };
    case "loaded":
      if (a.seq !== s.seq) return s;
      return {
        ...s,
        loading: false,
        data: a.need === "models" ? { ...s.data, models: a.body as SessionModelsResponse } : { ...s.data, mcp: (a.body as SessionMcpResponse).servers },
      };
    case "failed": {
      if (a.seq !== s.seq) return s;
      // The rows of an earlier answer are not shown under the error, nor picked with Enter.
      const data: PickerData = { ...s.data };
      delete data[a.need];
      return { ...s, loading: false, error: a.error, data };
    }
  }
}

/** The data the picker shows for the session `key`; null while loading, after an error, or when it is another session's. */
export function pickerDataFor(s: PickerLoad, key: string): PickerData | null {
  return s.key === key && !s.loading && s.error === null ? s.data : null;
}

export { currentModel };

/** The effort as the thread knows it: chosen here (null is "auto"), else the latest response's. */
export function currentEffort(state: ThreadProjectionState | null | undefined): string | null {
  const c = state?.chosen;
  if (c && c.effort !== undefined) return c.effort;
  return state?.effort ?? null;
}

/**
 * The levels ← and → step through on the model picker's effort line: "auto" (the model's own,
 * Claude's /effort auto) and the model's levels. Codex has no "auto": its default is a level.
 */
export function effortSteps(provider: ProviderId, option: ModelOption | null | undefined): string[] {
  if (!option || option.efforts.length === 0) return [];
  return provider === "claude" ? ["auto", ...option.efforts] : [...option.efforts];
}

/** Where the effort line starts for a model row: the current effort when the model takes it, else its default, else the first step. */
export function effortStart(provider: ProviderId, option: ModelOption | null | undefined, effort: string | null): number {
  const steps = effortSteps(provider, option);
  if (steps.length === 0) return -1;
  const want = effort ?? (provider === "claude" ? "auto" : option?.defaultEffort ?? null);
  const i = want === null ? -1 : steps.indexOf(want);
  if (i >= 0) return i;
  const d = option?.defaultEffort ? steps.indexOf(option.defaultEffort) : -1;
  return d >= 0 ? d : 0;
}

/** The effort line's words: "effort high (default)", or that the model takes none. */
export function effortLine(provider: ProviderId, option: ModelOption | null | undefined, step: number): string {
  const steps = effortSteps(provider, option);
  if (steps.length === 0) return option ? `${option.label} takes no effort` : "";
  const level = steps[Math.max(0, Math.min(step, steps.length - 1))]!;
  const note = option?.effortNotes?.[level];
  return `effort ${level}${option?.defaultEffort === level ? " (default)" : ""}${note ? `, ${note}` : ""}`;
}

/** The levels Claude Code names; a model that takes fewer shows the rest unavailable. */
const CLAUDE_ALL_LEVELS = ["low", "medium", "high", "xhigh", "max"];

export interface EffortSegment {
  level: string;
  /** The effort strip's current step (the staged one before Enter, the session's before any move). */
  selected: boolean;
  /** Why the model cannot take this level, or null. */
  disabled: string | null;
  isDefault: boolean;
  /** The level's one-line meaning when the provider gives one (Codex `effortNotes`). */
  note: string | null;
}

/**
 * The buttons of the model picker's effort strip, in order: Claude's "auto" and every level
 * Claude Code names (the ones the model does not take stay as unavailable buttons with the reason),
 * Codex's own levels for the model. Empty when the model takes no effort. `step` indexes
 * effortSteps, the supported levels that ← and → walk.
 */
export function effortSegments(provider: ProviderId, option: ModelOption | null | undefined, step: number): EffortSegment[] {
  const steps = effortSteps(provider, option);
  if (!option || steps.length === 0) return [];
  const selected = steps[Math.max(0, Math.min(step, steps.length - 1))]!;
  const names = provider === "claude"
    ? ["auto", ...CLAUDE_ALL_LEVELS, ...option.efforts.filter((e) => !CLAUDE_ALL_LEVELS.includes(e))]
    : steps;
  return names.map((level) => ({
    level,
    selected: level === selected,
    disabled: steps.includes(level) ? null : `${option.label} does not take ${level}`,
    isDefault: option.defaultEffort === level,
    note: option.effortNotes?.[level] ?? (level === "auto" ? "Follows the model's default" : null),
  }));
}

/** The line under the effort strip: the selected level's default mark and meaning, or that the model takes none. */
export function effortDetail(provider: ProviderId, option: ModelOption | null | undefined, step: number): string {
  if (!option) return "";
  const seg = effortSegments(provider, option, step).find((s) => s.selected);
  if (!seg) return `${option.label} takes no effort`;
  return [seg.isDefault ? "default" : "", seg.note ?? ""].filter(Boolean).join(", ");
}

/** The `thread.configure` for picking a model row with the effort line at `step` (touched: the user moved it). */
export function modelChange(provider: ProviderId, option: ModelOption, step: number, touched: boolean): PickerChange {
  const steps = effortSteps(provider, option);
  if (!touched || steps.length === 0) return { model: option.value };
  const level = steps[Math.max(0, Math.min(step, steps.length - 1))]!;
  return { model: option.value, effort: level === "auto" ? null : level };
}

const MODE_TEXT: Record<string, string> = {
  default: "Ask for each edit and command",
  acceptEdits: "Do not ask for file edits",
  plan: "Only plan, do not change anything",
  bypassPermissions: "Run without asking",
};

const MCP_STATUS: Record<string, string> = {
  connected: "Connected",
  failed: "Failed",
  "needs-auth": "Needs authentication",
  pending: "Connecting",
  disabled: "Off",
};

const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

export function pickerView(kind: SessionPickerKind, provider: ProviderId, state: ThreadProjectionState | null | undefined, data: PickerData): PickerView {
  const chosen = state?.chosen ?? null;
  const pending = chosen?.pending === true;
  const options = data.models?.options ?? [];
  switch (kind) {
    case "model": {
      const model = currentModel(state);
      const now = optionFor(options, model);
      return {
        title: "Model",
        current: now?.label ?? model,
        pending: pending && chosen?.model !== undefined,
        rows: options.map((o) => ({
          id: o.value, label: o.label, description: o.description, current: o === now, disabled: null, change: { model: o.value }, option: o,
        })),
      };
    }
    case "effort": {
      const effort = currentEffort(state);
      const now = optionFor(options, currentModel(state));
      if (provider === "codex") {
        // Codex has no "auto": the model's default is one of its levels.
        const cur = effort ?? now?.defaultEffort ?? null;
        return {
          title: "effort",
          current: cur,
          pending: pending && chosen?.effort !== undefined,
          rows: (now?.efforts ?? []).map((level) => ({
            id: level, label: level, description: now?.defaultEffort === level ? "Default" : "", current: cur === level, disabled: null, change: { effort: level },
          })),
        };
      }
      const levels = now && now.efforts.length ? now.efforts : CLAUDE_EFFORT_LEVELS;
      const rows: PickerRow[] = ["auto", ...levels].map((level) => ({
        id: level,
        label: level,
        description: level === "auto" ? "The model's default" : now?.defaultEffort === level ? "Default" : "",
        current: (effort ?? "auto") === level,
        disabled: now && now.efforts.length === 0 && level !== "auto" ? `${now.label} takes no effort` : null,
        change: { effort: level === "auto" ? null : level },
      }));
      return { title: "effort", current: effort ?? "auto", pending: pending && chosen?.effort !== undefined, rows };
    }
    case "permissions": {
      const mode = (pending ? chosen?.permissionMode : undefined) ?? state?.permissionMode ?? null;
      return {
        title: "permission mode",
        current: mode,
        pending: pending && chosen?.permissionMode !== undefined,
        rows: SETTABLE_PERMISSION_MODES.map((m) => ({
          id: m, label: m, description: MODE_TEXT[m] ?? "", current: mode === m, disabled: null, change: { permissionMode: m },
        })),
      };
    }
    case "output-style": {
      const style = chosen?.outputStyle ?? state?.outputStyle ?? "default";
      const styles = data.models?.outputStyles?.length ? data.models.outputStyles : ["default"];
      return {
        title: "output style",
        current: style,
        pending: pending && chosen?.outputStyle !== undefined,
        rows: styles.map((s) => ({
          id: s, label: s, description: "", current: s === style, disabled: null, change: { outputStyle: s === "default" ? null : s },
        })),
      };
    }
    case "fast": {
      const on = chosen?.fast === true;
      const now = optionFor(options, currentModel(state));
      const why = now && !now.fast ? `${now.label} does not take fast mode` : null;
      return {
        title: "fast mode",
        current: on ? (chosen?.fastCooldown ? "on, standard speed for a while after a rate limit" : "on") : "off",
        pending: pending && chosen?.fast !== undefined,
        rows: [
          { id: "on", label: "on", description: "", current: on, disabled: why, change: { fast: true } },
          { id: "off", label: "off", description: "", current: !on, disabled: null, change: { fast: false } },
        ],
      };
    }
    case "mcp": {
      const servers = data.mcp ?? [];
      return {
        title: "MCP servers",
        current: null,
        pending: false,
        rows: servers.map((m) => {
          const status = MCP_STATUS[m.status] ?? m.status;
          const off = m.status === "disabled";
          const actions: PickerRow[] = [
            off
              ? { id: "enable", label: "Turn on", description: "", current: false, disabled: null, change: { mcp: { server: m.name, action: "enable" } } }
              : { id: "disable", label: "Turn off", description: "", current: false, disabled: null, change: { mcp: { server: m.name, action: "disable" } } },
            {
              id: "reconnect", label: "Reconnect", description: "", current: false,
              disabled: off ? "Server is off" : null, change: { mcp: { server: m.name, action: "reconnect" } },
            },
          ];
          return {
            id: m.name,
            label: m.name,
            description: [status, m.tools ? plural(m.tools, "tool") : "", m.error ?? ""].filter(Boolean).join(", "),
            current: false,
            disabled: null,
            change: null,
            next: { title: m.name, rows: actions },
          };
        }),
      };
    }
  }
}

/** What a key does while a picker is open (pickerKey). */
export type PickerKeyAction =
  | { type: "close" }
  /** Back from a row's second list (an MCP server's actions) to the first. */
  | { type: "back" }
  | { type: "move"; to: number }
  | { type: "effort"; delta: 1 | -1 }
  | { type: "pick"; index: number };

/**
 * The picker's keys, taken from the composer's input, which keeps the focus: ↑ ↓ move (wrapping),
 * ← → step the model picker's effort, Enter picks, Esc goes back a level or closes. With `digits`
 * (the terminal mode, as the CLI's lists) 1 to 9 pick that row. null: the key is the input's or a
 * shortcut's (a syllable an IME is composing, any key but Esc with Cmd, Ctrl or Alt, Shift with
 * Enter, ← → without an effort line, typing).
 */
export function pickerKey(
  key: string,
  mods: { shift?: boolean; alt?: boolean; meta?: boolean; ctrl?: boolean; composing?: boolean },
  ctx: { rows: number; index: number; nested: boolean; effort: boolean; digits?: boolean },
): PickerKeyAction | null {
  if (mods.composing) return null;
  if ((mods.meta || mods.ctrl || mods.alt) && key !== "Escape") return null;
  switch (key) {
    case "Escape":
      return ctx.nested ? { type: "back" } : { type: "close" };
    case "ArrowDown":
    case "ArrowUp":
      return { type: "move", to: ctx.rows ? (ctx.index + (key === "ArrowDown" ? 1 : -1) + ctx.rows) % ctx.rows : 0 };
    case "ArrowLeft":
    case "ArrowRight":
      return ctx.effort ? { type: "effort", delta: key === "ArrowRight" ? 1 : -1 } : null;
    case "Enter":
      return mods.shift || mods.alt ? null : { type: "pick", index: ctx.index };
    default:
      if (ctx.digits && /^[1-9]$/.test(key) && Number(key) <= ctx.rows) return { type: "pick", index: Number(key) - 1 };
      return null;
  }
}

/** The row the highlight starts on: the current one, else the first that can be picked. */
export function initialRow(rows: readonly PickerRow[]): number {
  const cur = rows.findIndex((r) => r.current && !r.disabled);
  if (cur >= 0) return cur;
  const first = rows.findIndex((r) => !r.disabled);
  return first >= 0 ? first : 0;
}
