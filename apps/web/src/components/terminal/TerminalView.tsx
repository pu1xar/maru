// The terminal mode's body (DESIGN.md 6i): transcript, progress line and input for one thread, in the
// terminal font and colors. ThreadView loads it lazily (it pulls in the markdown pipeline) and
// swaps it with the chat timeline and composer; both read the same thread store (useThread.ts), so
// switching keeps the run, the pending asks and the scroll-independent state.
import type { SessionSummary, ThreadSnapshot } from "@maru/shared";
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { userHistory } from "~/lib/composerHistory.logic";
import { inShellTerminal } from "~/lib/shellKeys";
import { useTerminalThemeStyle } from "~/lib/terminalTheme";
import { useDisplayPrefs } from "~/lib/displayPrefs";
import { terminalRootStyle, useTerminalPrefs } from "~/lib/viewMode";
import { useWindowKeysRef } from "~/lib/windowKeys";
import { TerminalComposer } from "./TerminalComposer";
import { TerminalTimeline } from "./TerminalTimeline";

export default function TerminalView(props: {
  session: SessionSummary;
  isSubagent: boolean;
  snapshot: ThreadSnapshot | null;
  cwd: string | undefined;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onOpenChildThread: (threadId: string) => void;
  /** The agent panel's Enter: the session's own thread, or one agent's, one level under it. */
  onShowThread: (threadId: string, title: string | null) => void;
  /** Shown in place of the transcript before the first snapshot (loading or an error). */
  placeholder: React.ReactNode;
}) {
  const prefs = useTerminalPrefs();
  const { monoFont } = useDisplayPrefs();
  // ctrl+o: the CLI's transcript view for the whole screen.
  const [verbose, setVerbose] = useState(false);
  const toggleVerbose = () => setVerbose((v) => !v);
  // ctrl+o outside the input too, as in the CLI (the input handles its own). In the split view
  // only the focused pane's view hears it (lib/windowKeys.ts).
  const windowKeys = useWindowKeysRef();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!windowKeys.current || event.defaultPrevented || event.repeat) return;
      if (event.key !== "o" || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      // ctrl+o typed in a shell terminal is the shell's (lib/shellKeys.ts).
      if (inShellTerminal(event.target)) return;
      event.preventDefault();
      setVerbose((v) => !v);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [windowKeys]);
  const history = useMemo(() => userHistory(props.snapshot), [props.snapshot]);
  // Font, size and the iTerm cell they make (row height, cell width), and the color theme, from Settings.
  const themeStyle = useTerminalThemeStyle();
  const style = { ...terminalRootStyle({ font: monoFont, fontSize: prefs.fontSize }), ...themeStyle } as CSSProperties;

  return (
    // dark: the terminal keeps the dark tokens in the light theme too (index.css .dark, DESIGN.md 6i).
    <div className="term-root dark" style={style} data-verbose={verbose || undefined}>
      {props.snapshot ? (
        <TerminalTimeline
          snapshot={props.snapshot}
          cwd={props.cwd}
          agentName={props.session.provider === "codex" ? "Codex" : "Claude"}
          verbose={verbose}
          fontKey={`${monoFont}:${prefs.fontSize}`}
          loadingOlder={props.loadingOlder}
          onLoadOlder={props.onLoadOlder}
          onOpenChildThread={props.onOpenChildThread}
        />
      ) : (
        <div className="term-scroll">{props.placeholder}</div>
      )}
      {verbose ? (
        <div className="term-verbose-bar term-dim">
          {"Showing detailed transcript  ctrl+o to toggle"}
          <span className="term-verbose-tag">verbose</span>
        </div>
      ) : null}
      <TerminalComposer
        session={props.session}
        isSubagent={props.isSubagent}
        snapshot={props.snapshot}
        history={history}
        onToggleVerbose={toggleVerbose}
        viewingThreadId={props.snapshot?.threadId ?? props.session.key}
        onShowThread={props.onShowThread}
      />
    </div>
  );
}
