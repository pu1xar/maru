// The terminal mode's rewind screen (DESIGN.md 6o), drawn as the Claude Code CLI 2.1.325 draws its
// Esc Esc screen (MessageSelector, captured in tmux at 120 columns): a "▔" rule and a bold "Rewind"
// in the suggestion color, the messages with a dim line of the edits each turn made, "(current)"
// last, then for the picked message the quoted text, what the focused option does, and the
// numbered options. The CLI's middle dots are two spaces here. Options the CLI leaves out (code
// that cannot go back) stay in the list, dim, with maru's reason. The state is lib/rewind.ts.
import type { RewindTarget } from "@maru/shared";
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";

import type { RewindScreen } from "~/lib/rewind";
import { ageText, choiceEffect, oneLine, restoreFilesText, restoreShown, RESTORE_WARNING, rowMeta } from "~/lib/rewind.logic";

function Stats(props: { insertions: number; deletions: number }) {
  // The CLI's fR: "+N" and "-N", each only when not zero.
  return (
    <>
      {props.insertions > 0 ? <span className="term-rewind-add">{`+${props.insertions}`}</span> : null}
      {props.insertions > 0 && props.deletions > 0 ? " " : null}
      {props.deletions > 0 ? <span className="term-claude">{`-${props.deletions}`}</span> : null}
    </>
  );
}

function Meta(props: { target: RewindTarget }) {
  const meta = rowMeta(props.target);
  if (meta === null) return null;
  const c = props.target.turnChanges!;
  return (
    <div className="term-rewind-row term-dim">
      {"  "}
      {meta.kind === "no-restore" ? `⚠ ${meta.text}` : meta.text}
      {meta.kind === "changes" && (c.insertions > 0 || c.deletions > 0) ? (
        <>
          {" "}
          <Stats insertions={c.insertions} deletions={c.deletions} />
        </>
      ) : null}
    </div>
  );
}

