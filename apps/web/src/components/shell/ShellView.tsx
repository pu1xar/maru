// One shell's terminal (DESIGN.md 6s): xterm.js on the shell's view socket (lib/shellConnection.ts).
// Loaded in its own chunk with xterm when the terminal screen first shows a shell. The terminal fills its box
// and follows its size (FitAddon); a hidden view (another tab shows) keeps its terminal and socket.
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import type { ShellInfo, ShellServerFrame } from "@maru/shared";
import { useEffect, useRef, useState } from "react";

import { ShellConnection, type ShellConnectionState, type ShellSocketLike } from "~/lib/shellConnection";
import { controlChar, keySequence, SHELL_TERMINAL_ATTR } from "~/lib/shellKeys";
import { resolveTerminalTokens, useTerminalTheme } from "~/lib/terminalTheme";
import { cn } from "~/lib/utils";
import { useDisplayPrefs } from "~/lib/displayPrefs";
import { terminalFontStack, useTerminalPrefs } from "~/lib/viewMode";
import { Button } from "../ui/button";
import { ShellKeyBar } from "./ShellKeyBar";

/** The page terminal's scrollback; the same number of lines tmux keeps (server shell/tmux.ts SHELL_HISTORY_LINES). */
const SCROLLBACK_LINES = 1_000;
/** A resize goes to the shell once the box has settled (T3 Code: 150 ms). */
const RESIZE_SETTLE_MS = 120;

export interface ShellViewProps {
  shell: ShellInfo;
  /** The tab that shows; a hidden view keeps its terminal and socket. */
  active: boolean;
  /** Bumped when the view should take the keyboard (the screen opened, a tab was picked). */
  focusSeq: number;
  /** The shell is over (exited, closed elsewhere, gone). */
  onGone: (id: string, reason: "exited" | "closed" | "missing") => void;
  /** Touch screens get a row of keys their keyboard lacks (Esc, Tab, Ctrl, arrows). */
  keyBar: boolean;
  /**
   * Whether showing takes the keyboard. The terminal screen's view always does; a pane of the
   * split view does while it is the focused pane, so panes opening together do not fight for keys.
   */
  takeKeys?: boolean;
}

