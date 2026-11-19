// The error card above the input, as the web draws it (ThreadComposer's role="alert" block: a
// rounded-lg card in the error surface, an alert icon and the text in the error-foreground color).
import { StyleSheet, View } from "react-native";
import { Text } from "./ui/Text.tsx";
import { CircleAlertIcon } from "lucide-react-native";
import { type } from "../typography.ts";
import { useComposerColors } from "./useComposerColors.ts";

export function ComposerError(props: { text: string; marginHorizontal?: number }) {
  const c = useComposerColors();
  return (
    <View
      accessibilityRole="alert"
      style={[styles.card, { backgroundColor: c.errorSurface, marginHorizontal: props.marginHorizontal ?? 0 }]}
    >
      <CircleAlertIcon size={14} color={c.errorText} style={styles.icon} />
      <Text style={[type.small, { color: c.errorText, flex: 1 }]}>{props.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // web: flex items-start gap-2 rounded-lg px-3 py-2 text-xs; the icon sits 1px from the top (mt-px)
  card: { flexDirection: "row", alignItems: "flex-start", gap: 8, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  icon: { marginTop: 1 },
});
