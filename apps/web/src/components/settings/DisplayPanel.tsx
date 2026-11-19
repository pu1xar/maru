// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: components/settings/TypographySettings.tsx (settings rows with a reset button and a
// size select, a code font row apart from the terminal font row) and
// components/settings/SettingsFontPreviews.tsx (a preview as a row's children). Local change:
// per-browser values in localStorage instead of T3's server settings: the interface font and
// scale, the conversation's font and text size, the inline code's text size and the chat code
// font, text size and background (lib/displayPrefs.ts; the text sizes are pt, the size at UI scale
// 100%, which the UI scale multiplies; the code sizes follow the conversation's until they are
// set; the fonts are lib/uiFonts.ts), and the
// terminal mode's default, font and size (lib/viewMode.ts, DESIGN.md 6i), the color theme
// (lib/theme.ts), and the sidebar's and the right panel's zoom (lib/areaZoom.ts). Both fonts pick
// from one monospace list. The rows sit in sections (see the section titles below), each with a reset for its own rows; a new display setting is one more SettingsRow in the section it
// belongs to. Ctrl+wheel over an area moves the same values (the conversation text size, the
// terminal text size, the two zooms), one step per notch. The two text sizes and the terminal's
// are in pt and the scales are percents; 1pt is 1 CSS px.
import { PlusIcon } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";

