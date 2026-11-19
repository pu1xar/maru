// The dashboard's 실행 중 card (DESIGN.md 6j): every turn in progress and every running subagent and
// workflow of the list's sessions, gathered under their session, with how long each has run. A
// turn's 멈추기 is the composer's interrupt; a subagent's or workflow's 중단 (asked once first) and
// a stopped workflow's 이어서 실행 are the 작업 tab's (DESIGN.md 6i). An action the server says
// cannot run now stays disabled with its reason as the tooltip. A session's name opens it.
// Workflows that stopped earlier wait behind a count per session, and sessions that have nothing
// but those behind one at the foot; a workflow stopped from here stays in its session's rows.
import type { AgentAction, DashboardAgent, DashboardTask, DashboardWork } from "@maru/shared";
import { BotIcon, ChevronDownIcon, ChevronRightIcon, CircleDashedIcon, CircleIcon, PlayIcon, SquareIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { interruptTurn, keepStoppedHere, resumeTask, stopTask, taskActions, useStoppedHere } from "~/lib/dashboardActions";
import { groupRunning, runningCount, taskKey, type RunningGroup } from "~/lib/dashboardModel";
import { refreshDashboardWork } from "~/lib/dashboardWork";
import { actionTooltip } from "~/lib/agentActions";
import { cn } from "~/lib/utils";
import { shortAccount } from "~/model";
import { describeError } from "~/projectsApi";
import { reportProjectFailure } from "../ProjectDialogs";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Dialog, DialogAction, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CountBadge, Elapsed, OpenSessionButton, ProviderMark, QuietRow } from "./parts";
import { plural } from "../../lib/plural.ts";

const STATUS_LABEL: Record<DashboardAgent["status"], string> = {
  running: "Running",
  pending: "Pending",
  waiting: "Waiting for input",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  idle: "Idle",
};

const SESSION_STATUS: Record<string, string> = {
  running: "Turn running",
  "waiting-input": "Waiting for input",
  "open-idle": "Idle",
  closed: "Closed",
  error: "Error",
};

export function RunningSection(props: { work: DashboardWork | null; onOpen: (key: string) => void; className?: string }) {
  const { work } = props;
  const stoppedHere = useStoppedHere();
  const groups = useMemo(() => (work ? groupRunning(work, stoppedHere) : null), [work, stoppedHere]);
  // Rows stopped from here are let go once the server no longer lists them.
  useEffect(() => {
    if (work) keepStoppedHere(new Set(work.tasks.map(taskKey)));
  }, [work]);
  // Rows whose action is on its way to the server.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const mark = (k: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(k);
      else next.delete(k);
      return next;
    });
  const [stopping, setStopping] = useState<{ seq: number; open: boolean; task: DashboardTask } | null>(null);
  const [idleOpen, setIdleOpen] = useState(false);

  const actions: GroupActions = {
    busy,
    onStopTurn: (g) => {
      const ok = interruptTurn(g.session.key, (error) => reportProjectFailure("Could not stop", new Error(error)));
      if (!ok) reportProjectFailure("Could not stop", new Error("Disconnected from server, could not send"));
      refreshDashboardWork();
    },
    onStopTask: (task) => setStopping((prev) => ({ seq: (prev?.seq ?? 0) + 1, open: true, task })),
    onResumeTask: (t) => {
      const k = taskKey(t);
      mark(k, true);
      resumeTask(t)
        .catch((err: unknown) => reportProjectFailure("Could not resume", err))
        .finally(() => {
          mark(k, false);
          refreshDashboardWork();
        });
    },
  };

  const count = work ? runningCount(work) : 0;
  const idleWorkflows = groups ? groups.idle.reduce((n, g) => n + g.stopped.length, 0) : 0;
  return (
    <SettingsSection
      title="Running"
      className={props.className}
      headerAction={count ? <CountBadge n={count} /> : null}
      data-dashboard-card="running"
    >
      {groups === null ? (
        <QuietRow loading>Loading</QuietRow>
      ) : (
        <>
          {groups.active.length === 0 ? <QuietRow>None</QuietRow> : null}
          {groups.active.map((g) => (
            <SessionGroup key={g.session.key} group={g} actions={actions} onOpen={() => props.onOpen(g.session.key)} />
          ))}
          {groups.idle.length ? (
            <div data-idle-groups="">
              <button
                type="button"
                aria-expanded={idleOpen}
                onClick={() => setIdleOpen((v) => !v)}
                className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2.5 text-left text-xs text-muted-foreground hover:text-foreground sm:px-4"
              >
                {idleOpen ? <ChevronDownIcon aria-hidden className="size-3.5" /> : <ChevronRightIcon aria-hidden className="size-3.5" />}
                {plural(groups.idle.length, "session")} with only stopped workflows, {plural(idleWorkflows, "workflow")}
              </button>
              {idleOpen
                ? groups.idle.map((g) => (
                    <SessionGroup key={g.session.key} group={g} actions={actions} stoppedOpen onOpen={() => props.onOpen(g.session.key)} />
                  ))
                : null}
            </div>
          ) : null}
        </>
      )}
      {stopping ? (
        <StopTaskDialog
          key={stopping.seq}
          open={stopping.open}
          task={stopping.task}
          onBusy={(on) => mark(taskKey(stopping.task), on)}
          onClose={() => setStopping((prev) => (prev ? { ...prev, open: false } : prev))}
          onClosed={() => setStopping((prev) => (prev && !prev.open ? null : prev))}
        />
      ) : null}
    </SettingsSection>
  );
}

