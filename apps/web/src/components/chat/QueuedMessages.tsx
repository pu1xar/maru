// Messages sent to the session that the model has not taken in yet, at the end of the conversation
// (DESIGN.md 4.4). Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License,
// Copyright (c) 2026 T3 Tools Inc.: components/chat/QueuedRunsControl.tsx (a queued turn sits in the
// timeline's list footer as a right-aligned bubble with a dashed edge, its controls in a line
// under it). Local changes: the bubble keeps the sent message's fill at a lower opacity (user
// request: "약간 불투명하게"), 회수 (back into the composer) in place of edit and of T3's remove
// (user request 2026-11-18: "X 없애"), Send now (Esc) as a control of its own, and the controls as icons left of the bubble (user request
// 2026-11-17: "대기중은 밑이 아니라 텍스트없이 아이콘만 말풍선 왼쪽에"). No state icon: a failed message turns the
// bubble red, its reason in the tooltip; take back is an X, Send now the curved arrow (user request 2026-11-18).
import type { OrchestrationV2ProjectedTurnItem, PendingSend } from "@maru/shared";
import { Undo2Icon, XIcon } from "lucide-react";
import { use } from "react";

import { queuedAttachments, queuedStateLabel } from "~/lib/queuedMessages.logic";
import { BackgroundOfferContext } from "~/lib/backgroundTasks";
import { recallQueued, sendQueuedNow, useRecalling, useSendingNow, useShownQueued } from "~/lib/queuedMessages";
import { useServerDown } from "~/lib/serverDown";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MessageAttachments } from "./MessageAttachments";
import { plural } from "../../lib/plural.ts";

export function QueuedMessages(props: { sessionKey: string; items: readonly OrchestrationV2ProjectedTurnItem[] }) {
  const sends = useShownQueued(props.sessionKey, props.items);
  const recalling = useRecalling();
  // Send now shows where the session offers it (a Claude session this server runs, its turn running).
  const sendNowOffered = use(BackgroundOfferContext).sendNow !== null;
  const sendingNow = useSendingNow(props.sessionKey);
  const serverDown = useServerDown();
  if (sends.length === 0) return null;
  return (
    <div className="messages-timeline-row-frame">
      <section aria-label={plural(sends.length, "queued message")} data-queued-messages="" className="chat-content-lane relative flex flex-col gap-3 pt-2 pb-2">
        <span className="sr-only" aria-live="polite">
          {`Queued ${sends.filter((s) => s.state !== "taken").length}`}
        </span>
        <ol className="flex flex-col items-end gap-3">
          {sends.map((s, i) => (
            <li
              key={s.id}
              aria-label={`Queued message ${i + 1}/${sends.length}, ${queuedStateLabel(s)}`}
              data-queued-state={s.state}
              className="flex w-full items-center justify-end gap-1"
            >
              {/* A message the model took has no controls: its conversation row replaces the bubble. */}
              {s.state === "taken" ? null : (
                <QueuedMeta
                  send={s}
                  busy={recalling.has(s.id)}
                  sendNow={sendNowOffered && s.state === "queued" ? { busy: sendingNow, disabled: serverDown, onSend: () => void sendQueuedNow(props.sessionKey) } : null}
                  onRecall={() => recallQueued(props.sessionKey, [s.id])}
                />
              )}
              {/* Dashed and faded: a message the model has not read yet. A failed one turns red at full strength, its reason on hover. */}
              <div
                className={cn(
                  "min-w-0 max-w-[80%] rounded-2xl border border-dashed p-3 text-sm",
                  s.state !== "taken" && s.recall.enabled && "cursor-pointer",
                  s.state === "failed" ? "border-destructive/60 bg-destructive/20 text-foreground" : "border-foreground/25 bg-message/60 text-message-foreground opacity-70",
                )}
                title={
                  s.state === "taken"
                    ? undefined
                    : [s.state === "failed" ? `${queuedStateLabel(s)}${s.error ? `: ${s.error}` : ""}` : null, s.recall.enabled ? "Click to move back to input" : null].filter(Boolean).join("\n") || undefined
                }
                // A click takes the message back into the input (user request 2026-11-18), as the X does; a
                // drag that selected text in the bubble is a selection, not a click.
                onClick={
                  s.state !== "taken" && s.recall.enabled && !recalling.has(s.id)
                    ? () => {
                        if ((window.getSelection()?.toString() ?? "") !== "") return;
                        recallQueued(props.sessionKey, [s.id]);
                      }
                    : undefined
                }
                data-queued-bubble=""
              >
                {/* Pictures and file rows as on the sent bubble (DESIGN.md 6n). */}
                <MessageAttachments attachments={queuedAttachments(s.attachments)} standalone={s.text.trim() === ""} />
                {s.text ? <p className="whitespace-pre-wrap wrap-anywhere">{s.text}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function QueuedMeta(props: {
  send: PendingSend;
  busy: boolean;
  /** Send now: absent where the session cannot or the message is not in the CLI's queue. */
  sendNow: { busy: boolean; disabled: boolean; onSend: () => void } | null;
  onRecall: () => void;
}) {
  const { send: s } = props;
  // A message the model has taken has nothing left to do here.
  const recallable = s.state !== "taken";
  const enabled = s.recall.enabled && !props.busy;
  return (
    <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
      {props.sendNow ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Send now"
              data-send-now=""
              disabled={props.sendNow.busy || props.sendNow.disabled}
              onClick={props.sendNow.onSend}
            >
              {props.sendNow.busy ? <Spinner size="sm" aria-hidden /> : <Undo2Icon aria-hidden />}
            </Button>
          </TooltipTrigger>
          <TooltipPopup side="top">{props.sendNow.busy ? "Sending now" : "Send now (Esc)"}</TooltipPopup>
        </Tooltip>
      ) : null}
      {recallable ? (
        <Tooltip>
          {/* The span keeps the tooltip, and its reason, on a disabled button. */}
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Button size="icon-xs" variant="ghost-muted" aria-label="Move back to input" disabled={!enabled} onClick={props.onRecall}>
              {props.busy ? <Spinner size="sm" aria-hidden /> : <XIcon aria-hidden />}
            </Button>
          </TooltipTrigger>
          <TooltipPopup side="top">{props.busy ? "Moving back" : s.recall.enabled ? "Move back to the input before the model reads it" : s.recall.reason}</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
