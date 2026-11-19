// The page's terminal keys (lib/shellKeys.ts, DESIGN.md 6s): the toggle and the new-shell key work on
// every screen, so the listener lives on the page, not in the terminal screen. The tab keys belong to
// the screen (ShellScreen.tsx) because they only mean something while it shows.
import { useEffect } from "react";

import { matchShellKey, terminalKeyStep } from "~/lib/shellKeys";
import { closeTerminal, openTerminal, openTerminalWithNewShell, requestNewShell } from "~/lib/terminalRoute";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function useTerminalKeys(open: boolean): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // AltGr is reported as Ctrl+Alt on Windows: a character typed with it is not a shortcut.
      if (!IS_MAC && event.getModifierState("AltGraph")) return;
      const action = matchShellKey(event, IS_MAC);
      if (!action) return;
      const step = terminalKeyStep(action, open);
      // The tab keys are the screen's own.
      if (step === null || step === "prev" || step === "next") return;
      event.preventDefault();
      event.stopPropagation();
      if (step === "close") closeTerminal();
      else if (step === "open") openTerminal();
      else if (step === "open-new") openTerminalWithNewShell();
      else requestNewShell();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);
}
