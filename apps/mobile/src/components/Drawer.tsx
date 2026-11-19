// The session drawer, as in Claude's app: it slides over the conversation from the left (the menu
// button or a swipe from the left edge) and closes on the scrim, a swipe back, or Android back. Its
// surface is the web sidebar's (--sidebar).
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Animated, BackHandler, Easing, PanResponder, StyleSheet, useWindowDimensions, View } from "react-native";
import { TextScopeProvider } from "../appearance.tsx";
import { usePalette } from "../theme.ts";
import { Press } from "./Press.tsx";
import { useSidebarColors } from "./sidebar/useSidebarColors.ts";

export function Drawer(props: { open: boolean; onOpen: () => void; onClose: () => void; children: ReactNode }) {
  const { open, onOpen, onClose } = props;
  const p = usePalette();
  const sc = useSidebarColors();
  const { width: screen } = useWindowDimensions();
  const width = Math.min(screen * 0.86, 380);
  const x = useRef(new Animated.Value(open ? 0 : -width)).current;

  useEffect(() => {
    Animated.timing(x, { toValue: open ? 0 : -width, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [open, width, x]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [open, onClose]);

  const closeSwipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => g.dx < -12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderMove: (_e, g) => x.setValue(Math.min(0, g.dx)),
        onPanResponderRelease: (_e, g) => {
          if (g.dx < -width / 3 || g.vx < -0.5) onClose();
          else Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
        },
      }),
    [onClose, width, x],
  );
  const openSwipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => g.dx > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderMove: (_e, g) => x.setValue(Math.min(0, -width + g.dx)),
        onPanResponderRelease: (_e, g) => {
          if (g.dx > width / 3 || g.vx > 0.5) onOpen();
          else Animated.timing(x, { toValue: -width, duration: 150, useNativeDriver: true }).start();
        },
      }),
    [onOpen, width, x],
  );

  const scrim = x.interpolate({ inputRange: [-width, 0], outputRange: [0, 1], extrapolate: "clamp" });
  return (
    <>
      {!open ? <View style={styles.edge} {...openSwipe.panHandlers} /> : null}
      <Animated.View pointerEvents={open ? "auto" : "none"} style={[StyleSheet.absoluteFill, { backgroundColor: p.scrim, opacity: scrim }]}>
        <Press style={StyleSheet.absoluteFill} onPress={onClose} android_ripple={{ color: "transparent" }} accessibilityLabel="Close session list" />
      </Animated.View>
      <Animated.View
        {...closeSwipe.panHandlers}
        style={[styles.panel, { width, backgroundColor: sc.bg, borderRightColor: p.border, transform: [{ translateX: x }] }]}
      >
        <TextScopeProvider scope="sidebar">{props.children}</TextScopeProvider>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  edge: { position: "absolute", left: 0, top: 0, bottom: 0, width: 18 },
  panel: { position: "absolute", left: 0, top: 0, bottom: 0, borderRightWidth: StyleSheet.hairlineWidth, elevation: 12 },
});
