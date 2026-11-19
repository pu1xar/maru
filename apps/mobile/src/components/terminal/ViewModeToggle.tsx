// Chat or terminal: the same thread drawn as the chat timeline or as Claude Code's TUI (the web's
// ViewModeToggle in the conversation header). One button that shows the view in use and switches to
// the other on a tap (user request 2026-11-18: "버튼 하나로 두고 클릭하면 바뀌는 식으로(현재 ui를 보여주면 댐)").
import { StyleSheet } from "react-native";
import { MessageSquareTextIcon, SquareTerminalIcon } from "lucide-react-native";
import type { ViewMode } from "../../../../web/src/lib/viewMode.logic.ts";
import { usePalette } from "../../theme.ts";
import { Press } from "../Press.tsx";

export function ViewModeToggle(props: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  const p = usePalette();
  const chat = props.mode === "chat";
  return (
    <Press
      onPress={() => props.onChange(chat ? "terminal" : "chat")}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={chat ? "Chat view, switch to terminal" : "Terminal view, switch to chat"}
      style={styles.button}
    >
      {chat ? <MessageSquareTextIcon size={20} color={p.text} /> : <SquareTerminalIcon size={20} color={p.text} />}
    </Press>
  );
}

const styles = StyleSheet.create({
  button: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 8 },
});
