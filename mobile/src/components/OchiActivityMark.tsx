import { memo, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { useTheme } from "../providers/AppProvider";
import { AppText } from "./ScreenChrome";

export function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (alive) setReduced(value); });
    const listener = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => { alive = false; listener.remove(); };
  }, []);
  return reduced;
}

export function ActivityDisclosure({ open, color, size = 13 }: { open: boolean; color: string; size?: number }) {
  const reduced = useReducedMotion();
  const rotation = useRef(new Animated.Value(open ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) { rotation.setValue(open ? 1 : 0); return; }
    const animation = Animated.timing(rotation, { toValue: open ? 1 : 0, duration: 180, easing: Easing.inOut(Easing.quad), useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [open, reduced, rotation]);
  return <Animated.View accessible={false} style={{ transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "90deg"] }) }] }}>
    <ChevronRight size={size} color={color} />
  </Animated.View>;
}

export const OchiActivityMark = memo(function OchiActivityMark({ working }: { working: boolean }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const pose = useRef(new Animated.Value(0)).current;
  const blink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    pose.setValue(0);
    blink.setValue(1);
    if (!working || reduced) return;
    const ease = Easing.inOut(Easing.cubic);
    const movement = Animated.loop(Animated.sequence([
      Animated.timing(pose, { toValue: 1, duration: 1000, easing: ease, useNativeDriver: true }),
      Animated.delay(300),
      Animated.timing(pose, { toValue: -1, duration: 1600, easing: ease, useNativeDriver: true }),
      Animated.delay(250),
      Animated.timing(pose, { toValue: 0, duration: 1050, easing: ease, useNativeDriver: true }),
      Animated.delay(700),
    ]));
    const eyes = Animated.loop(Animated.sequence([
      Animated.delay(1900),
      Animated.timing(blink, { toValue: 0.16, duration: 90, useNativeDriver: true }),
      Animated.timing(blink, { toValue: 1, duration: 150, useNativeDriver: true }),
      Animated.delay(3600),
    ]));
    movement.start();
    eyes.start();
    return () => { movement.stop(); eyes.stop(); };
  }, [working, reduced, pose, blink]);
  return (
    <View style={styles.markSpace} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={[styles.face, { backgroundColor: colors.text, transform: [
        { translateX: pose.interpolate({ inputRange: [-1, 0, 1], outputRange: [-2.5, 0, 2.5] }) },
        { translateY: pose.interpolate({ inputRange: [-1, 0, 1], outputRange: [-1.5, 0, -2.5] }) },
        { rotate: pose.interpolate({ inputRange: [-1, 0, 1], outputRange: ["-12deg", "0deg", "12deg"] }) },
      ] }]}>
        <Animated.View style={[styles.eyes, { transform: [
          { translateX: pose.interpolate({ inputRange: [-1, 1], outputRange: [-1.3, 1.3] }) },
          { scaleY: blink },
        ] }]}>
          <View style={[styles.eye, { backgroundColor: colors.canvas }]} />
          <View style={[styles.eye, { backgroundColor: colors.canvas }]} />
        </Animated.View>
      </Animated.View>
    </View>
  );
});

// A native-driven light band moves over a duplicate label, never over model prose.
export const ActivityStatusText = memo(function ActivityStatusText({ children, working }: { children: string; working: boolean }) {
  const { colors, fonts } = useTheme();
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const sweep = useRef(new Animated.Value(-48)).current;
  useEffect(() => {
    sweep.setValue(-48);
    if (!working || reduced || !width) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(5800),
      Animated.timing(sweep, { toValue: width + 48, duration: 2200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(sweep, { toValue: -48, duration: 0, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [working, reduced, width, sweep]);
  const inverse = Animated.multiply(sweep, -1);
  return (
    <View onLayout={(event) => {
      const measuredWidth = event.nativeEvent.layout.width;
      setWidth((previous) => previous === measuredWidth ? previous : measuredWidth);
    }} style={styles.status}>
      <AppText muted size={13}>{children}</AppText>
      {working && !reduced && width > 0 && <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.lightBand, { transform: [{ translateX: sweep }] }]}>
        {[{ left: 0, width: 44, opacity: 0.2 }, { left: 7, width: 30, opacity: 0.35 }, { left: 14, width: 16, opacity: 0.65 }].map((band) => (
          <View key={band.width} style={[styles.bandClip, band]}>
            <Animated.Text numberOfLines={1} style={{ width, color: colors.text, fontFamily: fonts.regular, fontSize: 13, lineHeight: 13 * 1.45, left: -band.left, transform: [{ translateX: inverse }] }}>{children}</Animated.Text>
          </View>
        ))}
      </Animated.View>}
    </View>
  );
});

const styles = StyleSheet.create({
  markSpace: { width: 24, height: 25, alignItems: "center", justifyContent: "center" },
  face: { width: 19, height: 19, borderRadius: 6.5, alignItems: "center", justifyContent: "center" },
  eyes: { flexDirection: "row", gap: 4.5 },
  eye: { width: 2.7, height: 6, borderRadius: 2 },
  status: { overflow: "hidden" },
  lightBand: { position: "absolute", top: 0, bottom: 0, left: 0, width: 44, overflow: "hidden" },
  bandClip: { position: "absolute", top: 0, bottom: 0, overflow: "hidden" },
});
