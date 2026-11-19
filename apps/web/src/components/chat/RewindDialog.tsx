// The chat mode's rewind screen (DESIGN.md 6o): the Claude Code CLI's Esc Esc screen in the app's
// T3 dialog (ui/dialog.tsx, as FolderBrowseDialog.tsx uses it). First the user's messages of the
// current conversation, newest last with "(현재)" under them, then for the picked message the
// CLI's options. ↑ ↓ Enter work as in the CLI; Esc goes back from the options to the list, then
// closes. Options that cannot run stay in the list, off, with the reason under them. On a phone
// the dialog sits at the bottom (the dialog's mobile sheet) and every row is a button.
import type { RewindTarget, SessionRewindList } from "@maru/shared";
import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react";
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";

import type { RewindScreen } from "~/lib/rewind";
import { ageText, choiceEffect, oneLine, restoreFilesText, restoreShown, RESTORE_WARNING, rowMeta } from "~/lib/rewind.logic";
import { cn } from "~/lib/utils";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Spinner } from "../ui/spinner";

/** "+N -M", each part only when not zero (the CLI's fR). */
function Stats(props: { insertions: number; deletions: number }) {
  return (
    <span className="tabular-nums">
      {props.insertions > 0 ? <span className="text-success-foreground">+{props.insertions}</span> : null}
      {props.insertions > 0 && props.deletions > 0 ? " " : null}
      {props.deletions > 0 ? <span className="text-destructive-foreground">-{props.deletions}</span> : null}
    </span>
  );
}

function TargetMeta(props: { target: RewindTarget }) {
  const t = props.target;
  const text = rowMeta(t)?.text ?? null;
  if (text === null) return null;
  if (!t.checkpoint) {
    return (
      <span className="flex items-center gap-1 text-xs text-warning-foreground">
        <TriangleAlertIcon aria-hidden className="size-3 shrink-0" />
        {text}
      </span>
    );
  }
  const c = t.turnChanges!;
  return (
    <span className="truncate text-xs text-muted-foreground">
      {text}
      {c.files.length > 0 ? (
        <>
          {" "}
          <Stats insertions={c.insertions} deletions={c.deletions} />
        </>
      ) : null}
    </span>
  );
}

