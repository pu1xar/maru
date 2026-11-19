// Alt+Shift+click (Option+Shift+click on a Mac) copies the clicked element's one-line name
// (uiNameCopy.logic.ts, DESIGN.md 7e) so a bug report needs one line instead of the element's HTML.
// The desktop app's context menu "Copy UI name" copies the name of the last right-clicked element.
import { toastManager } from "~/components/ui/toast.tsx";
import { desktopBridge } from "./desktopBridge.ts";
import { PAGE_VERSION } from "./pageVersion.ts";
import { uiNameLine } from "./uiNameCopy.logic.ts";

/** A chord that is not a shortcut elsewhere: Alt and Shift, no Ctrl or Cmd, the main button. */
function isNameClick(e: MouseEvent): boolean {
  return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.button === 0;
}

async function writeClipboard(text: string): Promise<void> {
  const bridge = desktopBridge();
  if (bridge?.copyText) return bridge.copyText(text);
  await navigator.clipboard.writeText(text);
}

function copyLine(line: string | null): void {
  if (!line) {
    toastManager.add({ type: "error", title: "No UI name here" });
    return;
  }
  writeClipboard(line).then(
    () => toastManager.add({ type: "success", title: `Copied: ${line}`, timeout: 4000 }),
    (error) => toastManager.add({ type: "error", title: "Could not copy the UI name", description: error instanceof Error ? error.message : String(error) }),
  );
}

function lineOf(target: EventTarget | null): string | null {
  return target instanceof Element ? uiNameLine(target, PAGE_VERSION) : null;
}

/**
 * Listens on the window in the capture phase: the chord's pointer and mouse events stop before the
 * page sees them (a button does not press, a link does not open, a section does not fold, a drag
 * does not start, the terminal does not move its cursor or select), and the click copies. Returns
 * the unsubscribe.
 */
export function startUiNameCopy(): () => void {
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onPointer = (e: Event) => {
    if (isNameClick(e as MouseEvent)) swallow(e);
  };
  const onClick = (e: MouseEvent) => {
    if (!isNameClick(e)) return;
    swallow(e);
    copyLine(lineOf(e.target));
  };
  // The desktop menu opens after the page's own contextmenu event, so the name is taken here.
  let lastContext: string | null = null;
  const onContext = (e: MouseEvent) => {
    lastContext = lineOf(e.target);
  };
  const types = ["pointerdown", "pointerup", "mousedown", "mouseup"] as const;
  for (const type of types) window.addEventListener(type, onPointer, { capture: true });
  window.addEventListener("click", onClick, { capture: true });
  window.addEventListener("contextmenu", onContext, { capture: true });
  const offMenu = desktopBridge()?.onCopyUiName?.(() => copyLine(lastContext));
  return () => {
    for (const type of types) window.removeEventListener(type, onPointer, { capture: true });
    window.removeEventListener("click", onClick, { capture: true });
    window.removeEventListener("contextmenu", onContext, { capture: true });
    offMenu?.();
  };
}
