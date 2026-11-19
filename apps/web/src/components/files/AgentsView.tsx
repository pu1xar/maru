// The right panel's "작업" tab: every subagent, workflow, background shell command and Monitor of
// the session (GET /api/session-agents), a subagent's own subagents nested under it, newest started
// first. A shell command or Monitor row (a terminal or an eye mark) unfolds to the end of its output
// (lib/taskOutput.ts), refreshed while it runs, and has the same 중단 as an agent.
// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: chat/ThreadRelationshipsControl.tsx (the Lineage row: provider icon with a status dot,
// title, elapsed time, a stop button that takes the elapsed time's place on hover or focus),
// chat/ThreadLineageWorkflowRow.tsx (a workflow folds its phases and agents, a phase header with
// "settled/total agents"), chat/ThreadRelationshipIcon.tsx, chat/threadDetailsPanelStyles.ts (32px
// rows) and ui/collapsible-section-header.tsx. Local changes: Korean text; a workflow agent also
// shows its tokens; state and numbers sit in the row's tooltip in place of T3's hover card;
// a workflow row folds its agents in place (it has no thread of its own to open); colors are this
// app's theme tokens. User requests (2026-11-16): an agent row shows a bot mark instead of the
// provider's logo, its model ("sonnet 4.8") left of the time, a neutral stop button, and a finished
// row recedes (completed dimmed and struck through, stopped or interrupted dimmed).
//
// A row's actions (DESIGN.md 6i), as the terminal's /workflows offers them: 중단 on a running row,
// 이어서 실행 on a workflow that was stopped, interrupted or failed. One button shows while the row is
// hovered or focused, and the menu a right-click opens has the same (the session rows' anchored
// menu, ProjectMenus.tsx). An action the server says cannot run now stays disabled with its reason
// as the tooltip. 중단 asks once first. While an action is on its way the row says so (settling).
import type { AgentAction, OrchestrationV2WorkflowAgent, SessionAgentView } from "@maru/shared";
import { BotIcon, ChevronDownIcon, EyeIcon, MessageSquareIcon, PlayIcon, SquareIcon, TerminalIcon, WorkflowIcon } from "lucide-react";
import {
  useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent as ReactMouseEvent, type ReactNode,
} from "react";

