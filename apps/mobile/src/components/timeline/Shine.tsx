// The running state of a live line. The web sweeps a light band across the label (index.css
// live-tool-shine, live-activity-focus); a band needs a gradient mask, which React Native has only
// through a native module, so the label breathes between 45% and full strength instead.
import { useEffect, useRef, type ReactNode } from "react";
import { Animated, type StyleProp, type ViewStyle } from "react-native";

export function Shine({ active, children, style }: { active: boolean; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.45, duration: 1000, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, opacity]);
  return <Animated.View style={[{ opacity }, style]}>{children}</Animated.View>;
}
