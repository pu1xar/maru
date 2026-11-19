// Codex slash commands this server runs through the daemon's own methods. Only the Codex TUI
// reads slash commands: a thread.send of "/compact" would reach the model as text. The names,
// descriptions and argument shapes follow the codex-cli 0.169.0 TUI (strings read from its binary
// 2026-11-16: "Usage: /goal [<objective>|clear|edit|pause|resume]", the /review presets).
import type { SessionCommand } from "@maru/shared";
import { GOAL_STATUS_LABEL } from "@maru/shared";
import type { ThreadGoal } from "../codex/protocol/v2/ThreadGoal.ts";
import { DriveError } from "./claudeRuns.ts";

export type CodexCommand =
  | { name: "compact" }
  /** instructions null: the TUI's "review my current changes" (uncommitted changes). */
  | { name: "review"; instructions: string | null }
  | { name: "goal"; action: "get" | "clear" | "pause" | "resume" }
  | { name: "goal"; action: "set"; objective: string }
  | { name: "fork" }
  | { name: "rename"; title: string }
  /**
   * The TUI's /model: model and effort for this server's next turn/start. model null lists the
   * models; effort undefined keeps the one chosen before (or the model's own).
   */
  | { name: "model"; model: string | null; effort?: string }
  /** maru's own /effort (the TUI changes it inside /model): level null shows it, "default" is the model's own. */
  | { name: "effort"; level: string | null };

/** The `/` menu of a Codex session: these commands, then the folder's skills ($name). */
export const CODEX_COMMANDS: SessionCommand[] = [
  { name: "compact", sigil: "/", description: "summarize conversation to prevent hitting the context limit", argumentHint: "", aliases: [], source: "builtin" },
  { name: "review", sigil: "/", description: "review my current changes and find issues; with instructions, a custom review", argumentHint: "[instructions]", aliases: [], source: "builtin" },
  { name: "goal", sigil: "/", description: "set or view the goal for a long-running task", argumentHint: "[<objective>|clear|pause|resume]", aliases: [], source: "builtin" },
  { name: "fork", sigil: "/", description: "fork the current chat", argumentHint: "", aliases: [], source: "builtin" },
  { name: "rename", sigil: "/", description: "rename the current thread", argumentHint: "<name>", aliases: [], source: "builtin" },
];

/**
 * The command a message is, or null when it is not one of these. Only a first word equal to one
 * of the commands counts ("/compactx" is not /compact; codexRuns.ts refuses it as the TUI does,
 * and "/Users/me/a.txt" and "say /compact" are text). The TUI also takes "/gooal" and any count of
 * o's for /goal (find_builtin_command). Throws DriveError for a command used in a way it does not take.
 */
export function parseCodexCommand(text: string): CodexCommand | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const args = (m[2] ?? "").trim();
  const name = /^go+al$/.test(m[1]!) ? "goal" : m[1];
  switch (name) {
    case "compact":
    case "fork":
      if (args) throw new DriveError(`/${name} takes no arguments`);
      return { name };
    case "review":
      return { name: "review", instructions: args || null };
    case "goal": {
      if (!args) return { name: "goal", action: "get" };
      const word = args.toLowerCase();
      if (word === "clear" || word === "pause" || word === "resume") return { name: "goal", action: word };
      // The TUI opens an editor for this; here the new objective is typed after /goal.
      if (word === "edit") throw new DriveError("To change the goal, send the new goal after /goal");
      return { name: "goal", action: "set", objective: args };
    }
    case "rename":
      if (!args) throw new DriveError("Give a new name: /rename <name>");
      return { name: "rename", title: args };
    case "model": {
      if (!args) return { name: "model", model: null };
      const words = args.split(/\s+/);
      if (words.length > 2) throw new DriveError("/model <model> [effort]");
      return { name: "model", model: words[0]!, ...(words[1] ? { effort: words[1].toLowerCase() } : {}) };
    }
    case "effort":
      if (/\s/.test(args)) throw new DriveError("/effort <effort>");
      return { name: "effort", level: args ? args.toLowerCase() : null };
    default:
      return null;
  }
}

/** The notice for a goal as thread/goal/get or thread/goal/set answered it. */
export function goalNotice(goal: ThreadGoal | null): string {
  if (!goal) return "No goal is set. Set one with /goal <goal>";
  const tokens = goal.tokenBudget === null
    ? `tokens ${goal.tokensUsed.toLocaleString("en-US")}`
    : `tokens ${goal.tokensUsed.toLocaleString("en-US")} / ${goal.tokenBudget.toLocaleString("en-US")}`;
  const next = goal.status === "active" ? "/goal pause, /goal clear" : goal.status === "complete" ? "/goal clear" : "/goal resume, /goal clear";
  return [
    `Goal: ${goal.objective}`,
    `Status: ${GOAL_STATUS_LABEL[goal.status] ?? goal.status}, ${tokens}, time ${duration(goal.timeUsedSeconds)}`,
    `Command: ${next}`,
  ].join("\n");
}

function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [h ? `${h}h` : "", m ? `${m}m` : "", `${s % 60}s`].filter(Boolean);
  return parts.join(" ");
}