interface GroupActions {
  busy: ReadonlySet<string>;
  onStopTurn: (g: RunningGroup) => void;
  onStopTask: (t: DashboardTask) => void;
  onResumeTask: (t: DashboardTask) => void;
}

function SessionGroup(props: { group: RunningGroup; actions: GroupActions; onOpen: () => void; stoppedOpen?: boolean }) {
  const { group: g, actions } = props;
  const s = g.session;
  const [showStopped, setShowStopped] = useState(props.stoppedOpen ?? false);
  const row = (task: DashboardTask, depth: number) => (
    <TaskRow
      key={taskKey(task)}
      task={task}
      depth={depth}
      busy={actions.busy.has(taskKey(task))}
      onStop={() => actions.onStopTask(task)}
      onResume={() => actions.onResumeTask(task)}
    />
  );
  return (
    <div className="px-3 py-2.5 sm:px-4" data-running-session={s.key}>
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={props.onOpen}
          title={s.label}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ProviderMark provider={s.provider} />
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{s.label}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{shortAccount(s.account)}</span>
        </button>
        {g.turn ? (
          <>
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              {/* The main agent at work: a solid circle, as in the sidebar (sessionPresentation.ts). */}
              <CircleIcon aria-hidden className="size-3 text-info-foreground" />
              turn
              {g.turn.startedAt !== null ? <Elapsed since={g.turn.startedAt} /> : null}
            </span>
            <RowAction label="Stop" action={g.turn.stop} busy={false} onRun={() => actions.onStopTurn(g)}>
              <SquareIcon aria-hidden className="size-3 fill-current" />
            </RowAction>
          </>
        ) : (
          g.tasks.length ? (
            // Only subagents or workflows run: the sidebar's dashed circle.
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <CircleDashedIcon aria-hidden className="size-3 text-info-foreground" />
              Background work running
            </span>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">{SESSION_STATUS[s.status] ?? s.status}</span>
          )
        )}
        <OpenSessionButton onOpen={props.onOpen} />
      </div>
      {g.tasks.length ? <ul className="mt-1.5 flex flex-col gap-0.5">{g.tasks.map(({ task, depth }) => row(task, depth))}</ul> : null}
      {g.stopped.length ? (
        <>
          <button
            type="button"
            aria-expanded={showStopped}
            onClick={() => setShowStopped((v) => !v)}
            className="mt-1 ms-5 flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {showStopped ? <ChevronDownIcon aria-hidden className="size-3" /> : <ChevronRightIcon aria-hidden className="size-3" />}
            {plural(g.stopped.length, "stopped workflow")}
          </button>
          {showStopped ? <ul className="mt-0.5 flex flex-col gap-0.5">{g.stopped.map((task) => row(task, 0))}</ul> : null}
        </>
      ) : null}
    </div>
  );
}

