// The rewind screen's rules (DESIGN.md 6o), shared by the chat dialog (components/chat/RewindDialog.tsx)
// and the terminal screen (components/terminal/TerminalRewind.tsx). The wording and order follow the
// Claude Code CLI 2.1.325 (MessageSelector in the bundle, screens captured in tmux): the CLI's
// English for the terminal and the chat dialog.
import type { OrchestrationV2TurnItem, RewindMode, RewindPart, RewindTarget, SessionRewindPreview } from "@maru/shared";

/**
 * The rewind target a user message names: the transcript uuid of a Claude message, the turn id of
 * a Codex one (thread keys start with the provider). Null for an item that is not a user message
 * or has none yet (a queued entry not written). Shared by the chat timeline and the Android app.
 */
export function rewindTargetOf(threadKey: string, item: OrchestrationV2TurnItem | undefined): string | null {
  if (!item || item.type !== "user_message") return null;
  if (threadKey.startsWith("codex:")) return item.providerTurnId;
  return item.nativeItemRef?.nativeId ?? null;
}

/**
 * Two Esc presses within this many ms are a double press: the CLI's double-press window (its Ute
 * helper's default, 800). It opens the rewind screen on an empty input and clears a typed one.
 */
export const DOUBLE_ESC_MS = 800;

/** How long "Esc again to clear" shows (the CLI's notice timeoutMs). */
export const CLEAR_HINT_MS = 1000;

export function isDoublePress(last: number, now: number, ms: number = DOUBLE_ESC_MS): boolean {
  return last > 0 && now - last <= ms;
}

export type RewindChoice = RewindMode | "nevermind";

export interface RewindOption {
  value: RewindChoice;
  /** The CLI's label (terminal) */
  cli: string;
  /** The chat dialog's label */
  label: string;
  enabled: boolean;
  /** Why it is off (a short label); null when enabled. */
  reason: string | null;
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function part(a: RewindPart, b?: RewindPart): RewindPart {
  if (!a.enabled) return a;
  if (b && !b.enabled) return b;
  return a;
}

/**
 * The options for a picked message, in the CLI's order. The CLI lists only what can be done (code
 * options only when the code would change); maru keeps every option and turns off the ones that
 * cannot, with the reason, so the user learns why (a message sent with checkpoints off, Codex).
 */
export function rewindOptions(t: RewindTarget, blocked: string | null = null, preview: SessionRewindPreview | null = null): RewindOption[] {
  const gate = (p: RewindPart): RewindPart => (blocked ? { enabled: false, reason: blocked } : p);
  // The dry run knows better than the transcript: it refused, or nothing would change.
  const codeKnown: RewindPart = !t.code.enabled ? t.code
    : preview?.error ? { enabled: false, reason: preview.error }
    : preview?.restore && preview.restore.files.length === 0 ? { enabled: false, reason: "No code changes to rewind" }
    : t.code;
  const both = gate(part(codeKnown, t.conversation));
  const conversation = gate(t.conversation);
  const code = gate(codeKnown);
  return [
    { value: "both", cli: "Restore code and conversation", label: "Rewind code and conversation", enabled: both.enabled, reason: both.reason },
    { value: "conversation", cli: "Restore conversation", label: "Rewind conversation only", enabled: conversation.enabled, reason: conversation.reason },
    { value: "code", cli: "Restore code", label: "Rewind code only", enabled: code.enabled, reason: code.reason },
    { value: "nevermind", cli: "Never mind", label: "Cancel", enabled: true, reason: null },
  ];
}

/** The option the CLI focuses first: code and conversation when the code can go back, else the conversation. */
export function defaultOption(options: readonly RewindOption[]): number {
  const first = options.findIndex((o) => o.enabled && o.value !== "nevermind");
  return first < 0 ? options.length - 1 : first;
}

/** The row line under a message (the CLI's hqe): the edits its turn made. Null: no line (Codex). */
export function rowMeta(t: RewindTarget): { text: string; kind: "changes" | "none" | "no-restore" } | null {
  if (t.turnChanges === null) return null;
  if (!t.checkpoint) return { text: "No code restore", kind: "no-restore" };
  const n = t.turnChanges.files.length;
  if (n === 0) return { text: "No code changes", kind: "none" };
  return { text: n === 1 ? basename(t.turnChanges.files[0]!) : `${n} files changed`, kind: "changes" };
}

/** The files the CLI names in "The code will be restored ... in <files>.". */
export function restoreFilesText(files: readonly string[]): string {
  if (files.length === 0) return "";
  if (files.length === 1) return basename(files[0]!);
  if (files.length === 2) return `${basename(files[0]!)} and ${basename(files[1]!)}`;
  return `${basename(files[0]!)} and ${files.length - 1} other files`;
}

/**
 * What the focused option does, for the two lines under the quoted message (the CLI's Xje and
 * kle): whether the conversation goes back, and whether the code is restored or stays. `code` is
 * null where code never goes back (Codex: no line, as the CLI without checkpointing).
 */
export function choiceEffect(t: RewindTarget, choice: RewindChoice, options: readonly RewindOption[]): { goesBack: boolean; code: "restore" | "unchanged" | null } {
  const goesBack = choice === "both" || choice === "conversation";
  if (t.restore === null) return { goesBack, code: null };
  const restores = (choice === "both" || choice === "code") && options.some((o) => o.value === "code" && o.enabled);
  return { goesBack, code: restores ? "restore" : "unchanged" };
}

/**
 * The files and counts the code line names: the dry run's when the preview has one (the CLI's
 * numbers), else the files edited after the message without counts (`exact` false).
 */
export function restoreShown(t: RewindTarget, preview: SessionRewindPreview | null): { files: string[]; insertions: number; deletions: number; exact: boolean } | null {
  if (preview?.restore) return { ...preview.restore, exact: true };
  if (t.restore) return { files: t.restore.files, insertions: 0, deletions: 0, exact: false };
  return null;
}

/** The warning the CLI shows while the code can go back (yui). */
export const RESTORE_WARNING = "Restored files go back whole, losing later changes by anyone. Bash changes to other files are not undone.";

/**
 * The composer's text after a conversation rewind: the message, as the CLI puts it back into its
 * prompt. Text already typed stays after it (the CLI opens the screen only on an empty prompt;
 * the chat's Rewind button can be pressed with a draft, which must not be lost).
 */
export function draftAfterRewind(current: string, prefill: string): string {
  if (!current.trim()) return prefill;
  // A second rewind to the same message: it is already at the head of the draft.
  if (current === prefill || current.startsWith(`${prefill}\n\n`)) return current;
  return `${prefill}\n\n${current}`;
}

/** "6m ago" as the CLI's MS writes it. */
export function ageText(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  const [n, unit] = s < 60 ? [s, "s"] : s < 3600 ? [Math.floor(s / 60), "m"] : s < 86400 ? [Math.floor(s / 3600), "h"] : [Math.floor(s / 86400), "d"];
  return `${n}${unit} ago`;
}

/** A message on one row: its lines joined with spaces (the row cuts what does not fit). */
export function oneLine(text: string): string {
  const s = text.replace(/\s*\n\s*/g, " ").trim();
  return s === "" ? "(empty message)" : s;
}