import {
  actionTooltip, agentMenuItems, agentRowActive, agentRowKey as rowKey, agentStatusLabel, workflowAgentState,
} from "~/lib/agentActions";
import { refreshSessionAgents, useSessionAgents } from "~/lib/sessionAgents";
import { truncationNote, useTaskOutput } from "~/lib/taskOutput";
import { cn } from "~/lib/utils";
import { describeError, resumeSessionWorkflow, stopSessionAgent } from "~/projectsApi";
import { isOrchestrationV2WorkActive } from "~/t3-shared/contracts";
import { deriveSubagentElapsedMs, formatDuration } from "~/t3-shared/orchestrationTiming";
import { AgentElapsed } from "../chat/AgentElapsed";
import { shortModelLabel } from "~/lib/modelLabel";
import { reportProjectFailure } from "../ProjectDialogs";
import { popupPosition, useAnchoredMenu, type AnchoredMenu } from "../ProjectMenus";
import { Button } from "../ui/button";
import { Dialog, DialogAction, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { readHideDone, visibleAgents, writeHideDone } from "~/lib/agentsFilter";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { plural } from "../../lib/plural.ts";

/**
 * T3's panel row (threadDetailsPanelStyles THREAD_DETAILS_PANEL_ROW_CLASS) on this app's tokens. T3's
 * 13px text is written as 13/12 of text-xs, so the right panel's zoom scales it with the row.
 */
const ROW_CLASS =
  "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[calc(var(--text-xs)*13/12)] font-medium text-foreground/80 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-disabled:cursor-default aria-disabled:hover:bg-transparent";

/** Trailing text of a row (elapsed time, state). */
const TRAILING_CLASS = "shrink-0 text-2xs font-normal tabular-nums text-muted-foreground";

/** The trailing text yields its place to the row's action while that shows (T3 trailingVisibilityClass). */
const YIELD_TO_ACTION_CLASS =
  "group-hover/agent-row:opacity-0 group-focus-within/agent-row:opacity-0 pointer-coarse:opacity-0";

const ACTION_SLOT_CLASS =
  "pointer-events-none absolute top-1/2 -translate-y-1/2 opacity-0 group-hover/agent-row:pointer-events-auto group-hover/agent-row:opacity-100 group-focus-within/agent-row:pointer-events-auto group-focus-within/agent-row:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100";

/**
 * By start time, the newest on top (user requests: running-first reordered the list as agents
 * settled; then "최근 게 위로"). A row keeps its place as its state changes. A row without a start
 * time goes by its last update and sinks below the timed ones; ties keep the server's order.
 */
function byStart(a: SessionAgentView, b: SessionAgentView): number {
  const at = Date.parse(a.startedAt ?? a.updatedAt ?? "");
  const bt = Date.parse(b.startedAt ?? b.updatedAt ?? "");
  if (Number.isNaN(at) || Number.isNaN(bt)) return Number.isNaN(at) ? (Number.isNaN(bt) ? 0 : 1) : -1;
  return bt - at;
}

/** Top-level agents with the ones they started under them; an orphan's parent shows at top level. */
export function agentTree(list: readonly SessionAgentView[]): { agent: SessionAgentView; depth: number }[] {
  const ids = new Set(list.map((a) => a.id));
  const children = new Map<string, SessionAgentView[]>();
  const roots: SessionAgentView[] = [];
  for (const a of list) {
    if (a.parentAgentId && ids.has(a.parentAgentId)) {
      const arr = children.get(a.parentAgentId) ?? [];
      arr.push(a);
      children.set(a.parentAgentId, arr);
    } else {
      roots.push(a);
    }
  }
  const out: { agent: SessionAgentView; depth: number }[] = [];
  const walk = (a: SessionAgentView, depth: number) => {
    out.push({ agent: a, depth });
    for (const c of (children.get(a.id) ?? []).sort(byStart)) walk(c, depth + 1);
  };
  for (const r of roots.sort(byStart)) walk(r, 0);
  return out;
}

type Provider = "claude" | "codex";

/** The row's main button, the place focus returns to when the element it was on goes away. */
function rowButton(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-agent-row="${CSS.escape(key)}"]`);
}

export function AgentsView(props: {
  /** The session the rows belong to; the actions name it. */
  sessionKey: string;
  agents: readonly SessionAgentView[];
  error: string | null;
  onOpenThread: (threadId: string, title: string) => void;
}) {
  const { sessionKey } = props;
  // The rows are read while this tab shows; `loaded` tells "no rows yet" from "none".
  const { loaded } = useSessionAgents(sessionKey, true);
  const provider: Provider = sessionKey.startsWith("codex:") ? "codex" : "claude";
  // Finished rows hide by default (user request); the switch above the list shows them again.
  const [hideDone, setHideDone] = useState(readHideDone);
  const { shown: listed, hidden: hiddenDone } = visibleAgents(props.agents, hideDone);
  const rows = agentTree(listed);
  const menu = useAnchoredMenu<SessionAgentView>();
  // While the menu is open its row is looked up again, so a state change from the next read shows.
  const openKey = menu.open && menu.state ? rowKey(menu.state.target) : null;
  const menuAgent = (openKey && props.agents.find((a) => rowKey(a) === openKey)) || (menu.state?.target ?? null);
  // Rows whose action is on its way to the server.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const mark = (k: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(k);
      else next.delete(k);
      return next;
    });
  // Workflow rows the user unfolded, and phases opened or closed by hand (T3 folds both).
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [phaseOpen, setPhaseOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  // `seq` remounts the dialog per request; it stays mounted until its exit animation ends.
  const [stopping, setStopping] = useState<{ seq: number; open: boolean; agent: SessionAgentView } | null>(null);
  const askStop = (agent: SessionAgentView) => setStopping((prev) => ({ seq: (prev?.seq ?? 0) + 1, open: true, agent }));
  const resume = (agent: SessionAgentView) => {
    const k = rowKey(agent);
    mark(k, true);
    resumeSessionWorkflow({ key: sessionKey, id: agent.id })
      .catch((err: unknown) => reportProjectFailure("Could not resume", err))
      .finally(() => {
        mark(k, false);
        refreshSessionAgents(sessionKey);
      });
  };
  const open = (agent: SessionAgentView) => {
    if (agent.childThreadId) props.onOpenThread(agent.childThreadId, agent.title);
  };

  // Focus stays in a row whose focused element a state change removed (an action button that
  // went away, a row that ended): it moves to that row's main button instead of the page.
  const listRef = useRef<HTMLUListElement>(null);
  const focused = useRef<{ row: string; el: HTMLElement } | null>(null);
  const restoreFocus = () => {
    const f = focused.current;
    if (!f || f.el.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const target = rowButton(f.row);
    if (target) target.focus({ preventScroll: true });
    else focused.current = null;
  };
  useLayoutEffect(restoreFocus);
  const onFocus = (event: FocusEvent<HTMLUListElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-agent-li]")?.dataset.agentLi;
    focused.current = row ? { row, el: event.target as HTMLElement } : null;
  };
  const onBlur = (event: FocusEvent<HTMLUListElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && listRef.current?.contains(next)) return;
    if (next) {
      focused.current = null;
      return;
    }
    // Focus went nowhere: the element was removed (keep the row) or the page was clicked (forget it).
    const el = event.target as HTMLElement;
    requestAnimationFrame(() => {
      if (focused.current?.el !== el) return;
      if (el.isConnected) focused.current = null;
      else restoreFocus();
    });
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
      {props.agents.length ? (
        <label className="flex cursor-pointer items-center justify-end gap-2 px-2.5 pb-1.5 text-xs text-muted-foreground select-none">
          <span>{hideDone && hiddenDone ? `${hiddenDone} done hidden` : "Hide done"}</span>
          <Switch
            size="sm"
            checked={hideDone}
            onCheckedChange={(on) => {
              setHideDone(on);
              writeHideDone(on);
            }}
            aria-label="Hide completed items"
          />
        </label>
      ) : null}
      {props.error ? (
        <p role="alert" className="px-2.5 py-1.5 text-xs text-error-foreground">
          {props.error}
        </p>
      ) : null}
      {rows.length === 0 && !props.error ? (
        loaded ? (
          <p className="px-2.5 py-1.5 text-xs text-muted-foreground">{hiddenDone ? "No running activity" : "No activity"}</p>
        ) : (
          <div className="flex justify-center py-6">
            <Spinner size="md" tone="muted" aria-label="Loading" />
          </div>
        )
      ) : null}
      {rows.length ? (
        <ul ref={listRef} aria-label="Activity list" className="m-0 flex list-none flex-col p-0" onFocus={onFocus} onBlur={onBlur}>
          {rows.map(({ agent, depth }) => {
            const k = rowKey(agent);
            return (
              <AgentRow
                key={k}
                sessionKey={sessionKey}
                rowKey={k}
                agent={agent}
                depth={depth}
                provider={provider}
                busy={busy.has(k)}
                menuOpen={openKey === k}
                unfolded={unfolded.has(k)}
                onToggle={() => setUnfolded((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(k)) next.add(k);
                  return next;
                })}
                phaseOpen={(index, fallback) => phaseOpen.get(`${k}:${index}`) ?? fallback}
                onPhaseToggle={(index, now) => setPhaseOpen((prev) => new Map(prev).set(`${k}:${index}`, !now))}
                onOpenThread={props.onOpenThread}
                onStop={() => askStop(agent)}
                onResume={() => resume(agent)}
                onContextMenu={(event) => {
                  if (agentMenuItems(agent).length === 0) return;
                  event.preventDefault();
                  menu.showAtPointer(agent, event);
                }}
              />
            );
          })}
        </ul>
      ) : null}
      <AgentActionMenu
        menu={menu}
        agent={menuAgent}
        busy={menuAgent ? busy.has(rowKey(menuAgent)) : false}
        onStop={askStop}
        onResume={resume}
        onOpen={open}
      />
      {stopping ? (
        <StopAgentDialog
          key={stopping.seq}
          open={stopping.open}
          sessionKey={sessionKey}
          agent={stopping.agent}
          onBusy={(on) => mark(rowKey(stopping.agent), on)}
          onClose={() => setStopping((prev) => (prev ? { ...prev, open: false } : prev))}
          onClosed={() => setStopping((prev) => (prev && !prev.open ? null : prev))}
        />
      ) : null}
    </div>
  );
}

const DOT_CLASS = {
  active: "bg-info",
  failed: "bg-destructive",
  completed: "bg-success",
  ended: "bg-muted-foreground/45",
} as const;

function dotOf(status: string, active: boolean): string {
  if (active || isOrchestrationV2WorkActive(status) || status === "queued") return DOT_CLASS.active;
  if (status === "failed") return DOT_CLASS.failed;
  if (status === "completed") return DOT_CLASS.completed;
  return DOT_CLASS.ended;
}

/**
 * What the row is, an agent (bot), a workflow, a background shell command (terminal) or a Monitor
 * (eye), with T3's status dot (ThreadRelationshipIcon). The agent mark is a bot, not the provider's
 * logo (user request: the logo said nothing a row needs).
 */
function AgentIcon({ kind, status, active }: { kind: SessionAgentView["kind"]; status: string; active: boolean }) {
  const icon = "size-4 shrink-0 text-muted-foreground";
  return (
    <span aria-hidden className="relative inline-flex size-4 shrink-0 items-center justify-center">
      {kind === "workflow" ? <WorkflowIcon className={icon} /> : kind === "shell" ? <TerminalIcon className={icon} /> : kind === "monitor" ? <EyeIcon className={icon} /> : <BotIcon className={icon} />}
      <span className={cn("absolute -right-1 -bottom-1 size-2 rounded-full border-2 border-side-surface", dotOf(status, active))} />
    </span>
  );
}

/** Lines of a row's tooltip: what the row does not spell out. */
function Facts({ title, lines }: { title: string; lines: (string | null | false | undefined)[] }) {
  return (
    <span className="flex max-w-80 flex-col gap-0.5">
      <span className="font-medium break-words">{title}</span>
      {lines.filter(Boolean).map((line) => (
        <span key={line as string} className="line-clamp-6 break-words text-muted-foreground">{line}</span>
      ))}
    </span>
  );
}

function AgentRow({
  sessionKey,
  rowKey: k,
  agent: a,
  depth,
  provider,
  busy,
  menuOpen,
  unfolded,
  onToggle,
  phaseOpen,
  onPhaseToggle,
  onOpenThread,
  onStop,
  onResume,
  onContextMenu,
}: {
  sessionKey: string;
  rowKey: string;
  agent: SessionAgentView;
  depth: number;
  provider: Provider;
  busy: boolean;
  menuOpen: boolean;
  unfolded: boolean;
  onToggle: () => void;
  phaseOpen: (index: number, fallback: boolean) => boolean;
  onPhaseToggle: (index: number, now: boolean) => void;
  onOpenThread: (id: string, title: string) => void;
  onStop: () => void;
  onResume: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const isWorkflow = a.kind === "workflow";
  // A shell command or Monitor has no conversation: its row unfolds to its output.
  const isTask = a.kind === "shell" || a.kind === "monitor";
  const foldable = isWorkflow || isTask;
  const canOpen = !foldable && a.childThreadId !== null;
  const state = agentStatusLabel(a);
  const active = agentRowActive(a);
  const failed = a.status === "failed" && !a.settling;
  // A finished row recedes (user request): completed is dimmed and struck through; stopped or
  // interrupted is dimmed only, since 이어서 실행 can still bring it back.
  const done = !active && !a.settling && a.status === "completed";
  const ended = !active && !a.settling && (a.status === "cancelled" || a.status === "interrupted");
  const model = foldable ? null : shortModelLabel(a.model);
  // A command's exit code once it ended (a Monitor has none). A stopped one shows its state alone:
  // the CLI's 144 for a SIGTERM is no result of the command.
  const exitText = isTask && !active && !ended && typeof a.exitCode === "number" ? `exit ${a.exitCode}` : null;
  // One slot for the row's action, so the button keeps its place (and focus) when stop turns into resume.
  const action = a.stop
    ? { label: "Stop", action: a.stop, run: onStop, destructive: false, icon: <SquareIcon aria-hidden className="size-3 fill-current" /> }
    : a.resume
      ? { label: "Resume", action: a.resume, run: onResume, destructive: false, icon: <PlayIcon aria-hidden className="size-3.5" /> }
      : null;
  const showsAction = Boolean(action) && (busy || menuOpen);
  const counts = isWorkflow && a.workflow ? settledCount(a.workflow.agents, isOrchestrationV2WorkActive(a.status) ? null : a.status) : null;
  // The elapsed time, or the state when the row has no time to show or its state matters more.
  const trailing = a.settling || failed || deriveSubagentElapsedMs(a, 0) === null
    ? <span className={cn(TRAILING_CLASS, failed && "text-destructive-foreground", a.settling && "text-info-foreground")}>{state}</span>
    : <span className={TRAILING_CLASS}><AgentElapsed agent={a} compact /></span>;
  return (
    <li
      data-agent-li={k}
      className="group/agent-row relative"
      style={depth ? { paddingInlineStart: `${depth * 1.25}rem` } : undefined}
      onContextMenu={onContextMenu}
    >
      <Tooltip>
        <TooltipTrigger
          delay={400}
          render={
            <button
              type="button"
              data-agent-row={k}
              aria-label={`${a.title}, ${state}`}
              aria-expanded={foldable ? unfolded : undefined}
              aria-disabled={!foldable && !canOpen ? true : undefined}
              onClick={() => {
                if (foldable) onToggle();
                else if (canOpen) onOpenThread(a.childThreadId!, a.title);
              }}
              className={cn(ROW_CLASS, menuOpen && "bg-accent", (done || ended) && "opacity-55")}
            />
          }
        >
          <AgentIcon kind={a.kind} status={a.status} active={active} />
          <span className={cn("block min-w-0 flex-1 truncate text-sm leading-4 text-foreground/85", done && "line-through decoration-muted-foreground")}>{a.title}</span>
          <span className={cn("flex shrink-0 items-center gap-2", action && YIELD_TO_ACTION_CLASS, showsAction && "opacity-0")}>
            {counts ? <span className={TRAILING_CLASS}>{counts.settled}/{counts.total}</span> : null}
            {exitText ? <span className={cn(TRAILING_CLASS, a.exitCode !== 0 && "text-destructive-foreground")}>{exitText}</span> : null}
            {model ? <span className={TRAILING_CLASS}>{model}</span> : null}
            {trailing}
          </span>
          {foldable ? (
            <ChevronDownIcon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !unfolded && "-rotate-90")} />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="left">
          <Facts
            title={a.title}
            lines={[
              state,
              counts && `agent ${counts.settled}/${counts.total}`,
              a.workflow?.totalTokens !== undefined && `${compactNumber(a.workflow.totalTokens)} tokens`,
              isTask && a.endSummary,
              isTask && a.command && `$ ${a.command}`,
              isTask && a.cwd,
              a.agentType && a.agentType !== "general-purpose" && a.agentType,
              a.model,
            ]}
          />
        </TooltipPopup>
      </Tooltip>
      {action ? (
        // A sibling of the row's button, over its trailing text (T3: right-1, a workflow's left of its chevron).
        <span className={cn(ACTION_SLOT_CLASS, foldable ? "right-7" : "right-1", showsAction && "pointer-events-auto opacity-100")}>
          <RowAction key="action" label={action.label} action={action.action} busy={busy} destructive={action.destructive} onRun={action.run}>
            {action.icon}
          </RowAction>
        </span>
      ) : null}
      {isTask && unfolded ? <TaskOutputPane sessionKey={sessionKey} agent={a} active={active} /> : null}
      {isWorkflow && unfolded && a.workflow ? (
        <WorkflowAgents
          workflow={a.workflow}
          provider={provider}
          endedAs={isOrchestrationV2WorkActive(a.status) ? null : a.status}
          phaseOpen={phaseOpen}
          onPhaseToggle={onPhaseToggle}
          onOpenThread={onOpenThread}
        />
      ) : null}
    </li>
  );
}

/** A row's action button; a disabled one keeps its pointer events so its reason shows on hover. */
function RowAction(props: { label: string; action: AgentAction; busy: boolean; destructive: boolean; onRun: () => void; children: ReactNode }) {
  const { action, busy } = props;
  const disabled = !action.enabled || busy;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={props.label}
            aria-disabled={disabled || undefined}
            className={cn("sm:size-6", props.destructive && "text-destructive-foreground [:hover,[data-pressed]]:text-destructive-foreground")}
            onClick={(event) => {
              event.stopPropagation();
              if (!disabled) props.onRun();
            }}
          />
        }
      >
        {busy ? <Spinner size="xs" /> : props.children}
      </TooltipTrigger>
      <TooltipPopup side="left">{actionTooltip(props.label, action)}</TooltipPopup>
    </Tooltip>
  );
}

/** The right-click menu of a row: the row's actions, then opening its conversation. */
function AgentActionMenu(props: {
  menu: AnchoredMenu<SessionAgentView>;
  agent: SessionAgentView | null;
  busy: boolean;
  onStop: (agent: SessionAgentView) => void;
  onResume: (agent: SessionAgentView) => void;
  onOpen: (agent: SessionAgentView) => void;
}) {
  const { menu, agent, busy } = props;
  const state = menu.state;
  const items = agent ? agentMenuItems(agent) : [];
  return (
    <Menu open={menu.open} onOpenChange={menu.onOpenChange}>
      {state && agent && items.length > 0 ? (
        <MenuPopup
          aria-label="Activity menu"
          anchor={state.anchor}
          {...popupPosition(state.placement)}
          className="min-w-44"
          // A right-click menu has no button to go back to: focus returns to the row.
          finalFocus={() => rowButton(rowKey(agent)) ?? true}
        >
          {agent.stop ? (
            <ActionMenuItem label="Stop" action={agent.stop} busy={busy} onRun={() => props.onStop(agent)}>
              <SquareIcon className="size-3 fill-current" />
            </ActionMenuItem>
          ) : null}
          {agent.resume ? (
            <ActionMenuItem label="Resume" action={agent.resume} busy={busy} onRun={() => props.onResume(agent)}>
              <PlayIcon />
            </ActionMenuItem>
          ) : null}
          {items.includes("open") ? (
            <>
              {items.length > 1 ? <MenuSeparator /> : null}
              <MenuItem onClick={() => props.onOpen(agent)}>
                <MessageSquareIcon />
                Open conversation
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      ) : null}
    </Menu>
  );
}

/** A menu entry for a row action; a disabled one takes the pointer so its reason shows as a tooltip. */
function ActionMenuItem(props: { label: string; action: AgentAction; busy: boolean; onRun: () => void; children: ReactNode }) {
  const { action } = props;
  if (action.enabled && !props.busy) {
    return (
      <MenuItem onClick={props.onRun}>
        {props.children}
        {props.label}
      </MenuItem>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<MenuItem disabled className="data-disabled:pointer-events-auto" />}>
        {props.children}
        {props.label}
      </TooltipTrigger>
      <TooltipPopup side="right">{actionTooltip(props.label, action)}</TooltipPopup>
    </Tooltip>
  );
}

/** 중단 asks once: a workflow keeps its finished agents' results for 이어서 실행. */
function StopAgentDialog(props: {
  open: boolean;
  sessionKey: string;
  agent: SessionAgentView;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onClosed: () => void;
}) {
  const { open, agent, onClose } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openRef = useRef(open);
  // Read by a reply that arrives after the dialog was closed.
  useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);
  const stop = async () => {
    setBusy(true);
    setError(null);
    props.onBusy(true);
    try {
      await stopSessionAgent({ key: props.sessionKey, kind: agent.kind, id: agent.id });
      onClose();
    } catch (err) {
      if (openRef.current) setError(`Could not stop: ${describeError(err)}`);
      else reportProjectFailure("Could not stop", err);
    } finally {
      setBusy(false);
      props.onBusy(false);
      refreshSessionAgents(props.sessionKey);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) props.onClosed();
      }}
    >
      <DialogPopup
        className="sm:max-w-md"
        showCloseButton={false}
        // The button that opened it can be gone by now (the row stopped): focus goes to the row.
        finalFocus={() => rowButton(rowKey(agent)) ?? true}
      >
        <DialogHeader>
          <DialogTitle>Stop "{agent.title}"?</DialogTitle>
          {agent.kind === "workflow" ? (
            <DialogDescription>Resuming does not rerun agents that already finished</DialogDescription>
          ) : agent.kind === "shell" ? (
            <DialogDescription>Ends the running command</DialogDescription>
          ) : agent.kind === "monitor" ? (
            <DialogDescription>Stops watching</DialogDescription>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive-foreground text-sm">
              {error}
            </p>
          ) : null}
        </DialogHeader>
        <DialogFooter>
          {/* The dialog's initial focus goes to its first action, so Enter cancels. */}
          <DialogClose render={<DialogAction variant="outline" />}>Cancel</DialogClose>
          {/* aria-disabled keeps focus on the button while the request is on its way. */}
          <Button variant="destructive" aria-disabled={busy || undefined} onClick={() => (busy ? undefined : void stop())}>
            {busy ? "Stopping" : "Stop"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** How many agents ended (done, failed, or ended with a workflow that no longer runs). */
function settledCount(agents: readonly OrchestrationV2WorkflowAgent[], endedAs: SessionAgentView["status"] | null): { settled: number; total: number } {
  const settled = agents.filter((a) => a.state === "completed" || a.state === "failed" || endedAs !== null).length;
  return { settled, total: agents.length };
}

/** A workflow's agents under its row: by phase (T3 folds a phase that is not running), each a row. */
function WorkflowAgents({
  workflow,
  provider,
  endedAs,
  phaseOpen,
  onPhaseToggle,
  onOpenThread,
}: {
  workflow: NonNullable<SessionAgentView["workflow"]>;
  provider: Provider;
  /**
   * The workflow's own state once it no longer runs (stopped, interrupted, failed): an agent its
   * records still show as running or queued ended with it.
   */
  endedAs: SessionAgentView["status"] | null;
  phaseOpen: (index: number, fallback: boolean) => boolean;
  onPhaseToggle: (index: number, now: boolean) => void;
  onOpenThread: (id: string, title: string) => void;
}) {
  const inPhase = (phase: { index: number; title: string }) =>
    workflow.agents.filter((a) => a.phaseIndex === phase.index || (a.phaseIndex === undefined && a.phaseTitle === phase.title));
  const phases = workflow.phases.map((p) => ({ ...p, members: inPhase(p) })).filter((p) => p.members.length > 0);
  const phased = new Set(phases.flatMap((p) => p.members));
  const loose = workflow.agents.filter((a) => !phased.has(a));
  const member = (a: OrchestrationV2WorkflowAgent) => (
    <WorkflowAgentRow key={a.index} agent={a} provider={provider} endedAs={endedAs} onOpenThread={onOpenThread} />
  );
  return (
    <ul className="m-0 list-none p-0 ps-6.5">
      {phases.map((phase) => {
        const running = !endedAs && phase.members.some((a) => a.state === "running" || a.state === "queued");
        const open = phaseOpen(phase.index, running || phases.length === 1);
        const { settled, total } = settledCount(phase.members, endedAs);
        const failed = phase.members.some((a) => a.state === "failed");
        return (
          <li key={phase.index}>
            {/* T3 CollapsibleSectionHeader, panel variant. */}
            <button
              type="button"
              aria-expanded={open}
              onClick={() => onPhaseToggle(phase.index, open)}
              className={cn(
                "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md ps-2 pe-2.5 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                running ? "text-foreground/80" : "text-muted-foreground",
              )}
            >
              <span className="min-w-0 truncate">{phase.title}</span>
              <span aria-hidden className="h-px min-w-2 flex-1 invisible" />
              {failed ? <span className="shrink-0 text-3xs leading-none text-destructive-foreground">Failed</span> : null}
              <span className="shrink-0 text-2xs font-normal tabular-nums">{settled}/{total} agent</span>
              <ChevronDownIcon aria-hidden className={cn("size-3 shrink-0 transition-transform", !open && "-rotate-90")} />
            </button>
            {open ? <ul className="m-0 list-none p-0">{phase.members.map(member)}</ul> : null}
          </li>
        );
      })}
      {loose.map(member)}
      {workflow.agents.length === 0 ? <li className="px-2.5 py-1.5 text-2xs text-muted-foreground">No agents</li> : null}
    </ul>
  );
}

/** One agent of a workflow: its state, name, model, tokens and time; its tools in the tooltip. */
function WorkflowAgentRow({
  agent: a,
  provider,
  endedAs,
  onOpenThread,
}: {
  agent: OrchestrationV2WorkflowAgent;
  provider: Provider;
  endedAs: SessionAgentView["status"] | null;
  onOpenThread: (id: string, title: string) => void;
}) {
  const state = workflowAgentState(a, endedAs);
  const canOpen = a.childThreadId !== undefined;
  const live = a.state === "running" && !endedAs;
  const time = a.durationMs !== undefined
    ? formatDuration(a.durationMs)
    : null;
  const done = state.status === "completed";
  // Stopped or interrupted with its workflow: dimmed like the rows above, without the strike.
  const ended = state.status === "cancelled" || state.status === "interrupted";
  const model = shortModelLabel(a.model);
  return (
    <li>
      <Tooltip>
        <TooltipTrigger
          delay={400}
          render={
            <button
              type="button"
              aria-label={`${a.label}, ${state.label}`}
              aria-disabled={canOpen ? undefined : true}
              onClick={() => canOpen && onOpenThread(a.childThreadId!, a.label)}
              className={cn(ROW_CLASS, (done || ended) && "opacity-55")}
            />
          }
        >
          <AgentIcon kind="agent" status={state.status} active={false} />
          <span className={cn("block min-w-0 flex-1 truncate text-sm leading-4 text-foreground/85", done && "line-through decoration-muted-foreground")}>{a.label}</span>
          {/* The state where it is not plain done, unless a running agent's time says it. */}
          {state.status !== "completed" && !(live && a.startedAt !== undefined) ? (
            <span className={cn(TRAILING_CLASS, state.status === "failed" && "text-destructive-foreground")}>{state.label}</span>
          ) : null}
          {model ? <span className={TRAILING_CLASS}>{model}</span> : null}
          {a.totalTokens !== undefined ? (
            <span className={cn(TRAILING_CLASS, "min-w-16 text-end")}>{compactNumber(a.totalTokens)} tokens</span>
          ) : null}
          {time ? (
            <span className={cn(TRAILING_CLASS, "min-w-12 text-end")}>{time}</span>
          ) : live && a.startedAt !== undefined ? (
            <span className={cn(TRAILING_CLASS, "min-w-12 text-end")}>
              <AgentElapsed agent={{ status: "running", startedAt: new Date(a.startedAt).toISOString(), completedAt: null }} />
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="left">
          <Facts
            title={a.label}
            lines={[
              state.label,
              a.totalTokens !== undefined && `${compactNumber(a.totalTokens)} tokens`,
              a.toolCalls !== undefined && plural(a.toolCalls, "tool call"),
              time,
              a.model,
            ]}
          />
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}

/**
 * The end of a shell command's or Monitor's output under its row (lib/taskOutput.ts). The text
 * follows the bottom while it is scrolled there, and stays where the reader put it otherwise.
 */
function TaskOutputPane({ sessionKey, agent, active }: { sessionKey: string; agent: SessionAgentView; active: boolean }) {
  // The Codex daemon gives no output while a terminal runs; its item holds it once it ended (DESIGN.md 6i).
  const noOutputYet = sessionKey.startsWith("codex:") && active;
  const { out, error, loaded } = useTaskOutput(sessionKey, agent.kind, agent.id, !noOutputYet, active);
  const box = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [out?.output]);
  const shownBytes = out ? new TextEncoder().encode(out.output).length : 0;
  const note = out ? truncationNote(out, shownBytes) : null;
  return (
    <div data-task-output={agent.id} className="mx-2.5 mt-0.5 mb-1.5 ms-9 flex min-w-0 flex-col gap-1">
      {agent.command ? <p className="m-0 line-clamp-2 font-mono text-2xs break-all text-muted-foreground">$ {agent.command}</p> : null}
      {agent.cwd ? <p className="m-0 font-mono text-2xs break-all text-muted-foreground">{agent.cwd}</p> : null}
      {noOutputYet ? (
        <p className="m-0 text-xs text-muted-foreground">Codex does not provide the output of a running terminal (shown once it ends)</p>
      ) : error ? (
        <p role="alert" className="m-0 text-xs text-error-foreground">{error}</p>
      ) : !loaded ? (
        <Spinner size="xs" tone="muted" aria-label="Loading output" />
      ) : out && out.output ? (
        <>
          {note ? <p className="m-0 text-2xs text-muted-foreground">{note}</p> : null}
          <pre
            ref={box}
            tabIndex={0}
            aria-label={`${agent.title} output`}
            onScroll={(e) => {
              const el = e.currentTarget;
              atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
            }}
            className="m-0 max-h-56 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-2xs leading-4 whitespace-pre-wrap break-all text-foreground/85"
          >
            {out.output}
          </pre>
        </>
      ) : (
        <p className="m-0 text-xs text-muted-foreground">{active ? "No output yet" : "No output"}</p>
      )}
    </div>
  );
}

function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
