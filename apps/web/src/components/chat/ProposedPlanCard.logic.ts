// The collapsed preview of a proposed plan (apps/web/src/proposedPlan.ts in T3 Code): the first lines
// of the plan, then an ellipsis. Pure, so the web card and the Android app's card share it.
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "../../t3-shared/proposedPlanText.ts";

export function buildCollapsedProposedPlanPreviewMarkdown(
  planMarkdown: string,
  options?: { maxLines?: number },
): string {
  const maxLines = options?.maxLines ?? 8;
  const lines = stripDisplayedPlanMarkdown(planMarkdown)
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const previewLines: string[] = [];
  let visibleLineCount = 0;
  let hasMoreContent = false;
  for (const line of lines) {
    const isVisibleLine = line.trim().length > 0;
    if (isVisibleLine && visibleLineCount >= maxLines) {
      hasMoreContent = true;
      break;
    }
    previewLines.push(line);
    if (isVisibleLine) visibleLineCount += 1;
  }
  while (previewLines.length > 0 && previewLines.at(-1)?.trim().length === 0) {
    previewLines.pop();
  }
  if (previewLines.length === 0) {
    return proposedPlanTitle(planMarkdown) ?? "No plan preview";
  }
  if (hasMoreContent) previewLines.push("", "...");
  return previewLines.join("\n");
}