import {
  CHAT_CODE_PRESETS,
  CHAT_TEXT_RANGE,
  DEFAULT_DISPLAY_PREFS,
  MESSAGE_BUBBLE_STYLES,
  UI_SCALE_RANGE,
  isCustomChatCodeBackground,
  normalizeMessageBubble,
  parseHexColor,
  setDisplayPrefs,
  useDisplayPrefs,
  type ChatCodeBackground,
} from "~/lib/displayPrefs";
import { UI_FONTS, normalizeChatFont, normalizeUiFont } from "~/lib/uiFonts";
import {
  DEFAULT_TERMINAL_PREFS,
  TERMINAL_FONTS,
  TERMINAL_FONT_RANGE,
  setTerminalPrefs,
  terminalRootStyle,
  useTerminalPrefs,
  type TerminalFontId,
} from "~/lib/viewMode";
import { DEFAULT_TERMINAL_THEME, setTerminalTheme, useTerminalTheme, useTerminalThemeStyle } from "~/lib/terminalTheme";
import { DEFAULT_THEME, THEME_PREFS, normalizeTheme, setThemePref, useTheme } from "~/lib/theme";
import { AREA_ZOOM_DEFAULTS, AREA_ZOOM_RANGE, setAreaZoom, useAreaZoom } from "~/lib/areaZoom";
import { BACKDROP_CHOICES, BACKDROP_RANGE, DEFAULT_BACKDROP, setBackdrop, useBackdrop, type WindowBackdrop } from "~/lib/desktopBackdrop";
import { desktopBridge } from "~/lib/desktopBridge";
import { MarkdownCodeBlock, MarkdownCodeBlockCode } from "../chat/MarkdownCodeBlock";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SegmentedChoice, SwatchChoice, type SwatchOption } from "./choiceControls";
import { FollowableNumberSetting, NumberSetting } from "./numberControls";
import { SettingResetButton, SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { TerminalThemeRows } from "./TerminalThemeRows";

const MONO_FONT_OPTIONS = TERMINAL_FONTS.map((f) => ({ value: f.id, label: f.label, fontFamily: f.stack }));

const UI_FONT_OPTIONS = UI_FONTS.map((f) => ({ value: f.id, label: f.label }));
/** The conversation font's choices: the interface's font, or one of the same list. */
const CHAT_FONT_OPTIONS = [{ value: "ui", label: "Same as UI" }, ...UI_FONT_OPTIONS];

/**
 * The bubble's colors as swatches, each in the color it shows in this theme: the default is the
 * theme's own message surface (index.css `--message-bubble-preset-default`, which stays put when the
 * root's bubble choice changes `--message-surface`) and blue is the accent.
 */
const BUBBLE_SWATCHES: readonly SwatchOption[] = MESSAGE_BUBBLE_STYLES.map((b) => ({
  value: b.id,
  label: b.label,
  background: b.id === "blue" ? "var(--primary)" : "var(--message-bubble-preset-default)",
}));
/** The custom color's swatch: a rainbow with a plus. */
const CUSTOM_RAINBOW = "conic-gradient(#f87171, #facc15, #4ade80, #60a5fa, #c084fc, #f87171)";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** How an area's zoom wheel is named in the rows' descriptions (lib/areaZoom.ts isZoomWheel). */
const ZOOM_WHEEL = IS_MAC ? "⌘+wheel" : "Ctrl+wheel";

function fontId(value: string): TerminalFontId | null {
  return TERMINAL_FONTS.find((f) => f.id === value)?.id ?? null;
}

/** A settings row whose undo mark shows while the value differs from its default. */
function Row(props: {
  title: string;
  changed: boolean;
  onReset: () => void;
  description?: string;
  control: ReactNode;
  children?: ReactNode;
}) {
  return (
    <SettingsRow
      title={props.title}
      description={props.description}
      resetAction={props.changed ? <SettingResetButton label={props.title} onClick={props.onReset} /> : null}
      control={props.control}
    >
      {props.children}
    </SettingsRow>
  );
}

export function DisplayPanel() {
  const prefs = useDisplayPrefs();
  const term = useTerminalPrefs();
  const theme = useTheme();
  const termTheme = useTerminalTheme();
  const sidebarZoom = useAreaZoom("sidebar");
  const panelZoom = useAreaZoom("panel");
  const backdrop = useBackdrop();
  const inDesktop = desktopBridge() !== null;
  const backdropChanged = backdrop.backdrop !== DEFAULT_BACKDROP.backdrop || backdrop.transparency !== DEFAULT_BACKDROP.transparency;
  const colorChanged =
    theme.pref !== DEFAULT_THEME ||
    prefs.messageBubble !== DEFAULT_DISPLAY_PREFS.messageBubble ||
    prefs.chatCodeBackground !== DEFAULT_DISPLAY_PREFS.chatCodeBackground ||
    termTheme.colorset !== DEFAULT_TERMINAL_THEME.colorset ||
    (inDesktop && backdropChanged);
  const typeChanged =
    prefs.uiFont !== DEFAULT_DISPLAY_PREFS.uiFont ||
    prefs.uiScale !== DEFAULT_DISPLAY_PREFS.uiScale ||
    prefs.chatFont !== DEFAULT_DISPLAY_PREFS.chatFont ||
    prefs.chatText !== DEFAULT_DISPLAY_PREFS.chatText ||
    prefs.chatInlineCodeText !== DEFAULT_DISPLAY_PREFS.chatInlineCodeText ||
    prefs.monoFont !== DEFAULT_DISPLAY_PREFS.monoFont ||
    prefs.chatCodeText !== DEFAULT_DISPLAY_PREFS.chatCodeText ||
    term.fontSize !== DEFAULT_TERMINAL_PREFS.fontSize ||
    sidebarZoom !== AREA_ZOOM_DEFAULTS.sidebar ||
    panelZoom !== AREA_ZOOM_DEFAULTS.panel;
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Colors"
        headerAction={
          <SectionResetButton
            disabled={!colorChanged}
            onClick={() => {
              setThemePref(DEFAULT_THEME);
              setDisplayPrefs({ messageBubble: DEFAULT_DISPLAY_PREFS.messageBubble, chatCodeBackground: DEFAULT_DISPLAY_PREFS.chatCodeBackground });
              setTerminalTheme(DEFAULT_TERMINAL_THEME);
              if (inDesktop) setBackdrop(DEFAULT_BACKDROP);
            }}
          />
        }
      >
        <Row
          title="Theme"
          changed={theme.pref !== DEFAULT_THEME}
          onReset={() => setThemePref(DEFAULT_THEME)}
          control={
            <SegmentedChoice
              label="Theme"
              value={theme.pref}
              options={THEME_PREFS.map((t) => ({ value: t.id, label: t.label }))}
              onChange={(v) => setThemePref(normalizeTheme(v))}
            />
          }
        />
        <Row
          title="My message bubble color"
          changed={prefs.messageBubble !== DEFAULT_DISPLAY_PREFS.messageBubble}
          onReset={() => setDisplayPrefs({ messageBubble: DEFAULT_DISPLAY_PREFS.messageBubble })}
          control={
            <SwatchChoice
              label="My message bubble color"
              value={prefs.messageBubble}
              options={BUBBLE_SWATCHES}
              onChange={(v) => setDisplayPrefs({ messageBubble: normalizeMessageBubble(v) })}
            />
          }
        />
        <Row
          title="Code block color"
          changed={prefs.chatCodeBackground !== DEFAULT_DISPLAY_PREFS.chatCodeBackground}
          onReset={() => setDisplayPrefs({ chatCodeBackground: DEFAULT_DISPLAY_PREFS.chatCodeBackground })}
          control={<ChatCodeBackgroundControl value={prefs.chatCodeBackground} />}
        >
          <ChatCodePreview />
        </Row>
        <TerminalThemeRows />
        {inDesktop ? (
          // The desktop app's window (DESIGN.md 2e, window background); a browser has no window of its own.
          <>
            <Row
              title="Window backdrop blur"
              changed={backdrop.backdrop !== DEFAULT_BACKDROP.backdrop}
              onReset={() => setBackdrop({ backdrop: DEFAULT_BACKDROP.backdrop })}
              control={
                <SegmentedChoice
                  label="Window backdrop blur"
                  value={backdrop.backdrop}
                  options={BACKDROP_CHOICES.map((c) => ({ value: c.id, label: c.label }))}
                  onChange={(v) => setBackdrop({ backdrop: v as WindowBackdrop })}
                />
              }
            />
            {backdrop.backdrop !== "off" ? (
              <Row
                title="Transparency"
                changed={backdrop.transparency !== DEFAULT_BACKDROP.transparency}
                onReset={() => setBackdrop({ transparency: DEFAULT_BACKDROP.transparency })}
                control={
                  <NumberSetting
                    label="Transparency"
                    value={backdrop.transparency}
                    range={BACKDROP_RANGE}
                    unit="%"
                    onChange={(transparency) => setBackdrop({ transparency })}
                  />
                }
              />
            ) : null}
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Fonts and sizes"
        headerAction={
          <SectionResetButton
            disabled={!typeChanged}
            onClick={() => {
              setDisplayPrefs({
                uiFont: DEFAULT_DISPLAY_PREFS.uiFont,
                uiScale: DEFAULT_DISPLAY_PREFS.uiScale,
                chatFont: DEFAULT_DISPLAY_PREFS.chatFont,
                chatText: DEFAULT_DISPLAY_PREFS.chatText,
                chatInlineCodeText: DEFAULT_DISPLAY_PREFS.chatInlineCodeText,
                monoFont: DEFAULT_DISPLAY_PREFS.monoFont,
                chatCodeText: DEFAULT_DISPLAY_PREFS.chatCodeText,
              });
              setTerminalPrefs({ fontSize: DEFAULT_TERMINAL_PREFS.fontSize });
              setAreaZoom("sidebar", AREA_ZOOM_DEFAULTS.sidebar);
              setAreaZoom("panel", AREA_ZOOM_DEFAULTS.panel);
            }}
          />
        }
      >
        <Row
          title="UI font"
          changed={prefs.uiFont !== DEFAULT_DISPLAY_PREFS.uiFont}
          onReset={() => setDisplayPrefs({ uiFont: DEFAULT_DISPLAY_PREFS.uiFont })}
          control={
            <ChoiceSelect
              label="UI font"
              value={prefs.uiFont}
              wide
              options={UI_FONT_OPTIONS}
              onChange={(v) => setDisplayPrefs({ uiFont: normalizeUiFont(v) })}
            />
          }
        />
        <Row
          title="UI scale"
          changed={prefs.uiScale !== DEFAULT_DISPLAY_PREFS.uiScale}
          onReset={() => setDisplayPrefs({ uiScale: DEFAULT_DISPLAY_PREFS.uiScale })}
          control={
            <NumberSetting label="UI scale" value={prefs.uiScale} range={UI_SCALE_RANGE} unit="%" onChange={(uiScale) => setDisplayPrefs({ uiScale })} />
          }
        />
        <Row
          title="Conversation font"
          changed={prefs.chatFont !== DEFAULT_DISPLAY_PREFS.chatFont}
          onReset={() => setDisplayPrefs({ chatFont: DEFAULT_DISPLAY_PREFS.chatFont })}
          control={
            <ChoiceSelect
              label="Conversation font"
              value={prefs.chatFont}
              wide
              options={CHAT_FONT_OPTIONS}
              onChange={(v) => setDisplayPrefs({ chatFont: normalizeChatFont(v) })}
            />
          }
        >
          <ChatTextPreview />
        </Row>
        <Row
          title="Conversation text size"
          description={ZOOM_WHEEL}
          changed={prefs.chatText !== DEFAULT_DISPLAY_PREFS.chatText}
          onReset={() => setDisplayPrefs({ chatText: DEFAULT_DISPLAY_PREFS.chatText })}
          control={
            <NumberSetting
              label="Conversation text size"
              value={prefs.chatText}
              range={CHAT_TEXT_RANGE}
              unit="pt"
              onChange={(chatText) => setDisplayPrefs({ chatText })}
            />
          }
        />
        <Row
          title="Monospace font"
          description="Code blocks, inline code, tool output and the terminal"
          changed={prefs.monoFont !== DEFAULT_DISPLAY_PREFS.monoFont}
          onReset={() => setDisplayPrefs({ monoFont: DEFAULT_DISPLAY_PREFS.monoFont })}
          control={
            <ChoiceSelect
              label="Monospace font"
              value={prefs.monoFont}
              wide
              options={MONO_FONT_OPTIONS}
              onChange={(v) => {
                const font = fontId(v);
                if (font) setDisplayPrefs({ monoFont: font });
              }}
            />
          }
        >
          <TerminalPreview font={prefs.monoFont} size={term.fontSize} />
        </Row>
        <Row
          title="Inline code text size"
          changed={prefs.chatInlineCodeText !== DEFAULT_DISPLAY_PREFS.chatInlineCodeText}
          onReset={() => setDisplayPrefs({ chatInlineCodeText: DEFAULT_DISPLAY_PREFS.chatInlineCodeText })}
          control={
            <FollowableNumberSetting
              label="Inline code text size"
              value={prefs.chatInlineCodeText}
              conversationValue={prefs.chatText}
              range={CHAT_TEXT_RANGE}
              unit="pt"
              onChange={(chatInlineCodeText) => setDisplayPrefs({ chatInlineCodeText })}
            />
          }
        />
        <Row
          title="Code block text size"
          changed={prefs.chatCodeText !== DEFAULT_DISPLAY_PREFS.chatCodeText}
          onReset={() => setDisplayPrefs({ chatCodeText: DEFAULT_DISPLAY_PREFS.chatCodeText })}
          control={
            <FollowableNumberSetting
              label="Code block text size"
              value={prefs.chatCodeText}
              conversationValue={prefs.chatText}
              range={CHAT_TEXT_RANGE}
              unit="pt"
              onChange={(chatCodeText) => setDisplayPrefs({ chatCodeText })}
            />
          }
        />
        <Row
          title="Terminal text size"
          description={ZOOM_WHEEL}
          changed={term.fontSize !== DEFAULT_TERMINAL_PREFS.fontSize}
          onReset={() => setTerminalPrefs({ fontSize: DEFAULT_TERMINAL_PREFS.fontSize })}
          control={
            <NumberSetting
              label="Terminal text size"
              value={term.fontSize}
              range={TERMINAL_FONT_RANGE}
              unit="pt"
              onChange={(fontSize) => setTerminalPrefs({ fontSize })}
            />
          }
        />
        <Row
          title="Sidebar scale"
          description={ZOOM_WHEEL}
          changed={sidebarZoom !== AREA_ZOOM_DEFAULTS.sidebar}
          onReset={() => setAreaZoom("sidebar", AREA_ZOOM_DEFAULTS.sidebar)}
          control={
            <NumberSetting label="Sidebar scale" value={sidebarZoom} range={AREA_ZOOM_RANGE} unit="%" onChange={(v) => setAreaZoom("sidebar", v)} />
          }
        />
        <Row
          title="Right panel scale"
          description={ZOOM_WHEEL}
          changed={panelZoom !== AREA_ZOOM_DEFAULTS.panel}
          onReset={() => setAreaZoom("panel", AREA_ZOOM_DEFAULTS.panel)}
          control={
            <NumberSetting label="Right panel scale" value={panelZoom} range={AREA_ZOOM_RANGE} unit="%" onChange={(v) => setAreaZoom("panel", v)} />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="View"
        headerAction={
          <SectionResetButton
            disabled={term.defaultMode === DEFAULT_TERMINAL_PREFS.defaultMode}
            onClick={() => setTerminalPrefs({ defaultMode: DEFAULT_TERMINAL_PREFS.defaultMode })}
          />
        }
      >
        <Row
          title="Default view mode"
          changed={term.defaultMode !== DEFAULT_TERMINAL_PREFS.defaultMode}
          onReset={() => setTerminalPrefs({ defaultMode: DEFAULT_TERMINAL_PREFS.defaultMode })}
          control={
            <SegmentedChoice
              label="Default view mode"
              value={term.defaultMode}
              options={[
                { value: "chat", label: "Chat" },
                { value: "terminal", label: "Terminal" },
              ]}
              onChange={(v) => setTerminalPrefs({ defaultMode: v === "terminal" ? "terminal" : "chat" })}
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function SectionResetButton(props: { disabled: boolean; onClick: () => void }) {
  return (
    <Button size="xs" variant="ghost-muted" disabled={props.disabled} onClick={props.onClick}>
      Reset
    </Button>
  );
}

/** The value a custom color starts from: the color the code has now (a preset's token, read from the root). */
function currentChatCodeColor(): `#${string}` {
  const shown = getComputedStyle(document.documentElement).getPropertyValue("--chat-code-background");
  return parseHexColor(shown) ?? "#1c1c1c";
}

/** The presets (each painted in its token, so it shows this theme's value) and a custom color with its inputs. */
function ChatCodeBackgroundControl(props: { value: ChatCodeBackground }) {
  const custom = isCustomChatCodeBackground(props.value) ? props.value : null;
  const selected = custom ? "custom" : props.value;
  const options: SwatchOption[] = [
    ...CHAT_CODE_PRESETS.map((p) => ({ value: p.id, label: p.label, background: `var(--chat-code-preset-${p.id})` })),
    {
      value: "custom",
      label: "Custom",
      background: CUSTOM_RAINBOW,
      mark: <PlusIcon aria-hidden className="size-3.5 text-white drop-shadow-[0_0_2px_rgb(0_0_0/0.7)]" />,
    },
  ];
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
      <SwatchChoice
        label="Code block color"
        value={selected}
        options={options}
        onChange={(next) => {
          if (next === "custom") {
            if (!custom) setDisplayPrefs({ chatCodeBackground: currentChatCodeColor() });
            return;
          }
          const preset = CHAT_CODE_PRESETS.find((p) => p.id === next);
          if (preset) setDisplayPrefs({ chatCodeBackground: preset.id });
        }}
      />
      {custom ? <CustomColorInputs value={custom} /> : null}
    </div>
  );
}

/** The browser's color picker and a hex field; a valid hex applies as it is typed. */
function CustomColorInputs(props: { value: `#${string}` }) {
  const [draft, setDraft] = useState<string | null>(null);
  const invalid = draft !== null && parseHexColor(draft) === null;
  return (
    <>
      <input
        type="color"
        aria-label="Choose chat code block color"
        value={props.value}
        onChange={(event) => {
          const hex = parseHexColor(event.currentTarget.value);
          setDraft(null);
          if (hex) setDisplayPrefs({ chatCodeBackground: hex });
        }}
        className="size-7 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5 [&::-webkit-color-swatch]:rounded-[4px] [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0"
      />
      <Input
        nativeInput
        size="sm"
        font="mono"
        className="w-24 shrink-0"
        aria-label="Chat code block color hex"
        aria-invalid={invalid || undefined}
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        maxLength={7}
        value={draft ?? props.value}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          const hex = parseHexColor(next);
          if (hex) setDisplayPrefs({ chatCodeBackground: hex });
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setDraft(null);
        }}
      />
    </>
  );
}

const PREVIEW_CODE = "export function formatUser(user: User) {\n  return `${user.name} <${user.email}>`; // 0O 1lI 한글\n}";
const PREVIEW_COMMAND = "pnpm --filter @maru/web test";

function PreviewCodeBlock(props: { code: string; language: string }) {
  const className = `language-${props.language}`;
  return (
    <MarkdownCodeBlock code={props.code} language={props.language} fenceTitle={null}>
      <pre>
        <MarkdownCodeBlockCode code={props.code} language={props.language} className={className}>
          <code className={className}>{props.code}</code>
        </MarkdownCodeBlockCode>
      </pre>
    </MarkdownCodeBlock>
  );
}

/**
 * An answer and a user's bubble with inline code and a code block, drawn with the chat's own
 * classes. Inside `data-chat-text` like the conversation, so it shows the conversation text size,
 * the chat code font and the code background together.
 */
function ChatCodePreview() {
  return (
    <div data-chat-text="" className="contents">
      <div role="group" aria-label="Chat code preview" className="mt-1 mb-3 space-y-3 rounded-lg border border-border bg-background p-3">
        <PreviewProse className="text-foreground/90">
          <p>
            <code>formatUser</code> uses the name and <code>email</code> together
          </p>
          <PreviewCodeBlock code={PREVIEW_CODE} language="ts" />
        </PreviewProse>
        <div className="flex justify-end">
          <div data-user-message-bubble="" className="min-w-0 max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
            <PreviewProse className="user-message-markdown text-message-foreground">
              <p>
                <code>inline code</code> in a bubble and a code block
              </p>
              <PreviewCodeBlock code={PREVIEW_COMMAND} language="bash" />
            </PreviewProse>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A sentence with inline code, drawn in the conversation's font and sizes (under the conversation font row). */
function ChatTextPreview() {
  return (
    <div data-chat-text="" className="contents">
      <div role="group" aria-label="Conversation font preview" className="mt-1 mb-3 rounded-lg border border-border bg-background p-3">
        <PreviewProse className="text-foreground/90">
          <p>
            English and 한글 in one sentence, with <code>inline code</code> inside it 0O 1lI
          </p>
        </PreviewProse>
      </div>
    </div>
  );
}

function PreviewProse(props: { className: string; children: ReactNode }) {
  return <div className={`chat-markdown w-full min-w-0 text-sm leading-relaxed ${props.className}`}>{props.children}</div>;
}

/**
 * Two lines in the terminal mode's own colors (index.css `.term-root` and its `.term-*` classes),
 * font and size, under the font row as T3 puts its font previews.
 */
function TerminalPreview(props: { font: TerminalFontId; size: number }) {
  const themeStyle = useTerminalThemeStyle();
  return (
    <div
      role="img"
      aria-label="Terminal font preview"
      className="term-root mt-1 mb-3 flex-none overflow-x-auto rounded-lg border border-border px-3 py-2 whitespace-pre"
      style={{ ...terminalRootStyle({ font: props.font, fontSize: props.size }), ...themeStyle } as CSSProperties}
    >
      <div>
        <span className="term-ok">{"⏺"}</span> <b>Bash</b>(ls -la)
      </div>
      <div>
        <span className="term-dim">{"  ⎿  "}</span>English and 한글 on one line 0O1lI
      </div>
    </div>
  );
}

function ChoiceSelect(props: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string; fontFamily?: string }>;
  wide?: boolean;
  onChange: (v: string) => void;
}) {
  const current = props.options.find((o) => o.value === props.value);
  return (
    <Select
      value={props.value}
      onValueChange={(next) => {
        if (typeof next === "string" && props.options.some((o) => o.value === next)) props.onChange(next);
      }}
    >
      <SelectTrigger size="sm" className={props.wide ? "w-56 shrink-0" : "w-auto shrink-0"} aria-label={props.label}>
        <SelectValue>{current?.label ?? props.value}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {props.options.map((o) => (
          <SelectItem hideIndicator key={o.value} value={o.value}>
            <span style={o.fontFamily ? { fontFamily: o.fontFamily } : undefined}>{o.label}</span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
