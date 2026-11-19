// A Pressable that shows the press: the Android ripple, and a faint overlay of the text color while
// held where a ripple does not draw (a borderless row inside a list). Every tappable thing in the app
// uses it, so a tap answers at once (the web's hover and active states).
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";

import { usePalette } from "../theme";

export function Press({ style, android_ripple, ...props }: PressableProps & { style?: StyleProp<ViewStyle> | ((state: { pressed: boolean }) => StyleProp<ViewStyle>) }) {
  const p = usePalette();
  return (
    <Pressable
      android_ripple={android_ripple ?? { color: p.border, foreground: true }}
      style={(state) => [typeof style === "function" ? style(state) : style, state.pressed ? { opacity: 0.85 } : null]}
      {...props}
    />
  );
}
