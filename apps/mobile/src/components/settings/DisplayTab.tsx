// The Appearance tab (the web's settings/DisplayPanel.tsx): the sections Colors and Fonts and sizes, each with a
// reset for its own rows, every row a title, an undo mark when it differs from its default, the control its
// data calls for (a segmented line for the theme, circles for colors, a number field for sizes and scales, a
// select for the font lists) and, under some, a preview drawn by the conversation's own Markdown. The rows'
// words, order and defaults are the web's (lib/settingsDisplay.logic.ts). The terminal mode's rows (color set,
// text size, default view mode) are the web's too (DESIGN.md 6i). Left out because the app has no such
// thing: the desktop window's backdrop and the right panel's zoom.
import { useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View, useColorScheme } from "react-native";
import { PaletteScope, TextScopeProvider, useAppearance } from "../../appearance.tsx";
import { normalizeMessageBubble, normalizeMonoFont, parseHexColor } from "../../../../web/src/lib/displayPrefs.logic.ts";
import { bubbleContent } from "../../lib/appearancePalette.ts";
import {
  CHAT_FONT_OPTIONS,
  CODE_BACKGROUND_CUSTOM,
  COLOR_DEFAULTS,
  MONO_FONT_NOTES,
  MONO_FONT_OPTIONS,
  NUMBER_ROWS,
  TERMINAL_COLORSET_OPTIONS,
  THEME_OPTIONS,
  TYPE_DEFAULTS,
  UI_FONT_OPTIONS,
  VIEW_DEFAULTS,
  VIEW_MODE_OPTIONS,
  bubbleSwatches,
  codeBackgroundChoice,
  codeBackgroundSwatches,
  colorChanged,
  terminalColorsetNote,
  typeChanged,
  viewChanged,
} from "../../lib/settingsDisplay.logic.ts";
import { normalizeTheme } from "../../../../web/src/lib/theme.logic.ts";
import { normalizeChatFont, normalizeUiFont } from "../../../../web/src/lib/uiFonts.logic.ts";
import { usePalette } from "../../theme.ts";
import { Markdown } from "../Markdown.tsx";
import { TerminalFontPreview, TerminalThemePreview } from "../terminal/TerminalPreview.tsx";
import { Btn } from "../ui/Btn.tsx";
import { FollowableNumberField, NumberField, SwatchField } from "../ui/ChoiceFields.tsx";
import { Segmented, SelectField, TextField } from "../ui/Fields.tsx";
import { SettingResetButton, SettingsRow, SettingsSection } from "../ui/SettingsParts.tsx";
import { Text } from "../ui/Text.tsx";
import { ui } from "../ui/metrics.ts";

