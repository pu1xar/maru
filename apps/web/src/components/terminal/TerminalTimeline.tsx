// The terminal mode's transcript (DESIGN.md 6i): the thread's timeline entries drawn as the Claude
// Code CLI (2.1.325) draws them, with the live progress line under the last block. The blocks come
// from terminalModel.ts; this file only lays them out. Colors and glyphs are the measured ones
// (index.css `.term-*`).
import type { ThreadSnapshot } from "@maru/shared";
import { Fragment, memo, use, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { BackgroundOfferContext, toolUseIdOfItem, useOfferShown } from "~/lib/backgroundTasks";
import { useIncrementalTimelineEntries } from "~/hooks/useIncrementalTimelineEntries";
import { useSentCount, useShownQueued } from "~/lib/queuedMessages";
import { queuedAttachments, sendBringsEnd } from "~/lib/queuedMessages.logic";
import { useStableCallback } from "~/hooks/useStableCallback";
import { deriveThreadTimelineRunState } from "../../session-logic.ts";
import type { ChatMessage } from "../../types.ts";
import { TermColumnsContext, TerminalMarkdown, TermPath } from "./TerminalMarkdown";
import { TerminalSentAttachments } from "./TerminalAttachments";
import {
  DONE_VERBS,
  PROGRESS_VERBS,
  SPINNER_FRAMES,
  backgroundHintText,
  elapsedLabel,
  hashPick,
  interruptedText,
  moreLinesLabel,
  progressDetail,
  stampTime,
  terminalBlocks,
  type Seg,
  type TermBlock,
  type TermRow,
  type ToolTone,
} from "./terminalModel";

const EMPTY_OPTIMISTIC: ReadonlyArray<ChatMessage> = [];
const FOLLOW_SLACK_PX = 40;
const LOAD_OLDER_PX = 240;

/** Terminal width in cells for a scroll box, measured with a probe in the box's font. */
function useColumns(boxRef: React.RefObject<HTMLElement | null>, probeRef: React.RefObject<HTMLElement | null>, fontKey: string): number {
  const [columns, setColumns] = useState(120);
  // Recounts on every resize of the box and when the font changes.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const probe = probeRef.current;
    if (!box || !probe) return;
    const measure = () => {
      const cell = probe.getBoundingClientRect().width / 10;
      const style = getComputedStyle(box);
      const inner = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (cell > 0 && inner > 0) setColumns(Math.max(20, Math.floor(inner / cell)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [boxRef, probeRef, fontKey]);
  return columns;
}

function toneClass(tone: ToolTone): string {
  return tone === "ok" ? "term-ok" : tone === "error" ? "term-err" : tone === "running" ? "term-dim term-blink" : "term-dim";
}

function Segs({ segs }: { segs: ReadonlyArray<Seg> }) {
  return (
    <>
      {segs.map((s, i) => {
        const text = s.bold ? <b>{s.t}</b> : s.dim ? <span className="term-dim">{s.t}</span> : s.t;
        return s.path ? (
          <TermPath key={i} target={{ path: s.path }}>
            {text}
          </TermPath>
        ) : (
          <Fragment key={i}>{text}</Fragment>
        );
      })}
    </>
  );
}

function Row({ row, cwd }: { row: TermRow; cwd: string | undefined }) {
  switch (row.k) {
    case "text":
      return (
        <div className={`${row.tone === "error" ? "term-err" : row.tone === "dim" ? "term-dim" : ""}${row.indent ? " term-indent2" : ""}`}>
          <Segs segs={row.segs} />
        </div>
      );
    case "code":
      return (
        <div className="term-code">
          <span className="term-lineno">{` ${String(row.n).padStart(row.w)} `}</span>
          {row.text}
        </div>
      );
    case "diff":
      if (row.sign === " ") {
        return (
          <div className="term-code">
            <span className="term-lineno">{` ${String(row.n).padStart(row.w)} `}</span>
            {` ${row.text}`}
          </div>
        );
      }
      return (
        <div className={row.sign === "-" ? "term-diff-del" : "term-diff-add"}>
          <span className="term-diff-mark">{` ${String(row.n).padStart(row.w)} ${row.sign}`}</span>
          <span className="term-code">{row.text}</span>
        </div>
      );
    case "gap":
      return <div className="term-dim">...</div>;
    case "more":
      return (
        <div className="term-dim">
          {moreLinesLabel(row.hidden)}
          {row.hint ? " (ctrl+o to expand)" : ""}
        </div>
      );
    case "md":
      return (
        <div className="term-indent2">
          <TerminalMarkdown text={row.text} cwd={cwd} />
        </div>
      );
    case "section":
      return null;
  }
}

/** Rows under a `⎿`: the first one beside it, the rest under the same 5-cell indent. A section row starts another `⎿`. */
function Rows({ rows, cwd }: { rows: ReadonlyArray<TermRow>; cwd: string | undefined }) {
  const groups: TermRow[][] = [[]];
  for (const row of rows) {
    if (row.k === "section") groups.push([]);
    else groups.at(-1)!.push(row);
  }
  return (
    <>
      {groups
        .filter((g) => g.length > 0)
        .map((group, g) => (
          <div key={g} className="term-result">
            <span className="term-elbow term-dim" aria-hidden>
              {"  \u23bf  "}
            </span>
            <div className="term-result-body">
              {group.map((row, i) => (
                <Row key={i} row={row} cwd={cwd} />
              ))}
            </div>
          </div>
        ))}
    </>
  );
}

/** A row that opens something (a subagent thread, a folded group) by click or by Enter. */
function Clickable({ className, title, onOpen, children }: { className: string; title: string; onOpen: () => void; children: ReactNode }) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={className}
      title={title}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      {children}
    </div>
  );
}

/** `⏺` and the text beside it, wrapped lines kept under the text (2-cell gutter). */
function Bullet({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className="term-bulleted">
      <span className={`term-bullet ${className ?? ""}`} aria-hidden>
        {"⏺"}
      </span>
      <div className="term-bulleted-body">{children}</div>
    </div>
  );
}

/**
 * "(ctrl+b to run in background)" under a running Bash or Agent call while the CLI holds it in the
 * foreground (the CLI's ToolProgressHint, 2.1.325: a Bash call after 2 s, an Agent call 2 s after
 * it started). A click sends that one call; the key sends all.
 */
function BackgroundHint({ itemId, kind }: { itemId: string; kind: "command" | "agent" }) {
  const offer = use(BackgroundOfferContext);
  const toolUseId = toolUseIdOfItem(itemId);
  const shown = useOfferShown(offer, toolUseId, kind);
  const send = offer.send;
  if (!shown || send === null || toolUseId === null) return null;
  return (
    <button type="button" className="term-bg-hint" data-background-task={toolUseId} title="Send only this task to background" onClick={() => send(toolUseId)}>
      {backgroundHintText(offer.keyLabel)}
    </button>
  );
}

const STEP_GLYPH = { completed: "✔", running: "◼", pending: "◻" } as const;

const Block = memo(function Block(props: {
  block: TermBlock;
  cwd: string | undefined;
  onOpenGroup: (id: string) => void;
  onOpenThread: (threadId: string) => void;
  /** Shows the history before the compaction (the CLI starts its screen at it). */
  onShowEarlier?: () => void;
}) {
  const { block, cwd } = props;
  switch (block.kind) {
    case "user":
      return (
        <div className="term-user">
          <span className="term-user-prompt" aria-hidden>
            {"❯ "}
          </span>
          <div className="term-user-text">
            {block.text.trim() ? <TerminalMarkdown text={block.text} cwd={cwd} /> : null}
          </div>
          {block.attachments ? <TerminalSentAttachments attachments={block.attachments} /> : null}
        </div>
      );
    case "assistant":
      return (
        <Bullet className="term-fg-strong">
          <TerminalMarkdown text={block.text} cwd={cwd} streaming={block.streaming} />
        </Bullet>
      );
    case "command-output":
      return (
        <div className="term-result">
          <span className="term-elbow term-dim" aria-hidden>
            {"  ⎿  "}
          </span>
          <div className="term-result-body">
            <TerminalMarkdown text={block.text} cwd={cwd} />
          </div>
        </div>
      );
    case "stamp":
      return (
        <div className="term-stamp term-dim">
          {block.time}
          {block.model ? ` ${block.model}` : ""}
        </div>
      );
    case "tool": {
      // Measured: a long call wraps inside "(…)", its next lines starting under the "(".
      const header = (
        <div className="term-head">
          {block.plainName ? <span className="term-fg">{block.name}</span> : <b>{block.name}</b>}
          <span className="term-args">
            {block.args.length > 0 ? (
              <>
                (<Segs segs={block.args} />)
              </>
            ) : null}
            {block.suffix ? <span className="term-dim"> {block.suffix}</span> : null}
          </span>
        </div>
      );
      return (
        <div className="term-block-tool">
          <Bullet className={toneClass(block.tone)}>
            {block.childThreadId ? (
              <Clickable className="term-link-row" title="Open this subagent conversation" onOpen={() => props.onOpenThread(block.childThreadId!)}>
                {header}
              </Clickable>
            ) : (
              header
            )}
          </Bullet>
          <Rows rows={block.rows} cwd={cwd} />
          {block.background ? <BackgroundHint itemId={block.background.itemId} kind={block.background.kind} /> : null}
        </div>
      );
    }
    case "group":
      return (
        <>
          <Clickable className="term-group" title="Expand to see each call" onOpen={() => props.onOpenGroup(block.id)}>
            {block.parts.map((p, i) => (
              <Fragment key={p.key}>
                {i > 0 ? ", " : ""}
                {p.verb} {p.count === null ? p.noun : (
                  <>
                    <b>{p.count}</b> {p.noun}
                  </>
                )}
              </Fragment>
            ))}
            {block.active ? "…" : ""}
          </Clickable>
          {block.rows ? <Rows rows={block.rows} cwd={cwd} /> : null}
        </>
      );
    case "thinking":
      return (
        <div className="term-thinking">
          <div>{"✻ Thinking…"}</div>
          {block.text ? <div className="term-indent2 term-pre-wrap">{block.text}</div> : null}
        </div>
      );
    case "compaction":
      return (
        <div className={block.state === "failed" ? "term-err" : "term-dim"}>
          <div>
            {block.state === "running"
              ? "✻ Compacting conversation…"
              : block.state === "failed"
                ? `✻ Compaction failed${block.failure ? `: ${block.failure}` : ""}`
                : "✻ Conversation compacted (ctrl+o for the summary)"}
            {props.onShowEarlier && block.state === "done" ? (
              <>
                {"  "}
                <button type="button" className="term-link-row" onClick={props.onShowEarlier}>
                  [show earlier history]
                </button>
              </>
            ) : null}
          </div>
          {block.summary ? (
            <div className="term-fg">
              <Bullet className="term-fg-strong">Compact summary</Bullet>
              <Rows rows={block.summary.split("\n").map((t) => ({ k: "text" as const, segs: [{ t }] }))} cwd={cwd} />
            </div>
          ) : null}
        </div>
      );
    case "notice":
      return (
        <Bullet className={block.level === "error" ? "term-err" : block.level === "warning" ? "term-warn" : "term-dim"}>
          <span className={`term-pre-wrap ${block.level === "error" ? "term-err" : block.level === "warning" ? "term-warn" : "term-dim"}`}>{block.text}</span>
        </Bullet>
      );
    case "interrupted":
      // The CLI joins the two parts with a middle dot; two spaces stand in for it.
      return <Rows rows={[{ k: "text", segs: [{ t: interruptedText(block.agent) }], tone: "dim" }]} cwd={cwd} />;
    case "error":
      return (
        <Bullet className="term-warn">
          <span className="term-warn term-pre-wrap">{block.text}</span>
        </Bullet>
      );
    case "notification": {
      // The CLI separates the time with a middle dot; two spaces here.
      const body = (
        <>
          {block.text}
          {block.suffix ? <span className="term-dim">{`  ${block.suffix}`}</span> : null}
        </>
      );
      return (
        <Bullet className={toneClass(block.tone)}>
          {block.childThreadId ? (
            <Clickable className="term-link-row" title="Open this subagent conversation" onOpen={() => props.onOpenThread(block.childThreadId!)}>
              {body}
            </Clickable>
          ) : (
            body
          )}
        </Bullet>
      );
    }
    case "todo":
      return (
        <div>
          <Bullet className="term-ok">
            <b>Update Todos</b>
          </Bullet>
          <div className="term-result">
            <span className="term-elbow term-dim" aria-hidden>
              {"  ⎿  "}
            </span>
            <div className="term-result-body">
              {block.steps.map((step) => (
                <div key={step.id} className={step.status === "completed" ? "term-dim term-strike" : step.status === "running" ? "term-bold" : undefined}>
                  {STEP_GLYPH[step.status]} {step.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    case "plan":
      // Bundle (ExitPlanMode result): the plan-colored bullet, then the plan under `⎿`; a
      // rejected plan sits in a rounded plan-colored box under "User rejected Claude's plan:".
      if (block.state === "rejected") {
        return (
          <div className="term-result">
            <span className="term-elbow term-dim" aria-hidden>
              {"  ⎿  "}
            </span>
            <div className="term-result-body">
              <div className="term-dim">{"User rejected Claude's plan:"}</div>
              <div className="term-plan-box">
                <TerminalMarkdown text={block.markdown} cwd={cwd} />
              </div>
            </div>
          </div>
        );
      }
      return (
        <div>
          <Bullet className="term-plan">{block.state === "exited" ? "Exited plan mode" : "User approved Claude's plan"}</Bullet>
          {block.state === "approved" ? (
            <div className="term-result">
              <span className="term-elbow term-dim" aria-hidden>
                {"  ⎿  "}
              </span>
              <div className="term-result-body">
                {block.path ? (
                  <div className="term-dim">
                    {"Plan saved to: "}
                    <TermPath target={{ path: block.path }}>{block.path}</TermPath>
                  </div>
                ) : null}
                <TerminalMarkdown text={block.markdown} cwd={cwd} />
              </div>
            </div>
          ) : null}
        </div>
      );
    case "plan-mode":
      return block.entered ? (
        <div>
          <Bullet className="term-plan">Entered plan mode</Bullet>
          <div className="term-indent2 term-dim">{`${block.agent} is now exploring and designing an implementation approach.`}</div>
        </div>
      ) : (
        <Bullet className="term-fg">User declined to enter plan mode</Bullet>
      );
    case "answers":
      return (
        <div>
          <Bullet className="term-ok">{"User answered Claude's questions:"}</Bullet>
          <Rows rows={block.pairs.map((p) => ({ k: "text" as const, segs: [{ t: `${p.question} → ` }, { t: p.answer, bold: true }] }))} cwd={cwd} />
        </div>
      );
  }
});

/**
 * The progress line's "↓ N tokens": this run's output so far when the server counts it
 * (`tokenUsage.runOutputTokens`, DESIGN.md 6i; it grows per response), else the last response's.
 */
function runOutputTokens(snapshot: ThreadSnapshot): number | null {
  const usage = snapshot.tokenUsage as (ThreadSnapshot["tokenUsage"] & { runOutputTokens?: unknown }) | null;
  if (typeof usage?.runOutputTokens === "number") return usage.runOutputTokens;
  return usage?.lastOutputTokens ?? null;
}

/** `✻ Verb… (12s  ↓ 1.2k tokens)` while a turn runs; `✻ Worked for 11s  done 1:53 AM` after one ended here. */
function ProgressLine(props: { runKey: string; startedAt: string | null; outputTokens: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  const [frame, setFrame] = useState(0);
  // Advances the spinner frame and the clock.
  useEffect(() => {
    const t = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
      setNow(Date.now());
    }, 160);
    return () => clearInterval(t);
  }, []);
  const started = props.startedAt ? Date.parse(props.startedAt) : NaN;
  const elapsed = Number.isFinite(started) ? now - started : 0;
  return (
    <div className="term-progress" role="status">
      <span className="term-claude">{SPINNER_FRAMES[frame]}</span>{" "}
      <span className="term-claude-shimmer">{hashPick(PROGRESS_VERBS, props.runKey)}{"…"}</span>{" "}
      <span className="term-dim">{progressDetail(elapsed, props.outputTokens)}</span>
    </div>
  );
}

export function TerminalTimeline(props: {
  snapshot: ThreadSnapshot;
  cwd: string | undefined;
  /** Who the interrupt line names ("What should Codex do instead?"). */
  agentName: string;
  verbose: boolean;
  fontKey: string;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onOpenChildThread: (threadId: string) => void;
}) {
  const { snapshot, cwd, verbose } = props;
  const entries = useIncrementalTimelineEntries(snapshot.threadId, {
    visibleTurnItems: snapshot.visibleTurnItems,
    optimisticMessages: EMPTY_OPTIMISTIC,
  });
  const run = deriveThreadTimelineRunState(snapshot);
  // The messages that wait (DESIGN.md 4.4), drawn as the CLI draws its queue.
  const queued = useShownQueued(snapshot.threadId, snapshot.visibleTurnItems);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const columns = useColumns(boxRef, probeRef, props.fontKey);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [beforeCompaction, setBeforeCompaction] = useState(false);
  // Plan entries carry no status; the items do (an answered or a rejected ExitPlanMode).
  const items = useMemo(
    () => new Map(snapshot.visibleTurnItems.filter((row) => row.item.type === "proposed_plan").map((row) => [row.item.id, row.item])),
    [snapshot.visibleTurnItems],
  );
  const blocks = useMemo(
    () =>
      terminalBlocks(entries, {
        cwd,
        columns,
        verbose,
        openGroups,
        subagents: snapshot.subagents,
        model: snapshot.state.model ?? null,
        beforeCompaction,
        agentName: props.agentName,
        items,
      }),
    [entries, cwd, columns, verbose, openGroups, snapshot.subagents, snapshot.state.model, beforeCompaction, props.agentName, items],
  );

  // The run that ended while this view was open leaves "✻ Worked for Ns" under the last block.
  const [seenRunning, setSeenRunning] = useState<string | null>(null);
  const latest = run.latestRun;
  // Remembers the run seen running, so its end can be shown.
  useEffect(() => {
    if (run.isWorking && latest) setSeenRunning(latest.runId);
  }, [run.isWorking, latest]);
  const finished =
    !run.isWorking && latest && seenRunning === latest.runId && latest.startedAt && latest.completedAt ? latest : null;

  // Follow the bottom while the reader is there; keep the place when older history is prepended.
  const atBottom = useRef(true);
  const firstId = blocks[0]?.id;
  const prevFirst = useRef(firstId);
  const prevHeight = useRef(0);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (prevFirst.current !== firstId && prevHeight.current > 0 && !atBottom.current) {
      box.scrollTop += box.scrollHeight - prevHeight.current;
    } else if (atBottom.current) {
      box.scrollTop = box.scrollHeight;
    }
    prevFirst.current = firstId;
    prevHeight.current = box.scrollHeight;
  });
  // A message sent from this page brings the end into view, also from a scrolled-up reader (the
  // CLI's screen shows the line you just entered): follow resumes and the next layout lands there.
  const sentCount = useSentCount(snapshot.threadId);
  const seenSent = useRef(sentCount);
  useLayoutEffect(() => {
    const before = seenSent.current;
    seenSent.current = sentCount;
    if (!sendBringsEnd(before, sentCount)) return;
    atBottom.current = true;
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [sentCount]);
  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight <= FOLLOW_SLACK_PX;
    prevHeight.current = box.scrollHeight;
    if (box.scrollTop < LOAD_OLDER_PX && snapshot.hasMoreBefore && !props.loadingOlder) props.onLoadOlder();
  };
  // The thread opens with its newest rows only (DESIGN.md 6r). While they do not fill the screen,
  // or the reader is still at the top after a page that drew nothing above (no scroll event comes
  // then), the older rows are asked for here, once per change of the rows (a request that brought
  // none, a failure, does not repeat). A screen that starts at a compaction stops there as the
  // CLI's does; [show earlier history] opens what is before it.
  const askedAtRef = useRef<unknown>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !snapshot.hasMoreBefore || props.loadingOlder || askedAtRef.current === snapshot.visibleTurnItems) return;
    if (!beforeCompaction && blocks[0]?.kind === "compaction") return;
    if (box.scrollTop >= LOAD_OLDER_PX) return;
    askedAtRef.current = snapshot.visibleTurnItems;
    props.onLoadOlder();
  });

  // Stable, so a streamed delta redraws only the blocks that changed (Block is memoized).
  const openGroup = useStableCallback((id: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    }),
  );
  const openThread = useStableCallback((threadId: string) => props.onOpenChildThread(threadId));
  const showEarlier = useStableCallback(() => setBeforeCompaction(true));

  return (
    <div ref={boxRef} className="term-scroll" onScroll={onScroll} data-terminal-columns={columns}>
      <span ref={probeRef} className="term-probe" aria-hidden>
        0000000000
      </span>
      <TermColumnsContext value={columns}>
      <div className="term-screen">
        {snapshot.hasMoreBefore || props.loadingOlder ? (
          <div className="term-dim term-history">
            {props.loadingOlder ? (
              "Loading earlier history"
            ) : (
              <button type="button" className="term-link-row" onClick={props.onLoadOlder}>
                Load earlier history
              </button>
            )}
          </div>
        ) : null}
        {blocks.length === 0 && !run.isWorking ? <div className="term-dim">The conversation is empty</div> : null}
        {blocks.map((block) => (
          <div key={block.id} className="term-block" data-term-block={block.kind}>
            <Block
              block={block}
              cwd={cwd}
              onOpenGroup={openGroup}
              onOpenThread={openThread}
              {...(block.kind === "compaction" && !beforeCompaction ? { onShowEarlier: showEarlier } : {})}
            />
          </div>
        ))}
        {queued.map((q) => (
          // Measured on 2.1.325: a queued message is a user line (237 background) in dim (246) text,
          // under the last block and over the progress line; it goes when the model takes it.
          <div key={`queued:${q.id}`} className="term-block" data-term-block="queued" data-queued-state={q.state}>
            <div className="term-user term-user-queued">
              <span className="term-user-prompt" aria-hidden>
                {"❯ "}
              </span>
              <div className="term-user-text term-pre-wrap">{q.text}</div>
            </div>
            <TerminalSentAttachments attachments={queuedAttachments(q.attachments)} />
            {q.state === "failed" ? <div className="term-err term-pre-wrap">{`  ${q.error ?? "Not sent"}`}</div> : null}
          </div>
        ))}
        {run.isWorking ? (
          <div className="term-block">
            <ProgressLine
              runKey={latest?.runId ?? snapshot.threadId}
              startedAt={run.activeTurnStartedAt}
              outputTokens={runOutputTokens(snapshot)}
            />
          </div>
        ) : finished ? (
          <div className="term-block term-dim">
            {`✻ ${hashPick(DONE_VERBS, finished.runId)} for ${elapsedLabel(Date.parse(finished.completedAt!) - Date.parse(finished.startedAt!))}  done ${stampTime(finished.completedAt!).replace(/^0/, "")}`}
          </div>
        ) : null}
      </div>
      </TermColumnsContext>
    </div>
  );
}