function TaskRow(props: { task: DashboardTask; depth: number; busy: boolean; onStop: () => void; onResume: () => void }) {
  const a = props.task.agent;
  const Kind = a.kind === "workflow" ? WorkflowIcon : BotIcon;
  const { stop, resume } = taskActions(a);
  const started = a.startedAt ? Date.parse(a.startedAt) : NaN;
  const running = a.status === "running" || a.status === "pending" || a.status === "waiting";
  return (
    <li
      className="flex min-w-0 items-center gap-2 rounded-md py-0.5 text-xs"
      style={{ paddingInlineStart: `${1.25 + props.depth * 1}rem` }}
      data-task={a.id}
    >
      <Kind aria-hidden className={cn("size-3.5 shrink-0", running ? "text-info-foreground" : "text-icon-muted")} />
      <span className="min-w-0 flex-1 truncate text-foreground/90" title={a.title}>
        {a.title}
      </span>
      {a.progress && a.progress.total ? (
        <span className="shrink-0 text-muted-foreground tabular-nums" title="Finished agents / started agents">
          {a.progress.done}/{a.progress.total}
        </span>
      ) : null}
      {running ? null : <span className="shrink-0 text-muted-foreground">{STATUS_LABEL[a.status]}</span>}
      {running && Number.isFinite(started) ? <Elapsed since={started} className="shrink-0 text-muted-foreground" /> : null}
      <span className="flex shrink-0 items-center">
        {stop ? (
          <RowAction label="Stop" action={stop} busy={props.busy} onRun={props.onStop}>
            <SquareIcon aria-hidden className="size-3 fill-current" />
          </RowAction>
        ) : null}
        {resume ? (
          <RowAction label="Resume" action={resume} busy={props.busy} onRun={props.onResume}>
            <PlayIcon aria-hidden className="size-3.5" />
          </RowAction>
        ) : null}
      </span>
    </li>
  );
}

/** A row's action button; a disabled one keeps its pointer events so its reason shows on hover. */
function RowAction(props: { label: string; action: AgentAction; busy: boolean; onRun: () => void; children: ReactNode }) {
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
            onClick={(event) => {
              event.stopPropagation();
              if (!disabled) props.onRun();
            }}
          />
        }
      >
        {busy ? <Spinner className="size-3" /> : props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{actionTooltip(props.label, action)}</TooltipPopup>
    </Tooltip>
  );
}

/** 중단 asks once, as in the 작업 tab: a workflow keeps its finished agents' results for 이어서 실행. */
function StopTaskDialog(props: {
  open: boolean;
  task: DashboardTask;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onClosed: () => void;
}) {
  const { open, task, onClose } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    setBusy(true);
    setError(null);
    props.onBusy(true);
    try {
      await stopTask(task);
      onClose();
    } catch (err) {
      setError(`Could not stop: ${describeError(err)}`);
    } finally {
      setBusy(false);
      props.onBusy(false);
      refreshDashboardWork();
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
      <DialogPopup className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Stop "{task.agent.title}"?</DialogTitle>
          {task.agent.kind === "workflow" ? <DialogDescription>Resuming does not rerun agents that already finished</DialogDescription> : null}
          {error ? (
            <p role="alert" className="text-destructive-foreground text-sm">
              {error}
            </p>
          ) : null}
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<DialogAction variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void stop()}>
            {busy ? "Stopping" : "Stop"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