export function DisplayTab() {
  const { prefs, set, fonts } = useAppearance();
  const scheme = useColorScheme() === "light" ? "light" : "dark";
  const colorsDiffer = colorChanged(prefs);
  const typeDiffers = typeChanged(prefs);
  const viewDiffers = viewChanged(prefs);
  // A font file that is on its way, or did not arrive, shows under the rows that use a file.
  const fontNote = fonts.loading ? "Downloading font files, shown in the device font until done" : fonts.error ? `Could not download font files: ${fonts.error}` : null;
  const monoNote = [MONO_FONT_NOTES[prefs.monoFont], prefs.monoFont === "system" || prefs.monoFont === "sf-mono" ? null : fontNote]
    .filter(Boolean)
    .join(". ");

  return (
    <View style={{ gap: 32 }}>
      <SettingsSection title="Colors" headerAction={<SectionReset disabled={!colorsDiffer} onPress={() => set(COLOR_DEFAULTS)} />}>
        <Row title="Theme" changed={prefs.theme !== COLOR_DEFAULTS.theme} onReset={() => set({ theme: COLOR_DEFAULTS.theme })}
          control={
            <Segmented label="Theme" items={THEME_OPTIONS} value={prefs.theme} onPick={(v) => set({ theme: normalizeTheme(v) })} />
          }
        />
        <Row title="My bubble color" changed={prefs.messageBubble !== COLOR_DEFAULTS.messageBubble} onReset={() => set({ messageBubble: COLOR_DEFAULTS.messageBubble })}
          control={
            <SwatchField
              label="My bubble color"
              value={prefs.messageBubble}
              swatches={bubbleSwatches(scheme)}
              onChange={(v) => set({ messageBubble: normalizeMessageBubble(v) })}
            />
          }
        />
        <Row title="Code block color" changed={prefs.chatCodeBackground !== COLOR_DEFAULTS.chatCodeBackground} onReset={() => set({ chatCodeBackground: COLOR_DEFAULTS.chatCodeBackground })}
          control={<CodeBackgroundControl scheme={scheme} />}
        >
          <CodeBackgroundPreview />
        </Row>
        <Row title="Terminal color set" description={terminalColorsetNote(prefs.terminalColorset)} changed={prefs.terminalColorset !== COLOR_DEFAULTS.terminalColorset} onReset={() => set({ terminalColorset: COLOR_DEFAULTS.terminalColorset })}
          control={<SelectField bare label="Terminal color set" value={prefs.terminalColorset} options={TERMINAL_COLORSET_OPTIONS} onChange={(v) => set({ terminalColorset: v })} />}
        >
          <TerminalThemePreview />
        </Row>
      </SettingsSection>

      <SettingsSection title="Fonts and sizes" headerAction={<SectionReset disabled={!typeDiffers} onPress={() => set(TYPE_DEFAULTS)} />}>
        <Row title="UI font" changed={prefs.uiFont !== TYPE_DEFAULTS.uiFont} onReset={() => set({ uiFont: TYPE_DEFAULTS.uiFont })} status={prefs.uiFont === "system" ? null : fontNote}
          control={<SelectField bare label="UI font" value={prefs.uiFont} options={UI_FONT_OPTIONS} onChange={(v) => set({ uiFont: normalizeUiFont(v) })} />}
        />
        <Row title="UI scale" changed={prefs.uiScale !== TYPE_DEFAULTS.uiScale} onReset={() => set({ uiScale: TYPE_DEFAULTS.uiScale })}
          control={<NumberField label="UI scale" value={prefs.uiScale} {...NUMBER_ROWS.uiScale} onChange={(uiScale) => set({ uiScale })} />}
        />
        <Row title="Conversation font" changed={prefs.chatFont !== TYPE_DEFAULTS.chatFont} onReset={() => set({ chatFont: TYPE_DEFAULTS.chatFont })} status={prefs.chatFont === "ui" || prefs.chatFont === "system" ? null : fontNote}
          control={<SelectField bare label="Conversation font" value={prefs.chatFont} options={CHAT_FONT_OPTIONS} onChange={(v) => set({ chatFont: normalizeChatFont(v) })} />}
        >
          <ChatTextPreview />
        </Row>
        <Row title="Conversation text size" changed={prefs.chatText !== TYPE_DEFAULTS.chatText} onReset={() => set({ chatText: TYPE_DEFAULTS.chatText })}
          control={<NumberField label="Conversation text size" value={prefs.chatText} {...NUMBER_ROWS.chatText} onChange={(chatText) => set({ chatText })} />}
        />
        <Row title="Monospace font" description={monoNote ? `Code blocks, inline code, tool output and the terminal. ${monoNote}` : "Code blocks, inline code, tool output and the terminal"} changed={prefs.monoFont !== TYPE_DEFAULTS.monoFont} onReset={() => set({ monoFont: TYPE_DEFAULTS.monoFont })}
          control={<SelectField bare label="Monospace font" value={prefs.monoFont} options={MONO_FONT_OPTIONS} onChange={(v) => set({ monoFont: normalizeMonoFont(v) })} />}
        >
          <TerminalFontPreview />
        </Row>
        <Row title="Inline code text size" changed={prefs.chatInlineCodeText !== TYPE_DEFAULTS.chatInlineCodeText} onReset={() => set({ chatInlineCodeText: TYPE_DEFAULTS.chatInlineCodeText })}
          control={
            <FollowableNumberField
              label="Inline code text size"
              value={prefs.chatInlineCodeText}
              conversationValue={prefs.chatText}
              {...NUMBER_ROWS.chatText}
              onChange={(chatInlineCodeText) => set({ chatInlineCodeText })}
            />
          }
        />
        <Row title="Code block text size" changed={prefs.chatCodeText !== TYPE_DEFAULTS.chatCodeText} onReset={() => set({ chatCodeText: TYPE_DEFAULTS.chatCodeText })}
          control={
            <FollowableNumberField
              label="Code block text size"
              value={prefs.chatCodeText}
              conversationValue={prefs.chatText}
              {...NUMBER_ROWS.chatText}
              onChange={(chatCodeText) => set({ chatCodeText })}
            />
          }
        />
        <Row title="Terminal text size" changed={prefs.terminalFontSize !== TYPE_DEFAULTS.terminalFontSize} onReset={() => set({ terminalFontSize: TYPE_DEFAULTS.terminalFontSize })}
          control={<NumberField label="Terminal text size" value={prefs.terminalFontSize} {...NUMBER_ROWS.terminalFontSize} onChange={(terminalFontSize) => set({ terminalFontSize })} />}
        />
        <Row title="Sidebar scale" changed={prefs.sidebarZoom !== TYPE_DEFAULTS.sidebarZoom} onReset={() => set({ sidebarZoom: TYPE_DEFAULTS.sidebarZoom })}
          control={<NumberField label="Sidebar scale" value={prefs.sidebarZoom} {...NUMBER_ROWS.sidebarZoom} onChange={(sidebarZoom) => set({ sidebarZoom })} />}
        />
      </SettingsSection>

      <SettingsSection title="View" headerAction={<SectionReset disabled={!viewDiffers} onPress={() => set(VIEW_DEFAULTS)} />}>
        <Row title="Default view mode" changed={prefs.defaultViewMode !== VIEW_DEFAULTS.defaultViewMode} onReset={() => set({ defaultViewMode: VIEW_DEFAULTS.defaultViewMode })}
          control={
            <Segmented label="Default view mode" items={VIEW_MODE_OPTIONS} value={prefs.defaultViewMode} onPick={(v) => set({ defaultViewMode: v === "terminal" ? "terminal" : "chat" })} />
          }
        />
      </SettingsSection>
    </View>
  );
}

