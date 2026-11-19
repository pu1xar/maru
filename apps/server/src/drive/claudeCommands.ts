// Claude Code commands this server runs itself instead of sending them to the CLI as text
// (DESIGN.md 6m). The CLI's screens for them (local-jsx) do not exist in an SDK session: there
// `/model` alone prints the current model, `/permissions` answers "isn't available in this
// environment" (2.1.325, measured 2026-11-16). The composer opens maru's picker for `/name` alone
// (sessionControls.ts); a message that reaches the server (typed with an argument, or from the
// terminal mode or the app, or one of the server commands /status, /plan, /exit) is read here.
import type { CommandHandling, SettablePermissionMode } from "@maru/shared";
import { SETTABLE_PERMISSION_MODES, commandHandling, splitCommand } from "@maru/shared";
import { DriveError } from "./claudeRuns.ts";

export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type ClaudeCommand =
  /** value null: list the models (the picker's rows as text). */
  | { name: "model"; value: string | null }
  /** value undefined: show the effort; null: back to the model's own ("auto"). */
  | { name: "effort"; value: string | null | undefined }
  | { name: "permissions"; mode: SettablePermissionMode | null }
  | { name: "fast"; on: boolean | null }
  | { name: "mcp"; action: "list" }
  | { name: "mcp"; action: "enable" | "disable" | "reconnect"; server: string }
  /** style undefined: list; null: back to "default". */
  | { name: "output-style"; style: string | null | undefined }
  | { name: "status" }
  /** prompt: the text after /plan, sent in plan mode. */
  | { name: "plan"; prompt: string | null }
  | { name: "exit" }
  | { name: "unsupported"; command: string; reason: string };

/**
 * The command a message is, or null when it goes to the CLI as text. `listed` is the session's
 * `/` list when known: a custom command named like an unsupported CLI screen runs as itself.
 * Throws DriveError for an argument the command does not take.
 */
export function parseClaudeCommand(text: string, listed?: Parameters<typeof commandHandling>[2]): ClaudeCommand | null {
  const cmd = splitCommand(text);
  if (!cmd) return null;
  const handling: CommandHandling | null = commandHandling("claude", cmd.name, listed);
  if (!handling) return null;
  if (handling.kind === "unsupported") return { name: "unsupported", command: cmd.name, reason: handling.reason };
  const args = cmd.args;
  const word = args.toLowerCase();
  if (handling.kind === "server") {
    if (cmd.name === "plan") return { name: "plan", prompt: args || null };
    if (args) throw new DriveError(`/${cmd.name} takes no arguments`);
    return { name: cmd.name === "exit" ? "exit" : "status" };
  }
  switch (handling.picker) {
    case "model":
      if (/\s/.test(args)) throw new DriveError("Give one model name: /model <name>");
      return { name: "model", value: args || null };
    case "effort":
      if (!args) return { name: "effort", value: undefined };
      if (word === "auto") return { name: "effort", value: null };
      if (!(CLAUDE_EFFORTS as readonly string[]).includes(word)) throw new DriveError(`effort must be one of ${[...CLAUDE_EFFORTS, "auto"].join(", ")}`);
      return { name: "effort", value: word };
    case "permissions": {
      if (!args) return { name: "permissions", mode: null };
      const mode = SETTABLE_PERMISSION_MODES.find((m) => m.toLowerCase() === word);
      if (!mode) throw new DriveError(`permission mode must be one of ${SETTABLE_PERMISSION_MODES.join(", ")}`);
      return { name: "permissions", mode };
    }
    case "fast":
      if (!args) return { name: "fast", on: null };
      if (word === "on" || word === "off") return { name: "fast", on: word === "on" };
      throw new DriveError("/fast on or /fast off");
    case "mcp": {
      if (!args) return { name: "mcp", action: "list" };
      const m = /^(enable|disable|reconnect)\s+(\S(?:.*\S)?)$/i.exec(args);
      // "all" and other forms go to the CLI, whose /mcp takes them as text.
      if (!m || m[2]!.toLowerCase() === "all") return null;
      return { name: "mcp", action: m[1]!.toLowerCase() as "enable" | "disable" | "reconnect", server: m[2]! };
    }
    case "output-style":
      if (!args) return { name: "output-style", style: undefined };
      return { name: "output-style", style: word === "default" ? null : args };
  }
}
