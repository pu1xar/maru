// The terminal mode's color theme row (Settings, Appearance, Terminal color set; lib/terminalTheme.ts, DESIGN.md 6i).
// One select like iTerm's Color Presets popup: the closed control shows the chosen name, the open
// list shows every name with a small swatch of that set's role colors on its own background. The
// choice applies to the terminal mode at once, and the preview under the row shows every role.
import type { CSSProperties } from "react";

import {
  DEFAULT_TERMINAL_THEME,
  TERMINAL_COLORSETS,
  colorsetById,
  setTerminalTheme,
  terminalSwatch,
  terminalThemeStyle,
  useTerminalTheme,
} from "~/lib/terminalTheme";
import { useDisplayPrefs } from "~/lib/displayPrefs";
import { terminalRootStyle, useTerminalPrefs } from "~/lib/viewMode";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

/** The role colors as dots on the colorset's own background. */
function Swatch(props: { colorsetId: string }) {
  const s = terminalSwatch(props.colorsetId);
  return (
    <span
      aria-hidden
      data-swatch-bg={s.bg}
      className="inline-flex flex-none items-center gap-1 rounded-md border border-border px-1.5 py-1.5"
      style={{ background: s.bg }}
    >
      {s.roles.map((color, i) => (
        <span key={i} className="inline-block size-2 rounded-full" style={{ background: color }} />
      ))}
    </span>
  );
}

export function TerminalThemeRows() {
  const theme = useTerminalTheme();
  const set = colorsetById(theme.colorset);
  return (
    <SettingsRow
      title="Terminal color set"
      description={`${set.label}: ${set.hint}`}
      resetAction={
        theme.colorset !== DEFAULT_TERMINAL_THEME.colorset ? (
          <SettingResetButton label="Terminal color set" onClick={() => setTerminalTheme({ colorset: DEFAULT_TERMINAL_THEME.colorset })} />
        ) : null
      }
      control={
        <Select
          value={theme.colorset}
          onValueChange={(next) => {
            if (typeof next === "string" && TERMINAL_COLORSETS.some((c) => c.id === next)) setTerminalTheme({ colorset: next });
          }}
        >
          <SelectTrigger size="sm" className="w-56 shrink-0" aria-label="Terminal color set">
            <SelectValue>{set.label}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {TERMINAL_COLORSETS.map((c) => (
              <SelectItem hideIndicator key={c.id} value={c.id} title={c.hint}>
                <span className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{c.label}</span>
                  <Swatch colorsetId={c.id} />
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    >
      <ThemePreview />
    </SettingsRow>
  );
}

/**
 * One screen with every color role: the user's row, Claude's answer, a tool call, a diff with an
 * added and a removed line, an error, a warning, the progress line and the mode lines. The
 * classes are the terminal mode's own (index.css `.term-*`).
 */
function ThemePreview() {
  const theme = useTerminalTheme();
  const prefs = useTerminalPrefs();
  const { monoFont } = useDisplayPrefs();
  const style = { ...terminalRootStyle({ font: monoFont, fontSize: prefs.fontSize }), ...terminalThemeStyle(theme.colorset) } as CSSProperties;
  return (
    <div className="mt-1 mb-3">
      <div
          role="img"
          aria-label="Terminal color preview"
          data-testid="term-theme-preview"
          className="term-root dark flex-none overflow-x-auto rounded-lg border border-border px-3 py-2 whitespace-pre"
          style={style}
        >
          <div className="term-user">
            <span className="term-user-prompt">{"❯ "}</span>
            <span>Add a timeout to config.json</span>
          </div>
          <div>
            <span className="term-claude">{"⏺ "}</span>
            <span>I will create the file and update the value, 한글 is fine too</span>
          </div>
          <div>
            <span className="term-ok">{"⏺ "}</span>
            <b>Update</b>(config.json)
          </div>
          <div>
            <span className="term-dim">{"  ⎿  Added 1 line, removed 1 line"}</span>
          </div>
          <div className="term-diff-del">
            <span className="term-diff-mark">{"  - "}</span>
            {'  "timeout": 30,'}
          </div>
          <div className="term-diff-add">
            <span className="term-diff-mark">{"  + "}</span>
            {'  "timeout": 60,'}
          </div>
          <div>
            <span className="term-err">{"⏺ "}</span>
            <b className="term-err">Error</b>
            <span className="term-err">: ENOENT no such file</span>
          </div>
          <div>
            <span className="term-warn">{"⚠ rate limit 82% used"}</span>
          </div>
          <div>
            <span className="term-claude">{"✻ Pondering…"}</span> <span className="term-dim">(12s  ↓ 184 tokens)</span>
          </div>
          <div>
            <span className="term-accent">{"`inline code`"}</span> <span className="term-accent">{"link accent"}</span>{" "}
            <span className="term-plan">{"⏸ plan mode"}</span> <span className="term-mode-accept">{"⏵⏵ accept edits"}</span>
          </div>
        </div>
    </div>
  );
}
