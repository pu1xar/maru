// The maru mark, the web's line form (components/MaruMark.tsx) drawn as rectangles (lib/maruMark.ts
// has the geometry and why), in the given color.
import { useMemo } from "react";
import { View } from "react-native";
import { markRects } from "../../lib/maruMark.ts";

export function MaruMark(props: { size: number; color: string }) {
  const { size, color } = props;
  const rects = useMemo(() => markRects(), []);
  return (
    <View style={{ width: size, height: size }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {rects.map((r, i) => (
        <View
          key={i}
          style={{ position: "absolute", left: r.left * size, top: r.top * size, width: r.width * size, height: r.height * size, backgroundColor: color }}
        />
      ))}
    </View>
  );
}
