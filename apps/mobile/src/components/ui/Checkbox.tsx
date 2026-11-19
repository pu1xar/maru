// The web's Checkbox (ui/checkbox.tsx) at phone width: size-4.5 (18), rounded .25rem, a --input outline
// on the field fill, the primary fill with a check when on, 64% opacity while disabled. The touch
// target is 44 around it (hitSlop), the web's pointer-coarse hit area.
import { StyleSheet, View } from "react-native";
import { CheckIcon } from "lucide-react-native";
import { usePalette } from "../../theme.ts";
import { Press } from "../Press.tsx";
import { useChrome } from "./useChrome.ts";

export function Checkbox(props: { checked: boolean; disabled?: boolean; label: string; onChange: (on: boolean) => void }) {
  const p = usePalette();
  const c = useChrome();
  return (
    <Press
      onPress={() => props.onChange(!props.checked)}
      disabled={props.disabled}
      hitSlop={13}
      accessibilityRole="checkbox"
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.checked, disabled: !!props.disabled }}
      android_ripple={{ color: c.accent, borderless: true, radius: 22 }}
      style={[
        styles.box,
        { borderColor: props.checked ? p.accent : c.input, backgroundColor: props.checked ? p.accent : c.inputFill, opacity: props.disabled ? 0.64 : 1 },
      ]}
    >
      <View style={styles.mark}>{props.checked ? <CheckIcon size={14} color={p.onAccent} /> : null}</View>
    </Press>
  );
}

const styles = StyleSheet.create({
  box: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  mark: { alignItems: "center", justifyContent: "center" },
});
