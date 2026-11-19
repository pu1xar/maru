// What a thread tells the server about the user rows it shows (DESIGN.md 4.4): the pending sends of
// a session settle by the client ids of those rows, not by what one client's window holds.
import type { OrchestrationV2ProjectedTurnItem, ThreadLiveEvent } from "@maru/shared";

export interface DeliveryHooks {
  /** These client ids are on rows the thread has sent to its subscribers (or holds, at a subscribe). */
  delivered(sessionKey: string, ids: ReadonlySet<string>): void;
  /** A subscriber joined: the session's transcript beyond the rows the thread holds may show more. */
  subscribed?(sessionKey: string): void;
}

/** The rows of live events: an upserted row, or the rows of a replacement. */
export function rowsOfEvents(events: readonly ThreadLiveEvent[]): OrchestrationV2ProjectedTurnItem[] {
  const out: OrchestrationV2ProjectedTurnItem[] = [];
  for (const ev of events) {
    if (ev.t === "turnItem.upserted") out.push(ev.row);
    else if (ev.t === "turnItems.replaced") out.push(...ev.visibleTurnItems);
  }
  return out;
}
