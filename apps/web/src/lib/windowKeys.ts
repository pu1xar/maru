// Keys a conversation hears on the whole window, not only inside itself: ⌥⌘T (chat or terminal),
// ctrl+o (the terminal's transcript view), Esc and the agent panel keys of the terminal input, and
// the timeline's scroll keys while focus is on the page. The single view has one conversation, so
// they are always its. The split view (DESIGN.md 6k) has one per pane and gives them to the
// focused pane alone: ThreadView provides this from its `windowKeys` prop.
import { createContext, use, useRef, type RefObject } from "react";

export const WindowKeysContext = createContext(true);

/** The current value as a ref, for a listener registered once. */
export function useWindowKeysRef(): RefObject<boolean> {
  const live = use(WindowKeysContext);
  const ref = useRef(live);
  ref.current = live;
  return ref;
}