function PickStep(props: { screen: RewindScreen; codeKnown: boolean }) {
  const { screen } = props;
  const s = screen.state;
  const targets = s.list?.targets ?? [];
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-rewind-row="${s.active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [s.active]);
  if (targets.length === 0) return <div className="term-dim">{"Nothing to rewind to yet."}</div>;
  return (
    <>
      <div>{props.codeKnown ? "Restore the code and/or conversation to the point before…" : "Restore the conversation to the point before…"}</div>
      <div className="term-rewind-list" ref={listRef} role="listbox" aria-label="Rewind">
        {[...targets, null].map((t, i) => {
          const on = i === s.active;
          return (
            <div
              key={t?.id ?? "current"}
              role="option"
              aria-selected={on}
              data-rewind-row={i}
              className="term-rewind-item"
              onMouseMove={() => {
                if (!on) screen.setActive(i);
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => screen.pick(i)}
            >
              <div className={`term-rewind-row${on ? " term-accent" : ""}`}>
                {on ? "❯ " : "  "}
                {t ? oneLine(t.text) : <span className="term-italic">(current)</span>}
              </div>
              {t ? <Meta target={t} /> : null}
            </div>
          );
        })}
      </div>
      <div className="term-italic term-dim term-rewind-guide">{"Enter to continue  Esc to cancel"}</div>
    </>
  );
}

function ConfirmStep(props: { screen: RewindScreen; target: RewindTarget }) {
  const { screen, target: t } = props;
  const s = screen.state;
  const focused = s.options[s.option];
  const effect = choiceEffect(t, focused?.value ?? "nevermind", s.options);
  const shown = restoreShown(t, s.preview);
  const codeCanGoBack = s.options.some((o) => (o.value === "both" || o.value === "code") && o.enabled);
  // The CLI's AH: at most 500 characters, then 4 lines.
  const lines = t.text.slice(0, 500).split("\n").slice(0, 4);
  const age = ageText(t.createdAt, Date.now());
  return (
    <>
      <div>{`Confirm you want to restore ${codeCanGoBack ? "" : "the conversation "}to the point before you sent this message:`}</div>
      <div className="term-rewind-gap">
        {lines.map((line, i) => (
          <div key={i} className="term-rewind-quote">
            <span className="term-rewind-bar">{"│ "}</span>
            <span className="term-fg-strong">{line}</span>
          </div>
        ))}
        {age ? (
          <div className="term-rewind-quote">
            <span className="term-rewind-bar">{"│ "}</span>
            <span className="term-dim">{`(${age})`}</span>
          </div>
        ) : null}
      </div>
      <div className="term-rewind-gap term-dim" data-rewind-effect="">
        <div>{effect.goesBack ? "The conversation goes back to before this message." : "The conversation will be unchanged."}</div>
        {effect.code === "restore" && shown ? (
          shown.files.length === 0 ? (
            shown.exact ? (
              <div>{"The code has not changed (nothing will be restored)."}</div>
            ) : (
              // maru: the transcript shows no edit (a subagent's are elsewhere); the restore itself checks the files.
              <div>{"No edits found after this message (the restore checks the files)."}</div>
            )
          ) : shown.exact ? (
            <div>
              {"The code will be restored "}
              <Stats insertions={shown.insertions} deletions={shown.deletions} />
              {` in ${restoreFilesText(shown.files)}.`}
            </div>
          ) : (
            // No process to ask for the dry run (maru): the files edited after the message, without counts.
            <div>{`The code will be restored in ${restoreFilesText(shown.files)}.`}</div>
          )
        ) : effect.code === "unchanged" ? (
          <div>{"The code will be unchanged."}</div>
        ) : null}
      </div>
      <div className="term-rewind-gap" role="listbox" aria-label="Rewind options">
        {s.options.map((o, i) => {
          const on = i === s.option;
          return (
            <div
              key={o.value}
              role="option"
              aria-selected={on}
              aria-disabled={!o.enabled || undefined}
              data-rewind-choice={o.value}
              className="term-choice"
              onMouseMove={() => {
                if (!on) screen.setOption(i);
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => screen.choose(o.value)}
            >
              <span className={on ? "term-accent" : undefined}>{on ? "❯ " : "  "}</span>
              <span className="term-dim">{`${i + 1}. `}</span>
              <span className={!o.enabled ? "term-dim" : on ? "term-accent" : undefined}>{o.cli}</span>
              {s.running === o.value ? <span className="term-dim">{" …"}</span> : null}
              {o.reason ? <span className="term-dim">{`  ${o.reason}`}</span> : null}
            </div>
          );
        })}
      </div>
      {codeCanGoBack ? <div className="term-rewind-gap term-dim">{`⚠ ${RESTORE_WARNING}`}</div> : null}
    </>
  );
}

/**
 * The screen's keys (↑ ↓ Enter Esc, and 1 to 9 on the options): its own root's, and the window's
 * while the focus left it for the page (TerminalComposer routes those here). True when used.
 */
export function rewindKey(screen: RewindScreen, key: string): boolean {
  const s = screen.state;
  if (key === "ArrowDown" || key === "ArrowUp") screen.move(key === "ArrowDown" ? 1 : -1);
  else if (key === "Enter") screen.enter();
  else if (key === "Escape") screen.escape();
  else if (s.step === "confirm" && /^[1-9]$/.test(key)) {
    const o = s.options[Number(key) - 1];
    if (!o) return false;
    screen.setOption(Number(key) - 1);
    screen.choose(o.value);
  } else return false;
  return true;
}

export function TerminalRewind(props: { screen: RewindScreen }) {
  const { screen } = props;
  const s = screen.state;
  const rootRef = useRef<HTMLDivElement>(null);
  // The screen takes the keyboard while it is up, as the CLI's selector does.
  useLayoutEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, [s.step]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!rewindKey(screen, event.key)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  // Code never goes back without a checkpoint row (Codex): the CLI's wording without checkpointing.
  const codeKnown = (s.list?.targets ?? []).some((t) => t.turnChanges !== null);
  return (
    <div ref={rootRef} tabIndex={-1} className="term-rewind" data-rewind-screen={s.step} onKeyDown={onKeyDown}>
      <div className="term-rewind-top" aria-hidden />
      <div className="term-rewind-body">
        <div className="term-accent term-bold">Rewind</div>
        {s.list?.blocked ? <div className="term-warn term-rewind-gap">{s.list.blocked}</div> : null}
        {s.error ? (
          <div role="alert" className="term-err term-pre-wrap term-rewind-gap">
            {s.error}
          </div>
        ) : null}
        <div className="term-rewind-gap">
          {s.loading ? (
            <div className="term-dim">{"Loading…"}</div>
          ) : s.step === "confirm" && s.target ? (
            <ConfirmStep screen={screen} target={s.target} />
          ) : s.list ? (
            <PickStep screen={screen} codeKnown={codeKnown} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
