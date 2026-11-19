// The terminal mode's blocks (the web's TerminalTimeline.tsx Block and Rows): each block of
// terminalModel.ts drawn with the CLI's glyphs and colors. A subagent call and a collapsed group
// are tappable rows where the web has a click.
import { memo, useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { OrchestrationV2PlanStep } from "@maru/shared";
import {
  interruptedText,
  moreLinesLabel,
  type Seg,
  type TermBlock,
  type TermRow,
  type ToolTone,
} from "../../../../web/src/components/terminal/terminalModel.ts";
import type { SentAttachment } from "../../../../web/src/lib/composerAttachments.logic.ts";
import { terminalAttachmentLabel } from "../../../../web/src/lib/composerAttachments.logic.ts";
import { TerminalMarkdown } from "./TerminalMarkdown.tsx";
import { Cells, Prefixed, R, Selectable, T, TextRole, useTerm, type Role } from "./term.tsx";

const STEP_GLYPH: Record<OrchestrationV2PlanStep["status"], string> = { completed: "✔", running: "◼", pending: "◻" };

/** A running call blinks (index.css term-blink: opacity 1 to 0.25, two steps a second). */
function useBlink(on: boolean): boolean {
  const [low, setLow] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setLow((v) => !v), 500);
    return () => clearInterval(t);
  }, [on]);
  return on && low;
}

function toneRole(tone: ToolTone): Role {
  return tone === "ok" ? "ok" : tone === "error" ? "err" : "dim";
}

function Segs({ segs }: { segs: ReadonlyArray<Seg> }) {
  return (
    <>
      {segs.map((s, i) => (
        <R key={i} bold={s.bold} c={s.dim ? "dim" : undefined}>
          {s.t}
        </R>
      ))}
    </>
  );
}

function Row({ row, columns }: { row: TermRow; columns: number }) {
  const { tokens, cellW } = useTerm();
  switch (row.k) {
    case "text":
      return (
        <T c={row.tone === "error" ? "err" : row.tone === "dim" ? "dim" : undefined} style={row.indent ? { paddingLeft: 2 * cellW } : undefined}>
          <Segs segs={row.segs} />
        </T>
      );
    case "code":
      return (
        <T c="code">
          <R c="codeFaint">{` ${String(row.n).padStart(row.w)} `}</R>
          {row.text}
        </T>
      );
    case "diff":
      if (row.sign === " ") {
        return (
          <T c="code">
            <R c="codeFaint">{` ${String(row.n).padStart(row.w)} `}</R>
            {` ${row.text}`}
          </T>
        );
      }
      return (
        <View style={{ backgroundColor: row.sign === "-" ? tokens.delBg : tokens.addBg }}>
          <T c="code">
            <R c={row.sign === "-" ? "err" : "ok"} style={{ color: row.sign === "-" ? tokens.delFg : tokens.addFg }}>{` ${String(row.n).padStart(row.w)} ${row.sign}`}</R>
            {row.text}
          </T>
        </View>
      );
    case "gap":
      return <T c="dim">...</T>;
    case "more":
      return (
        <T c="dim">
          {moreLinesLabel(row.hidden)}
          {row.hint ? " ([verbose] to expand)" : ""}
        </T>
      );
    case "md":
      return (
        <View style={{ paddingLeft: 2 * cellW }}>
          <TerminalMarkdown text={row.text} columns={columns} />
        </View>
      );
    case "section":
      return null;
  }
}

/** Rows under a `⎿`: the first one beside it, the rest under the same 5-cell indent. A section row starts another `⎿`. */
function Rows({ rows, columns }: { rows: ReadonlyArray<TermRow>; columns: number }) {
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
          <Elbow key={g}>
            {group.map((row, i) => (
              <Row key={i} row={row} columns={columns} />
            ))}
          </Elbow>
        ))}
    </>
  );
}

/** `  ⎿  ` and the body beside it (5 cells). */
function Elbow({ children }: { children: ReactNode }) {
  return (
    <View style={styles.row}>
      <Cells n={5}>
        <T c="dim">{"  ⎿  "}</T>
      </Cells>
      <View style={styles.fill}>{children}</View>
    </View>
  );
}

/** A row that opens something (a subagent thread, a folded group) by a tap. */
function Tappable({ label, onOpen, children }: { label: string; onOpen: () => void; children: ReactNode }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onOpen} hitSlop={{ top: 10, bottom: 10 }}>
      {/* A tap row is not selectable text: its tap is the action. */}
      <Selectable on={false}>{children}</Selectable>
    </Pressable>
  );
}

