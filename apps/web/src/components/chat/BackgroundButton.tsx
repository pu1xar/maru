// "백그라운드로" on a running Bash row and a foreground Agent card (DESIGN.md 4.5): the one call is
// sent to the background (`thread.background` with its tool_use id). It shows while the CLI holds
// the call in the foreground (the server's `session.foreground`: a Bash command after the CLI's
// 2 s, an Agent call 2 s after it started, as the CLI offers it) and only where the conversation
// offers it (a Claude session this server runs, ThreadView's BackgroundOfferContext). The server's
// reply, a notice or the reason nothing moved, shows in the composer.
import { use } from "react";

import { BackgroundOfferContext, toolUseIdOfItem, useOfferShown } from "~/lib/backgroundTasks";
import { InlineButton } from "../ui/button";

const stopToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

export function BackgroundButton({ itemId, kind }: { itemId: string; kind: "command" | "agent" }) {
  const offer = use(BackgroundOfferContext);
  const toolUseId = toolUseIdOfItem(itemId);
  const shown = useOfferShown(offer, toolUseId, kind);
  const send = offer.send;
  if (!shown || send === null || toolUseId === null) return null;
  return (
    <InlineButton
      tone="muted"
      className="text-xs"
      aria-label="Send to background"
      title={`Send to background (${offer.keyLabel} for all)`}
      data-background-task={toolUseId}
      onClick={(event) => {
        event.stopPropagation();
        send(toolUseId);
      }}
      onKeyDown={stopToggle}
    >
      Background
    </InlineButton>
  );
}
