// The web's Button (components/ui/button.tsx) for the variants and sizes the chrome uses. A border
// of 1, the control radius, font-medium, 64% opacity while disabled; the web's inset highlight and
// 5% shadow have no React Native form and are left out. The touch target is 44 around a smaller
// button (the web's pointer-coarse hit area).
import type { ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Text } from "./Text.tsx";
import { usePalette } from "../../theme.ts";
import { Press } from "../Press.tsx";
import { CONTROL_RADIUS, ui } from "./metrics.ts";
import { useChrome } from "./useChrome.ts";

export type BtnVariant = "default" | "outline" | "destructive" | "destructive-outline" | "ghost" | "ghost-muted";
export type BtnSize = "default" | "sm" | "xs" | "icon";

/** Heights and paddings of ui/button.tsx at phone width (h-9, h-8, h-7, size-9; padding is the step minus the border). */
const SIZE = {
  default: { minHeight: 36, paddingHorizontal: 11, font: ui.base },
  sm: { minHeight: 32, paddingHorizontal: 9, font: ui.base },
  xs: { minHeight: 28, paddingHorizontal: 7, font: ui.sm },
  icon: { minHeight: 36, paddingHorizontal: 0, font: ui.base },
} as const;

export function Btn(props: {
  label?: string;
  icon?: ReactNode;
  variant?: BtnVariant;
  size?: BtnSize;
  busy?: boolean;
  disabled?: boolean;
  fill?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  onPress: () => void;
}) {
  const p = usePalette();
  const c = useChrome();
  const variant = props.variant ?? "default";
  const size = SIZE[props.size ?? "default"];
  const look = {
    default: { bg: p.accent, border: p.accent, fg: p.onAccent },
    outline: { bg: c.outlineFill, border: c.input, fg: p.text },
    destructive: { bg: p.danger, border: p.danger, fg: c.onDestructive },
    "destructive-outline": { bg: c.outlineFill, border: c.input, fg: c.errorForeground },
    ghost: { bg: "transparent", border: "transparent", fg: p.text },
    "ghost-muted": { bg: "transparent", border: "transparent", fg: p.muted },
  }[variant];
  const off = props.disabled || props.busy;
  return (
    <Press
      onPress={props.onPress}
      disabled={off}
      hitSlop={props.size === "xs" ? 8 : 4}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: !!off, busy: !!props.busy }}
      android_ripple={{ color: variant.startsWith("ghost") || variant.endsWith("outline") ? c.accent : p.border, foreground: true }}
      style={[
        styles.base,
        {
          minHeight: size.minHeight,
          paddingHorizontal: size.paddingHorizontal,
          width: props.size === "icon" ? 36 : props.fill ? "100%" : undefined,
          backgroundColor: look.bg,
          borderColor: look.border,
          opacity: off ? 0.64 : 1,
        },
        props.style,
      ]}
    >
      {props.busy ? (
        <ActivityIndicator size="small" color={look.fg} />
      ) : (
        <View style={styles.row}>
          {props.icon}
          {props.label ? <Text style={[size.font, { color: look.fg, fontWeight: "500" }]}>{props.label}</Text> : null}
        </View>
      )}
    </Press>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: CONTROL_RADIUS, borderWidth: 1, alignItems: "center", justifyContent: "center", overflow: "hidden", alignSelf: "flex-start" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
});