function SentAttachments({ attachments }: { attachments: readonly SentAttachment[] }) {
  if (attachments.length === 0) return null;
  let images = 0;
  let files = 0;
  return (
    <View style={{ paddingLeft: 0 }}>
      {attachments.map((a) => {
        const label = a.kind === "image" ? terminalAttachmentLabel("image", ++images, a.name) : terminalAttachmentLabel("file", ++files, a.name);
        return (
          <T key={a.key} c="dim">
            {`⎿  ${a.kind === "image" ? `${label} ${a.name}` : label}`}
          </T>
        );
      })}
    </View>
  );
}

export interface BlockProps {
  block: TermBlock;
  columns: number;
  onOpenGroup: (id: string) => void;
  onOpenThread: (threadId: string) => void;
  /** Shows the history before the compaction (the CLI starts its screen at it). */
  onShowEarlier?: (() => void) | undefined;
  /** The long press on a user line: the message menu (copy, rewind, fork). Null where there is none. */
  onUserMenu?: ((text: string) => void) | null | undefined;
}

export const Block = memo(function Block(props: BlockProps) {
  const { block, columns } = props;
  const { tokens, cellW } = useTerm();
  const blink = useBlink(block.kind === "tool" && block.tone === "running");
  switch (block.kind) {
    case "user":
      return (
        <View>
          <Pressable
            delayLongPress={350}
            onLongPress={props.onUserMenu ? () => props.onUserMenu?.(block.text) : undefined}
            accessibilityLabel="Your message"
            style={[styles.row, { backgroundColor: tokens.userBg, paddingRight: cellW }]}
          >
            <Cells n={2}>
              <T c="dim">{"❯ "}</T>
            </Cells>
            <View style={styles.fill}>
              {block.text.trim() ? (
                // The user line's text is the strong color.
                <TextRole role="strong">
                  <TerminalMarkdown text={block.text} columns={columns} />
                </TextRole>
              ) : null}
            </View>
          </Pressable>
          {block.attachments ? <SentAttachments attachments={block.attachments} /> : null}
        </View>
      );
    case "assistant":
      return (
        <Prefixed n={2} mark="⏺ " role="strong">
          <TerminalMarkdown text={block.text} columns={columns} />
        </Prefixed>
      );
    case "command-output":
      return (
        <Elbow>
          <TerminalMarkdown text={block.text} columns={columns} />
        </Elbow>
      );
    case "stamp":
      return (
        <View style={{ paddingRight: 8 * cellW }}>
          <T c="dim" style={{ textAlign: "right" }}>
            {block.time}
            {block.model ? ` ${block.model}` : ""}
          </T>
        </View>
      );
    case "tool": {
      // Measured: a long call wraps inside "(…)", its next lines starting under the "(".
      const header = (
        <T>
          {block.plainName ? <R>{block.name}</R> : <R bold>{block.name}</R>}
          {block.args.length > 0 ? (
            <>
              {"("}
              <Segs segs={block.args} />
              {")"}
            </>
          ) : null}
          {block.suffix ? <R c="dim">{` ${block.suffix}`}</R> : null}
        </T>
      );
      return (
        <View>
          <View style={[styles.row, blink ? { opacity: 0.25 } : null]}>
            <Cells n={2}>
              <T c={toneRole(block.tone)}>{"⏺ "}</T>
            </Cells>
            <View style={styles.fill}>
              {block.childThreadId ? (
                <Tappable label="Open this subagent conversation" onOpen={() => props.onOpenThread(block.childThreadId!)}>
                  {header}
                </Tappable>
              ) : (
                header
              )}
            </View>
          </View>
          <Rows rows={block.rows} columns={columns} />
        </View>
      );
    }
    case "group":
      return (
        <>
          <Tappable label="Expand to see each call" onOpen={() => props.onOpenGroup(block.id)}>
            <View style={{ paddingLeft: 2 * cellW }}>
              <T c="dim">
                {block.parts.map((p, i) => (
                  <R key={p.key}>
                    {i > 0 ? ", " : ""}
                    {p.verb}{" "}
                    {p.count === null ? p.noun : (
                      <>
                        <R bold>{String(p.count)}</R>
                        {` ${p.noun}`}
                      </>
                    )}
                  </R>
                ))}
                {block.active ? "…" : ""}
              </T>
            </View>
          </Tappable>
          {block.rows ? <Rows rows={block.rows} columns={columns} /> : null}
        </>
      );
    case "thinking":
      return (
        <View>
          <T c="dim" italic>
            {"✻ Thinking…"}
          </T>
          {block.text ? (
            <T c="dim" italic style={{ paddingLeft: 2 * cellW }}>
              {block.text}
            </T>
          ) : null}
        </View>
      );
    case "compaction": {
      const role: Role = block.state === "failed" ? "err" : "dim";
      return (
        <View>
          <T c={role}>
            {block.state === "running"
              ? "✻ Compacting conversation…"
              : block.state === "failed"
                ? `✻ Compaction failed${block.failure ? `: ${block.failure}` : ""}`
                : "✻ Conversation compacted ([verbose] for the summary)"}
            {props.onShowEarlier && block.state === "done" ? (
              <>
                {"  "}
                <R onPress={props.onShowEarlier} underline>
                  [show earlier history]
                </R>
              </>
            ) : null}
          </T>
          {block.summary ? (
            <View>
              <Prefixed n={2} mark="⏺ " role="strong">
                <T c="strong">Compact summary</T>
              </Prefixed>
              <Rows rows={block.summary.split("\n").map((t) => ({ k: "text" as const, segs: [{ t }] }))} columns={columns} />
            </View>
          ) : null}
        </View>
      );
    }
    case "notice": {
      const role: Role = block.level === "error" ? "err" : block.level === "warning" ? "warn" : "dim";
      return (
        <Prefixed n={2} mark="⏺ " role={role}>
          <T c={role}>{block.text}</T>
        </Prefixed>
      );
    }
    case "interrupted":
      return <Rows rows={[{ k: "text", segs: [{ t: interruptedText(block.agent) }], tone: "dim" }]} columns={columns} />;
    case "error":
      return (
        <Prefixed n={2} mark="⏺ " role="warn">
          <T c="warn">{block.text}</T>
        </Prefixed>
      );
    case "notification": {
      const body = (
        <T>
          {block.text}
          {block.suffix ? <R c="dim">{`  ${block.suffix}`}</R> : null}
        </T>
      );
      return (
        <Prefixed n={2} mark="⏺ " role={toneRole(block.tone)}>
          {block.childThreadId ? (
            <Tappable label="Open this subagent conversation" onOpen={() => props.onOpenThread(block.childThreadId!)}>
              {body}
            </Tappable>
          ) : (
            body
          )}
        </Prefixed>
      );
    }
    case "todo":
      return (
        <View>
          <Prefixed n={2} mark="⏺ " role="ok">
            <T bold>Update Todos</T>
          </Prefixed>
          <Elbow>
            {block.steps.map((step) => (
              <T key={step.id} c={step.status === "completed" ? "dim" : undefined} bold={step.status === "running"} strike={step.status === "completed"}>
                {`${STEP_GLYPH[step.status]} ${step.text}`}
              </T>
            ))}
          </Elbow>
        </View>
      );
    case "plan":
      // Bundle (ExitPlanMode result): the plan-colored bullet, then the plan under `⎿`; a rejected plan sits in a rounded plan-colored box.
      if (block.state === "rejected") {
        return (
          <Elbow>
            <T c="dim">{"User rejected Claude's plan:"}</T>
            <View style={{ borderWidth: 1, borderColor: tokens.plan, borderRadius: 0.5 * cellW, paddingHorizontal: cellW - 1 }}>
              <TerminalMarkdown text={block.markdown} columns={columns} />
            </View>
          </Elbow>
        );
      }
      return (
        <View>
          <Prefixed n={2} mark="⏺ " role="plan">
            <T c="plan">{block.state === "exited" ? "Exited plan mode" : "User approved Claude's plan"}</T>
          </Prefixed>
          {block.state === "approved" ? (
            <Elbow>
              {block.path ? <T c="dim">{`Plan saved to: ${block.path}`}</T> : null}
              <TerminalMarkdown text={block.markdown} columns={columns} />
            </Elbow>
          ) : null}
        </View>
      );
    case "plan-mode":
      return block.entered ? (
        <View>
          <Prefixed n={2} mark="⏺ " role="plan">
            <T c="plan">Entered plan mode</T>
          </Prefixed>
          <T c="dim" style={{ paddingLeft: 2 * cellW }}>{`${block.agent} is now exploring and designing an implementation approach.`}</T>
        </View>
      ) : (
        <Prefixed n={2} mark="⏺ " role="fg">
          <T>User declined to enter plan mode</T>
        </Prefixed>
      );
    case "answers":
      return (
        <View>
          <Prefixed n={2} mark="⏺ " role="ok">
            <T>{"User answered Claude's questions:"}</T>
          </Prefixed>
          <Rows
            rows={block.pairs.map((p) => ({ k: "text" as const, segs: [{ t: `${p.question} → ` }, { t: p.answer, bold: true }] }))}
            columns={columns}
          />
        </View>
      );
  }
});

const styles = StyleSheet.create({
  row: { flexDirection: "row" },
  fill: { flex: 1, minWidth: 0 },
});
