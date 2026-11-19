// Messages a person sent that the model has not taken in yet (DESIGN.md 4.4). The server keeps
// the list per session and sends it whole on every change (`session.queued`), so every tab and
// device shows the same rows; a reload gets them right after hello.
import type { OrchestrationV2ProjectedTurnItem } from "./turnItems.ts";

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * The ids the thread's rows were sent with: `x.data.clientId`, and for a Claude line the CLI made
 * out of several queued sends, the ids it folded in (`x.data.mergedClientIds`). The web and the app
 * hide a waiting message whose id is here; the server settles a waiting message whose id is here.
 */
export function deliveredIds(items: readonly OrchestrationV2ProjectedTurnItem[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const row of items) {
    if (row.item.type !== "user_message") continue;
    const data = row.x?.data;
    if (typeof data?.clientId === "string") out.add(data.clientId);
    const merged = data?.mergedClientIds;
    if (Array.isArray(merged)) for (const id of merged) if (typeof id === "string") out.add(id);
  }
  return out.size ? out : NO_IDS;
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * The send ids a Claude `user` transcript line carries: the CLI writes a sent prompt under the uuid
 * it was sent with (`id`), and a line it made out of several queued sends names the others in
 * `mergedSendUuids` (`merged`). The one definition of "this line delivered these sends": the
 * projection (`x.data.clientId`, `x.data.mergedClientIds`) and the server's transcript scan
 * (`deliveredIdsOfLine`) both read it.
 */
export function userLineSendIds(line: Readonly<Record<string, unknown>>): { id: string | null; merged: string[] } {
  const merged = Array.isArray(line.mergedSendUuids) ? line.mergedSendUuids.map(nonEmpty).filter((m): m is string => m !== null) : [];
  return { id: nonEmpty(line.uuid), merged };
}

/** The send id of a `queued_command` attachment (a message folded into a running turn names the uuid it was sent with), or null. */
export function queuedCommandSendId(attachment: Readonly<Record<string, unknown>>): string | null {
  return nonEmpty(attachment.source_uuid);
}

/** Every send id a raw Claude transcript line says was delivered: a prompt line (and the sends it merged) or a folded-in `queued_command`. */
export function deliveredIdsOfLine(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const o = value as Record<string, unknown>;
  if (o.type === "user") {
    const { id, merged } = userLineSendIds(o);
    return id === null ? merged : [id, ...merged];
  }
  if (o.type === "attachment" && o.attachment && typeof o.attachment === "object") {
    const a = o.attachment as Record<string, unknown>;
    if (a.type !== "queued_command") return [];
    const id = queuedCommandSendId(a);
    return id === null ? [] : [id];
  }
  return [];
}

/**
 * sending  the server got it and hands it to the provider (a closed Claude session is resumed first)
 * queued   the provider holds it: the Claude CLI's command queue, where it waits for the end of
 *          the running tool call or of the turn, or a Codex steer the daemon took
 * taken    the model has it; the row stays until the conversation shows the message
 * failed   it did not reach the model (the send failed, or the process ended first)
 */
export type PendingSendState = "sending" | "queued" | "taken" | "failed";

export interface PendingSend {
  /**
   * The client message id: the uuid of the Claude user message, the clientUserMessageId of the
   * Codex turn input. A conversation row of that message carries it as `x.data.clientId`.
   */
  id: string;
  text: string;
  /** The uploads it carries (attachments.ts); they go back to the composer with the text. */
  attachments: import("./attachments.ts").UploadedAttachment[];
  /** When the server got it, ms since epoch. */
  sentAt: number;
  state: PendingSendState;
  /** Why it failed (state failed). */
  error: string | null;
  /** Taking it back into the composer (`thread.recall`): whether it can be done now, and why not. */
  recall: { enabled: boolean; reason: string | null };
}

/** Server -> UI: the session's whole list (empty when none waits). */
export interface PendingSendsMessage {
  type: "session.queued";
  key: string;
  sends: PendingSend[];
}

/**
 * Server -> the UI that sent `thread.recall`: the messages taken back, in the order they were sent.
 * The UI puts their texts in front of its draft, as the Claude Code CLI does when ↑ pulls queued
 * messages back, and their attachments in front of its waiting attachments. A message that could
 * not be taken back answers `command.error` as well.
 */
export interface RecalledMessage {
  type: "thread.recalled";
  reqId?: string;
  threadId: string;
  messages: Array<{ id: string; text: string; attachments: import("./attachments.ts").UploadedAttachment[] }>;
}

/** UI -> server: take these queued messages back before the model reads them. */
export interface ThreadRecall {
  type: "thread.recall";
  threadId: string;
  ids: string[];
  reqId?: string;
}