export default function ShellView({ shell, active, focusSeq, onGone, keyBar, takeKeys = true }: ShellViewProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connRef = useRef<ShellConnection | null>(null);
  const ctrlRef = useRef(false);
  const [ctrl, setCtrl] = useState(false);
  const [state, setState] = useState<ShellConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;
  const prefs = useTerminalPrefs();
  const themePrefs = useTerminalTheme();
  const theme = xtermTheme(resolveTerminalTokens(themePrefs.colorset));
  const fontFamily = terminalFontStack(useDisplayPrefs().monoFont);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let disposed = false;
    const term = new Terminal({
      scrollback: SCROLLBACK_LINES,
      fontFamily,
      fontSize: prefs.fontSize,
      theme,
      cursorBlink: true,
      allowProposedApi: false,
      // Option types the Mac's characters (iTerm's default); Option+click moves the cursor in a prompt.
      macOptionIsMeta: false,
      altClickMovesCursor: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    term.open(box);
    safeFit(fit, box);
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const conn = new ShellConnection({
      id: shell.id,
      origin: window.location,
      grid: () => ({ cols: term.cols, rows: term.rows }),
      open: (url) => new WebSocket(url) as unknown as ShellSocketLike,
      onAttached: () => {
        // The server sends the scrollback and the screen again on every attach.
        term.reset();
        setError(null);
      },
      onOutput: (data) => term.write(data),
      onEnded: (frame: Extract<ShellServerFrame, { type: "ended" }>) => {
        if (frame.reason === "error") setError(frame.message ?? "Could not attach to the terminal");
        else onGoneRef.current(shell.id, frame.reason);
      },
      onState: (s) => {
        if (!disposed) setState(s);
      },
    });
    connRef.current = conn;
    const dataSub = term.onData((data) => {
      // The key bar's Ctrl applies to the next key typed (a letter or @[\]^_ becomes its control code).
      if (ctrlRef.current) {
        ctrlRef.current = false;
        setCtrl(false);
        return conn.input(controlChar(data) ?? data);
      }
      conn.input(data);
    });
    const binarySub = term.onBinary((data) => conn.inputBinary(data));
    const resizeSub = term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => conn.resize(cols, rows), RESIZE_SETTLE_MS);
    });
    const observer = new ResizeObserver(() => safeFit(fit, box));
    observer.observe(box);
    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      observer.disconnect();
      dataSub.dispose();
      binarySub.dispose();
      resizeSub.dispose();
      conn.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      connRef.current = null;
    };

    // One terminal per shell and attempt: the font, size and colors change in the effect below.
  }, [shell.id, attempt]);

  // Settings changes apply to the open terminal.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = theme;
    term.options.fontFamily = fontFamily;
    term.options.fontSize = prefs.fontSize;
    if (boxRef.current && fitRef.current) safeFit(fitRef.current, boxRef.current);
    // The theme object is derived from the colorset.
  }, [themePrefs.colorset, fontFamily, prefs.fontSize]);

  // A tab that comes into view fits its box (it may have changed while hidden) and takes the keys.
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const box = boxRef.current;
    if (!term || !box || !fitRef.current) return;
    safeFit(fitRef.current, box);
    if (takeKeys) term.focus();
  }, [active, focusSeq, takeKeys]);

  const sendKey = (seq: string) => {
    connRef.current?.input(seq);
    termRef.current?.focus();
  };
  const appCursor = () => termRef.current?.modes.applicationCursorKeysMode ?? false;

  return (
    <div
      className={cn("absolute inset-0 flex flex-col", !active && "pointer-events-none invisible")}
      aria-hidden={!active || undefined}
      data-shell-view={shell.id}
      data-shell-state={state}
    >
      {/* The gutter is on the outer box: FitAddon counts the terminal's parent's whole height and
          width, so padding there would give a row and columns that do not fit. */}
      <div className="flex min-h-0 flex-1 px-2 pt-1" style={{ backgroundColor: theme.background }}>
        <div ref={boxRef} {...{ [SHELL_TERMINAL_ATTR]: "" }} className="min-h-0 min-w-0 flex-1 overflow-hidden" />
      </div>
      {state === "reconnecting" ? (
        <div role="status" className="pointer-events-none absolute top-1.5 right-3 rounded-md bg-black/60 px-2 py-0.5 text-[11px] text-white/80">
          Reconnecting
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
          <span className="min-w-0 flex-1 wrap-anywhere">{error}</span>
          <Button size="xs" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Reconnect
          </Button>
        </div>
      ) : null}
      {keyBar && active ? (
        <ShellKeyBar
          ctrl={ctrl}
          onCtrl={() => {
            ctrlRef.current = !ctrlRef.current;
            setCtrl(ctrlRef.current);
            termRef.current?.focus();
          }}
          onKey={(name) => sendKey(keySequence(name, appCursor()))}
        />
      ) : null}
    </div>
  );
}

/** Fits the terminal to its box unless the box has no size (a hidden view). */
function safeFit(fit: FitAddon, box: HTMLElement): void {
  if (box.clientWidth === 0 || box.clientHeight === 0) return;
  try {
    fit.fit();
  } catch {
    // the terminal is being disposed
  }
}

/**
 * The terminal theme's colors (Settings, 터미널 컬러셋 and 배경) for xterm: background, text,
 * cursor and selection. The 16 ANSI colors stay xterm's defaults; the colorsets define roles, not
 * a full palette.
 */
function xtermTheme(t: ReturnType<typeof resolveTerminalTokens>): ITheme {
  return {
    background: t.bg,
    foreground: t.fg,
    cursor: t.cursor,
    cursorAccent: t.bg,
    selectionBackground: t.selectionBg,
    selectionForeground: t.selectionFg,
  };
}
