// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: packages/client-runtime/src/state/subagentDisplay.ts.
// Local changes: resolveSubagentMetadata is left out (it reads T3's provider model catalog and
// project shells); counts come first ("2 working"), the words match the
// subagent cards (a stopped agent is "stopped"), and the middle-dot separator is a comma.
import type { OrchestrationV2TurnItemStatus } from "@maru/shared";
import { plural } from "../../lib/plural.ts";
import { isTerminalSubagentStatus } from "./subagentRuntime.ts";

/** The group summary's state words, as the subagent cards name each state. */
const SUBAGENT_COUNT_LABELS = {
  working: "working",
  done: "done",
  failed: "failed",
  stopped: "stopped",
  idle: "idle",
} as const;

export function subagentGroupSummary(
  members: ReadonlyArray<{ readonly status: OrchestrationV2TurnItemStatus }>,
) {
  const active = members.some(
    ({ status }) => status === "pending" || status === "running" || status === "waiting",
  );
  return {
    label: `${plural(members.length, "subagent")} ${active ? "started" : "ran"}`,
    active,
    failed: members.some(({ status }) => status === "failed"),
  };
}

export function summarizeSubagentStatuses(
  statuses: ReadonlyArray<OrchestrationV2TurnItemStatus>,
): string {
  const counts = { working: 0, done: 0, failed: 0, stopped: 0, idle: 0 };
  for (const status of statuses) {
    if (status === "pending" || status === "running" || status === "waiting") counts.working += 1;
    else if (status === "completed") counts.done += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "idle") counts.idle += 1;
    else counts.stopped += 1;
  }
  return (Object.keys(counts) as Array<keyof typeof counts>)
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${SUBAGENT_COUNT_LABELS[key]}`)
    .join(", ");
}

export function formatSubagentDisplayTitle(title: string): string {
  const displayTitle = title.replace(/^Subagent:\s*/i, "");
  const path = /^\/root\/(?:[^/]+\/)*([^/]+)\/?$/u.exec(displayTitle);
  if (path === null) return displayTitle;

  const name = path[1]!.replace(/[_\s]+/gu, " ").trim();
  return name.replace(/(^|\s)\S/gu, (letter) => letter.toUpperCase()) || displayTitle;
}

export function subagentDetailPreview(input: {
  readonly status: OrchestrationV2TurnItemStatus;
  readonly result?: string | null | undefined;
  readonly progress?: string | null | undefined;
}): string | null {
  const terminal = isTerminalSubagentStatus(input.status);
  const preferred = terminal ? input.result : input.progress;
  const fallback = terminal ? input.progress : input.result;
  const detail = preferred?.trimStart() || fallback?.trimStart() || "";
  if (detail.length <= 280) return detail.trimEnd().replace(/\s+/gu, " ") || null;
  const whitespace = /\s+/uy;
  let compact = "";
  for (let index = 0; index < detail.length; index += 1) {
    whitespace.lastIndex = index;
    const gap = whitespace.exec(detail);
    if (gap) {
      index += gap[0].length;
      if (index === detail.length) break;
      if (compact.length > 0) compact += " ";
    }
    compact += detail[index];
    if (compact.length > 280) {
      let end = 280;
      const previous = compact.charCodeAt(end - 1);
      const next = compact.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        end -= 1;
      }
      return `${compact.slice(0, end).trimEnd()}…`;
    }
  }
  return compact || null;
}
