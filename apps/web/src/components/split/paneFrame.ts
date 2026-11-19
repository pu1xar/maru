// The split view's pane sizing and the message for a refused split, shared by the split view and
// the drop of a lean window's session (externalDrop.ts).
import type { FrameOptions } from "~/lib/paneLayout";

/**
 * The smallest pane. 360px is the conversation width the right panel keeps (DESIGN.md 6e) and fits
 * the header's controls; 240px tall keeps the header, a few lines and the composer.
 */
export const PANE_FRAME: FrameOptions = { minWidth: 360, minHeight: 240, gap: 1 };
/** Said when a split is refused because the line it would join cannot take another pane at the minimum size. */
export const NO_ROOM = "No room for another pane";
