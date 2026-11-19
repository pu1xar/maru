// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Local change: T3's errors are Effect Schema TaggedErrors and its writer can attach a composer
// context clipboard flavor (@t3tools/shared). Here the errors are plain Error subclasses and the
// writer copies plain text only.
import * as React from "react";
import { useStableCallback } from "./useStableCallback";

export class ClipboardApiUnavailableError extends Error {
  constructor(readonly target: string) {
    super(`Clipboard API is unavailable while copying ${target}.`);
    this.name = "ClipboardApiUnavailableError";
  }
}

export class ClipboardWriteError extends Error {
  constructor(
    readonly target: string,
    override readonly cause: unknown,
  ) {
    super(`Failed to copy ${target} to the clipboard.`);
    this.name = "ClipboardWriteError";
  }
}

function writeTextWithExecCommand(value: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.fontSize = "16px";

  const previouslyFocused = document.activeElement;
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    const restoreFocus = (previouslyFocused as { focus?: unknown } | null)?.focus;
    if (typeof restoreFocus === "function") {
      restoreFocus.call(previouslyFocused);
    }
  }
}

export async function writeTextToClipboard(value: string, target = "text") {
  if (typeof window === "undefined") {
    throw new ClipboardApiUnavailableError(target);
  }

  if (!value) return false;

  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    if (writeTextWithExecCommand(value)) return true;
    throw new ClipboardApiUnavailableError(target);
  }

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (cause) {
    throw new ClipboardWriteError(target, cause);
  }
}

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  target = "text",
  onCopy,
  onError,
}: {
  timeout?: number;
  target?: string;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
} = {}): { copyToClipboard: (value: string, ctx: TContext) => void; isCopied: boolean } {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyToClipboard = useStableCallback((value: string, ctx: TContext): void => {
    void writeTextToClipboard(value, target).then(
      (didCopy) => {
        if (!didCopy) return;
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
        setIsCopied(true);

        onCopy?.(ctx);

        if (timeout !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeout);
        }
      },
      (error) => {
        console.error(error);
        onError?.(error, ctx);
      },
    );
  });

  // Clears the copied-state reset timer on unmount.
  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}
