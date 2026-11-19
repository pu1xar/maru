// Find in a thread (DESIGN.md 6u): the pure steps between the server's matches (threadSearch.ts)
// and the timeline. A match names a projected item; the timeline draws messages under their
// message id, so a step resolves the item to the entry the timeline knows, or asks for older rows
// when the client does not hold the item yet.
import type { FindTarget, ThreadSnapshot } from "@maru/shared";

/** The timeline entry that draws item `itemId`: a message's message id, any other item's own id. Null when not held. */
export function entryIdForItem(snapshot: ThreadSnapshot | null, itemId: string): string | null {
  const row = snapshot?.visibleTurnItems.find((r) => r.item.id === itemId);
  if (!row) return null;
  const item = row.item;
  return item.type === "user_message" || item.type === "assistant_message" ? item.messageId : item.id;
}

/**
 * What a step to `target` does now.
 *   show     the client holds the item: the timeline shows entry `entryId`
 *   load     older rows until the item (thread.loadOlder `until`), once no request is in flight
 *   wait     a request is in flight; the step goes on when it ends
 *   missing  the thread's start is held and the item is not there (gone since the search)
 */
export type FindStep =
  | { kind: "show"; entryId: string }
  | { kind: "load"; itemId: string }
  | { kind: "wait" }
  | { kind: "missing" };

export function findStep(snapshot: ThreadSnapshot | null, target: FindTarget, loadingOlder: boolean): FindStep {
  const entryId = entryIdForItem(snapshot, target.itemId);
  if (entryId !== null) return { kind: "show", entryId };
  if (!snapshot || loadingOlder) return { kind: "wait" };
  return snapshot.hasMoreBefore ? { kind: "load", itemId: target.itemId } : { kind: "missing" };
}

/** Each held item's place in the thread, and each message id's (the timeline's rows name messages by it). */
export function itemOrder(snapshot: ThreadSnapshot | null): { byItem: Map<string, number>; byEntry: Map<string, number> } {
  const byItem = new Map<string, number>();
  const byEntry = new Map<string, number>();
  snapshot?.visibleTurnItems.forEach((r, i) => {
    byItem.set(r.item.id, i);
    const item = r.item;
    byEntry.set(item.type === "user_message" || item.type === "assistant_message" ? item.messageId : item.id, i);
  });
  return { byItem, byEntry };
}