function PickStep(props: { screen: RewindScreen; list: SessionRewindList }) {
  const { screen, list } = props;
  const listRef = useRef<HTMLUListElement>(null);
  const active = screen.state.active;
  // The focused row stays in view and takes the keyboard (the CLI starts at "(current)").
  useLayoutEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-rewind-row="${active}"]`);
    row?.scrollIntoView({ block: "nearest" });
    row?.focus({ preventScroll: true });
  }, [active]);
  if (list.targets.length === 0) return <p className="px-2 py-3 text-sm text-muted-foreground">No messages to rewind yet</p>;
  return (
    <ul ref={listRef} aria-label="Messages to rewind to" className="flex flex-col">
      {[...list.targets, null].map((t, i) => (
        <li key={t?.id ?? "current"}>
          <button
            type="button"
            data-rewind-row={i}
            aria-current={i === active ? "true" : undefined}
            onClick={() => screen.pick(i)}
            onFocus={() => screen.setActive(i)}
            className={cn(
              "flex w-full min-w-0 cursor-pointer flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              i === active && "bg-accent",
            )}
          >
            {t ? (
              <>
                <span className="w-full truncate">{oneLine(t.text)}</span>
                <TargetMeta target={t} />
              </>
            ) : (
              <span className="text-muted-foreground italic">(current)</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ConfirmStep(props: { screen: RewindScreen; target: RewindTarget }) {
  const { screen, target: t } = props;
  const s = screen.state;
  const focused = s.options[s.option];
  const effect = choiceEffect(t, focused?.value ?? "nevermind", s.options);
  const shown = restoreShown(t, s.preview);
  const optionsRef = useRef<HTMLDivElement>(null);
  const age = ageText(t.createdAt, Date.now());
  useLayoutEffect(() => {
    optionsRef.current?.querySelector<HTMLElement>(`[data-rewind-option="${s.option}"]`)?.focus({ preventScroll: true });
  }, [s.option]);
  const codeCanGoBack = s.options.some((o) => (o.value === "both" || o.value === "code") && o.enabled);
  return (
    <div className="flex flex-col gap-3">
      <blockquote className="border-s-2 border-border ps-3 text-sm">
        <p className="line-clamp-4 whitespace-pre-wrap break-words">{t.text}</p>
        {age ? <p className="text-xs text-muted-foreground">{age}</p> : null}
      </blockquote>
      <div className="flex flex-col gap-0.5 text-xs text-muted-foreground" data-rewind-effect="">
        <span>{effect.goesBack ? "The conversation goes back to before this message was sent" : "The conversation stays as it is"}</span>
        {effect.code === "restore" && shown ? (
          shown.files.length === 0 ? (
            <span>{shown.exact ? "No code changed, nothing to restore" : "No files edited after this message were found in the transcript (checked when you rewind)"}</span>
          ) : shown.exact ? (
            <span>
              The code will be restored: <Stats insertions={shown.insertions} deletions={shown.deletions} /> {restoreFilesText(shown.files)}
            </span>
          ) : (
            // No process to ask for the dry run: the files edited after the message, without counts.
            <span>Files edited after this message will be restored: {restoreFilesText(shown.files)}</span>
          )
        ) : effect.code === "unchanged" ? (
          <span>The code stays as it is</span>
        ) : null}
      </div>
      <div ref={optionsRef} role="listbox" aria-label="Rewind options" className="flex flex-col gap-1">
        {s.options.map((o, i) => (
          <button
            key={o.value}
            type="button"
            role="option"
            aria-selected={i === s.option}
            aria-disabled={!o.enabled || undefined}
            data-rewind-option={i}
            data-rewind-choice={o.value}
            onClick={() => screen.choose(o.value)}
            onFocus={() => screen.setOption(i)}
            className={cn(
              "flex w-full min-w-0 cursor-pointer flex-col items-start rounded-lg border border-transparent px-3 py-2 text-left text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
              i === s.option ? "border-border bg-accent" : "hover:bg-accent/60",
              !o.enabled && "cursor-not-allowed text-muted-foreground",
            )}
          >
            <span className="flex items-center gap-2 font-medium">
              {s.running === o.value ? <Spinner aria-hidden className="size-3.5" /> : null}
              {o.label}
            </span>
            {o.reason ? <span className="text-xs text-muted-foreground">{o.reason}</span> : null}
          </button>
        ))}
      </div>
      {codeCanGoBack ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <TriangleAlertIcon aria-hidden className="mt-px size-3 shrink-0 text-warning-foreground" />
          {RESTORE_WARNING}
        </p>
      ) : null}
    </div>
  );
}

export function RewindDialog(props: { screen: RewindScreen; provider: "claude" | "codex" }) {
  const { screen } = props;
  const s = screen.state;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      screen.move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      screen.enter();
    }
  };
  return (
    <Dialog
      open={s.open}
      onOpenChange={(next, details) => {
        if (next) return;
        // Esc steps back from the options to the list first, as in the CLI.
        if (details.reason === "escape-key") screen.escape();
        else screen.close();
      }}
    >
      <DialogPopup className="sm:max-w-xl" data-rewind-dialog={s.step} onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle>Rewind</DialogTitle>
          <DialogDescription>
            {s.step === "confirm"
              ? "Rewinds to before this message was sent"
              : props.provider === "codex"
                ? "Rewinds the conversation to before this message was sent"
                : "Rewinds code or conversation to before this message was sent"}
          </DialogDescription>
          {s.list?.blocked ? (
            <p role="status" className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning-foreground" data-rewind-blocked="">
              <CircleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
              {s.list.blocked}
            </p>
          ) : null}
          {s.list?.codeNote ? <p className="text-xs text-muted-foreground">{s.list.codeNote}</p> : null}
        </DialogHeader>
        <DialogPanel className="min-h-32 space-y-0 pb-6">
          {s.error ? (
            <p role="alert" className="mb-2 flex items-start gap-1.5 text-sm text-destructive-foreground">
              <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {s.error}
            </p>
          ) : null}
          {s.loading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
              <Spinner aria-hidden className="size-3.5" />
              Loading messages
            </div>
          ) : s.step === "confirm" && s.target ? (
            <ConfirmStep screen={screen} target={s.target} />
          ) : s.list ? (
            <PickStep screen={screen} list={s.list} />
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
