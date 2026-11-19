// The dashboard's 주의 필요 card (DESIGN.md 6j): sessions that wait on the user or stopped on an
// error. A question or approval is answered in place with the conversation's own composer
// (ThreadComposer: the session's `session.pending` questions above its input, lib/pending.ts), and
// an errored session takes its next message the same way. Input that another client holds says
// where to answer it. An error can be put away until the session errs again.
import type { DashboardAttention, SessionSummary } from "@maru/shared";
import { ChevronDownIcon, CircleAlertIcon, MessageCircleQuestionIcon, TerminalIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { attentionKey, formatAgo, keepDismissed, visibleAttention } from "~/lib/dashboardModel";
import { cn } from "~/lib/utils";
import { shortAccount } from "~/model";
import { ThreadComposer } from "../chat/ThreadComposer";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CountBadge, OpenSessionButton, ProviderMark, QuietRow } from "./parts";
import "./dashboard.css";

const DISMISSED_KEY = "maru_dashboard_dismissed";

function readDismissed(): Set<string> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(keys: ReadonlySet<string>): void {
  try {
    if (keys.size) window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...keys]));
    else window.localStorage.removeItem(DISMISSED_KEY);
  } catch {
    // Storage blocked: the choice holds for this page only.
  }
}

export function AttentionSection(props: {
  items: readonly DashboardAttention[] | null;
  /** The list's sessions as /ws keeps them (newer than the work list's copy). */
  live: ReadonlyMap<string, SessionSummary>;
  now: number;
  onOpen: (key: string) => void;
  className?: string;
}) {
  const [dismissed, setDismissed] = useState(readDismissed);
  // Errors that are gone (answered, or the session left the list) are let go from storage.
  useEffect(() => {
    if (!props.items) return;
    const kept = keepDismissed(dismissed, props.items);
    if (kept.size !== dismissed.size) {
      setDismissed(kept);
      writeDismissed(kept);
    }
  }, [props.items, dismissed]);
  const shown = useMemo(() => (props.items ? visibleAttention(props.items, dismissed) : null), [props.items, dismissed]);
  const dismiss = (key: string) => {
    const next = new Set(dismissed).add(key);
    setDismissed(next);
    writeDismissed(next);
  };

  return (
    <SettingsSection
      title="Needs attention"
      className={props.className}
      headerAction={shown?.length ? <CountBadge n={shown.length} /> : null}
      data-dashboard-card="attention"
    >
      {shown === null ? (
        <QuietRow loading>Loading</QuietRow>
      ) : shown.length === 0 ? (
        <QuietRow>None</QuietRow>
      ) : (
        shown.map((a) => (
          <AttentionItem
            key={attentionKey(a)}
            item={a}
            session={props.live.get(a.session.key) ?? (a.kind === "waiting" ? null : a.summary)}
            now={props.now}
            onOpen={() => props.onOpen(a.session.key)}
            onDismiss={a.kind === "error" ? () => dismiss(attentionKey(a)) : undefined}
          />
        ))
      )}
    </SettingsSection>
  );
}

function AttentionItem(props: {
  item: DashboardAttention;
  /** The session for the composer (its /ws copy when the list has it). */
  session: SessionSummary | null;
  now: number;
  onOpen: () => void;
  onDismiss?: () => void;
}) {
  const { item: a, session } = props;
  // A question shows its answer at once; an error shows its message and opens the composer on request.
  const [expanded, setExpanded] = useState(false);
  const when = a.kind === "error" ? a.at : a.since;
  const Icon = a.kind === "question" ? MessageCircleQuestionIcon : a.kind === "waiting" ? TerminalIcon : CircleAlertIcon;
  const label = a.session.label;
  return (
    <div className="px-3 py-3 sm:px-4" data-attention={a.kind}>
      <div className="flex min-w-0 items-center gap-2">
        <Icon
          aria-label={a.kind === "question" ? "Question" : a.kind === "waiting" ? "Waiting for input" : "Error"}
          className={cn(
            "size-4 shrink-0",
            a.kind === "error" ? "text-error-foreground" : a.kind === "question" ? "text-warning-foreground" : "text-muted-foreground",
          )}
        />
        <button
          type="button"
          onClick={props.onOpen}
          title={label}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ProviderMark provider={a.session.provider} />
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{label}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{shortAccount(a.session.account)}</span>
        </button>
        {when !== null ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums" title={new Date(when).toLocaleString()}>
            {formatAgo(when, props.now)}
          </span>
        ) : null}
        {props.onDismiss ? (
          <Tooltip>
            <TooltipTrigger
              render={<Button size="icon-xs" variant="ghost-muted" aria-label="Dismiss" onClick={props.onDismiss} />}
            >
              <XIcon aria-hidden className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">Dismiss</TooltipPopup>
          </Tooltip>
        ) : null}
        <OpenSessionButton onOpen={props.onOpen} />
      </div>
      {a.kind === "waiting" ? <p className="mt-1 ps-6 text-xs text-muted-foreground">{a.reason}</p> : null}
      {a.kind === "error" ? (
        <div className="mt-2 ms-6 flex items-start gap-2 rounded-lg bg-error-surface px-3 py-2 text-xs text-error-foreground">
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{a.message}</span>
          {a.code ? <span className="shrink-0 font-mono opacity-80">{a.code}</span> : null}
        </div>
      ) : null}
      {a.kind === "error" && !a.send.enabled ? <p className="mt-1 ps-6 text-xs text-muted-foreground">{a.send.reason}</p> : null}
      {a.kind === "error" && a.send.enabled && !expanded ? (
        <div className="mt-1.5 ps-6">
          <Button size="xs" variant="ghost-muted" onClick={() => setExpanded(true)}>
            <ChevronDownIcon aria-hidden />
            Send message
          </Button>
        </div>
      ) : null}
      {session && (a.kind === "question" || (a.kind === "error" && a.send.enabled && expanded)) ? (
        <div className="mt-2 ps-6" data-dashboard-composer="">
          <ThreadComposer session={session} isSubagent={false} />
        </div>
      ) : null}
    </div>
  );
}
