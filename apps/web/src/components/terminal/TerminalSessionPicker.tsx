// The terminal mode's picker for /model and its kin (DESIGN.md 6m), in the place of the `/` menu,
// drawn as the Claude Code CLI (2.1.325) draws its lists (TerminalPending.tsx's rows): a bold
// title with the current value, `❯ n. label ✔  description` rows moved with ↑ ↓ and picked with
// Enter or a number key, then for /model the effort line, as the CLI's model screen has it (glyph,
// level, "(기본값)", ← → to change; the arrows also take a click or a tap), and the keys. The state
// and keys are lib/sessionPicker.ts, shared with the chat composer's picker.
import type { ProviderId } from "@maru/shared";
import { useLayoutEffect, useRef } from "react";

import type { SessionPicker } from "~/lib/sessionPicker";
import { effortLine } from "~/lib/sessionPicker.logic";

export function terminalPickerOptionId(listId: string, index: number): string {
  return `${listId}-p${index}`;
}

export function TerminalSessionPicker(props: { picker: SessionPicker; provider: ProviderId; listId: string }) {
  const { picker, provider, listId } = props;
  const rows = picker.list?.rows ?? [];
  const top = picker.list !== null && picker.list.title === picker.view?.title;
  const option = picker.kind === "model" && top ? rows[picker.active]?.option : undefined;
  const title = picker.list?.title ?? picker.view?.title ?? "";
  const listRef = useRef<HTMLDivElement>(null);

  // Keeps the highlighted row in view.
  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(terminalPickerOptionId(listId, picker.active))}`)?.scrollIntoView({ block: "nearest" });
  }, [picker.active, listId, rows]);

  return (
    <div className="term-session-picker" data-session-picker={picker.kind ?? ""}>
      <div>
        <b>{title}</b>
        {top && picker.view?.current ? <span className="term-dim">{`  ${picker.view.current}`}</span> : null}
        {top && picker.view?.pending ? <span className="term-dim">{provider === "codex" ? "  (next turn)" : "  (next start)"}</span> : null}
      </div>
      {picker.loading ? (
        <div className="term-dim">{"  Loading"}</div>
      ) : picker.error ? (
        <div role="alert" className="term-err term-pre-wrap">{`  ${picker.error}`}</div>
      ) : rows.length === 0 ? (
        <div className="term-dim">{picker.kind === "mcp" ? "  No MCP servers" : "  Nothing to choose"}</div>
      ) : (
        <div ref={listRef} id={listId} className="term-choices term-picker-rows" role="listbox" aria-label={title}>
          {rows.map((row, i) => {
            const on = i === picker.active;
            return (
              <div
                key={row.id}
                id={terminalPickerOptionId(listId, i)}
                role="option"
                aria-selected={on}
                aria-disabled={row.disabled ? true : undefined}
                title={row.disabled ?? undefined}
                className={row.disabled ? "term-choice term-dim" : "term-choice"}
                onMouseMove={() => {
                  if (!on) picker.highlight(i);
                }}
                // Keeps the focus in the input, as the `/` menu does.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => picker.pick(i)}
              >
                <span className={on ? "term-accent" : undefined}>{on ? "❯ " : "  "}</span>
                <span className="term-dim">{`${i + 1}. `}</span>
                <span className={on ? "term-accent" : undefined}>{row.label}</span>
                {row.current ? <span className="term-ok">{" ✔"}</span> : null}
                {row.next ? <span className="term-dim">{" ›"}</span> : null}
                {row.description ? <span className="term-dim">{`  ${row.description}`}</span> : null}
              </div>
            );
          })}
        </div>
      )}
      {option && !picker.loading && !picker.error ? (
        <div className="term-dim" data-effort-line="">
          {`  ◉ ${effortLine(provider, option, picker.effortStep)}`}
          {picker.effortStep >= 0 ? (
            <>
              {"  "}
              {([[-1, "←", "Lower effort"], [1, "→", "Raise effort"]] as const).map(([delta, glyph, label]) => (
                <span key={delta}>
                  {delta === 1 ? " " : null}
                  <button
                    type="button"
                    className="term-link-row term-picker-arrow"
                    aria-label={label}
                    data-effort-step={delta}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => picker.stepEffort(delta)}
                  >
                    {glyph}
                  </button>
                </span>
              ))}
              {" to change"}
            </>
          ) : null}
        </div>
      ) : null}
      <div className="term-dim">{top ? "  Enter select  Esc close" : "  Enter select  Esc back"}</div>
    </div>
  );
}