function SectionReset(props: { disabled: boolean; onPress: () => void }) {
  return <Btn size="xs" variant="ghost-muted" label="Reset" disabled={props.disabled} onPress={props.onPress} />;
}

/** A settings row: its title, the undo mark when the value is not the default, and the control. */
function Row(props: {
  title: string;
  changed: boolean;
  onReset: () => void;
  description?: string | null;
  status?: string | null;
  control: ReactNode;
  children?: ReactNode;
}) {
  return (
    <SettingsRow
      title={props.title}
      description={props.description ?? null}
      status={props.status ?? null}
      resetAction={props.changed ? <SettingResetButton label={props.title} onPress={props.onReset} /> : null}
      control={props.control}
    >
      {props.children}
    </SettingsRow>
  );
}

/** The presets and a custom color as circles, and for a custom color a hex field that applies as it is typed. */
function CodeBackgroundControl(props: { scheme: "light" | "dark" }) {
  const { prefs, set } = useAppearance();
  const choice = codeBackgroundChoice(prefs.chatCodeBackground);
  const custom = choice === CODE_BACKGROUND_CUSTOM;
  const swatches = useMemo(() => codeBackgroundSwatches(props.scheme), [props.scheme]);
  const [draft, setDraft] = useState<string | null>(null);
  const p = usePalette();
  const invalid = draft !== null && parseHexColor(draft) === null;
  return (
    <View style={{ gap: 8 }}>
      <SwatchField
        label="Code block color"
        value={choice}
        swatches={swatches}
        custom={{ value: CODE_BACKGROUND_CUSTOM, label: "Custom", color: custom ? prefs.chatCodeBackground : null }}
        onChange={(next) => {
          if (next === CODE_BACKGROUND_CUSTOM) {
            // A custom color starts from the color the code has now.
            if (!custom && /^#[0-9a-f]{6}$/i.test(p.code)) set({ chatCodeBackground: p.code.toLowerCase() as `#${string}` });
            return;
          }
          setDraft(null);
          set({ chatCodeBackground: next === "terminal" ? "terminal" : "default" });
        }}
      />
      {custom ? (
        <View style={{ width: 104, gap: 4 }}>
          <TextField
            mono
            accessibilityLabel="Code block color hex"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={7}
            value={draft ?? prefs.chatCodeBackground}
            onChangeText={(text) => {
              setDraft(text);
              const hex = parseHexColor(text);
              if (hex) set({ chatCodeBackground: hex });
            }}
            onBlur={() => setDraft(null)}
          />
          {invalid ? <Text style={[ui.xs, { color: p.danger }]}>#rrggbb</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const PREVIEW_CODE = "export function formatUser(user: User) {\n  return `${user.name} <${user.email}>`; // 0O 1lI 한글\n}";
const PREVIEW_COMMAND = "pnpm --filter @maru/web test";

/** An answer and a user's bubble with inline code and a code block, drawn by the conversation's own Markdown (web ChatCodePreview). */
function CodeBackgroundPreview() {
  const p = usePalette();
  const { prefs } = useAppearance();
  const scoped = useMemo(() => bubbleContent(p, prefs.messageBubble), [p, prefs.messageBubble]);
  const bp = scoped ?? p;
  return (
    <TextScopeProvider scope="chat">
      <View accessibilityLabel="Chat code preview" style={[styles.preview, { borderColor: p.border, backgroundColor: p.bg, gap: 12 }]}>
        <Markdown text={"`formatUser` uses the name and `email` together\n\n```ts\n" + PREVIEW_CODE + "\n```"} />
        <View style={{ alignItems: "flex-end" }}>
          <PaletteScope value={scoped}>
            <View style={[styles.bubble, { backgroundColor: p.userBubble }]}>
              <Markdown text={"`inline code` and a code block inside a bubble\n\n```bash\n" + PREVIEW_COMMAND + "\n```"} color={bp.text} inBubble />
            </View>
          </PaletteScope>
        </View>
      </View>
    </TextScopeProvider>
  );
}

/** A sentence with inline code, drawn in the conversation's font and sizes (under the conversation font row). */
function ChatTextPreview() {
  const p = usePalette();
  return (
    <TextScopeProvider scope="chat">
      <View accessibilityLabel="Conversation font preview" style={[styles.preview, { borderColor: p.border, backgroundColor: p.bg }]}>
        <Markdown text="English and 한글 text together, with `inline code` inside 0O 1lI" />
      </View>
    </TextScopeProvider>
  );
}

const styles = StyleSheet.create({
  // mt-1 mb-3 rounded-lg border border-border bg-background p-3.
  preview: { marginTop: 4, marginBottom: 12, borderRadius: 8, borderWidth: 1, padding: 12 },
  // rounded-2xl bg-message p-3, at most 80% wide.
  bubble: { maxWidth: "80%", borderRadius: 16, padding: 12 },
});
