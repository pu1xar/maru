// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/chat/markdownActionFailure.ts (unchanged).
interface MarkdownActionFailureContext {
  readonly operation: string;
  readonly target?: string;
  readonly format?: "markdown" | "csv";
  readonly language?: string;
  readonly fenceTitle?: string;
  readonly copyTarget?: string;
}

export function reportMarkdownActionFailure(
  context: MarkdownActionFailureContext,
  cause: unknown,
): void {
  console.error("[chat-markdown] action failed", context, cause);
}
