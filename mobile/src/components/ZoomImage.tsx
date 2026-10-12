import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Platform, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  runOnJS,
  cancelAnimation,
  type SharedValue,
} from "react-native-reanimated";
import type { Artifact } from "../lib/types";
import { fileURL, resourceHeaders, imageSource } from "../lib/api";
import { useTheme } from "../providers/AppProvider";

export function ZoomImage({ file, imageRatio, transitionProgress, dragX, dragY, onDismiss }: {
  file: Artifact;
  imageRatio?: number;
  transitionProgress?: SharedValue<number>;
  dragX?: SharedValue<number>;
  dragY?: SharedValue<number>;
  onDismiss?: () => void;
}) {
  const { fonts } = useTheme();
  const reducedMotion = useReducedMotion();
  const viewport = useWindowDimensions();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [ratio, setRatio] = useState(
    file.generation?.width && file.generation.height
      ? file.generation.width / file.generation.height
      : 1,
  );
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const dismiss = useCallback(() => onDismissRef.current?.(), []);
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  const dismissing = useSharedValue(false);
  const rawActive = useSharedValue(false);
  const rawStartX = useSharedValue(0);
  const rawStartY = useSharedValue(0);
  const rawLastY = useSharedValue(0);
  const rawLastTime = useSharedValue(0);
  const rawVelocityY = useSharedValue(0);
  const fitRatio = imageRatio ?? ratio;
  const fitWidth = Math.min(size.width, size.height * fitRatio);
  const fitHeight = Math.min(size.height, size.width / fitRatio);
  useEffect(() => {
    cancelAnimation(scale); cancelAnimation(x); cancelAnimation(y);
    scale.value = 1; savedScale.value = 1;
    x.value = 0; y.value = 0; savedX.value = 0; savedY.value = 0;
    rawActive.value = false; dismissing.value = false;
    if (dragX) { cancelAnimation(dragX); dragX.value = 0; }
    if (dragY) { cancelAnimation(dragY); dragY.value = 0; }
  }, [viewport.width, viewport.height, scale, savedScale, x, y, savedX, savedY, rawActive, dismissing, dragX, dragY]);
  useEffect(() => {
    if (imageRatio || (file.generation?.width && file.generation.height)) return;
    Image.getSizeWithHeaders(
      fileURL(file),
      resourceHeaders(file),
      (width, height) => setRatio(width / Math.max(1, height)),
      () => undefined,
    );
  }, [file.url, imageRatio]);
  function bounded(
    value: number,
    extent: number,
    viewport: number,
    zoom: number,
  ) {
    "worklet";
    const limit = Math.max(0, (extent * zoom - viewport) / 2);
    return Math.min(limit, Math.max(-limit, value));
  }
  const gestures = useMemo(() => {
  function updatePan(dx: number, dy: number) {
    "worklet";
    if (transitionProgress && transitionProgress.value < 0.98) return;
    if (scale.value <= 1.01) {
      if (dragX) dragX.value = dx * 0.65;
      if (dragY) dragY.value = Math.max(0, dy);
    } else {
      x.value = bounded(savedX.value + dx, fitWidth, size.width, scale.value);
      y.value = bounded(savedY.value + dy, fitHeight, size.height, scale.value);
    }
  }
  function endPan(velocityY: number) {
    "worklet";
    if (scale.value <= 1.01 && dragY && (dragY.value > 90 || (dragY.value > 20 && velocityY > 800))) {
      dismissing.value = true;
      runOnJS(dismiss)();
    }
    savedX.value = x.value;
    savedY.value = y.value;
  }
  function resetPan() {
    "worklet";
    rawActive.value = false;
    rawStartX.value = 0;
    rawStartY.value = 0;
    rawLastY.value = 0;
    rawLastTime.value = 0;
    rawVelocityY.value = 0;
    savedX.value = x.value;
    savedY.value = y.value;
    if (!dismissing.value) {
      if (dragX) dragX.value = reducedMotion ? withTiming(0, { duration: 120 }) : withSpring(0, { stiffness: 310, damping: 28 });
      if (dragY) dragY.value = reducedMotion ? withTiming(0, { duration: 120 }) : withSpring(0, { stiffness: 310, damping: 28 });
    }
  }
  const pinch = Gesture.Pinch()
    .onStart(() => {
      if (dragX) dragX.value = 0;
      if (dragY) dragY.value = 0;
    })
    .onUpdate((event) => {
      const next = Math.max(1, Math.min(5, savedScale.value * event.scale));
      scale.value = next;
      x.value = bounded(x.value, fitWidth, size.width, next);
      y.value = bounded(y.value, fitHeight, size.height, next);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      savedX.value = x.value;
      savedY.value = y.value;
    });
  const pan = Gesture.Pan()
    .minDistance(6)
    .enableTrackpadTwoFingerGesture(true)
    .maxPointers(1)
    .onStart(() => { dismissing.value = false; })
    .onUpdate((event) => updatePan(event.translationX, event.translationY))
    .onEnd((event) => endPan(event.velocityY))
    .onFinalize(resetPan);
  // Raw coordinates keep dragging responsive when the tested iOS Simulator omits Pan updates.
  const iosPan = Gesture.Manual()
    .onTouchesDown((event, manager) => {
      const point = event.allTouches[0];
      if (event.numberOfTouches !== 1 || !point) { manager.fail(); return; }
      dismissing.value = false;
      rawActive.value = false;
      rawStartX.value = point.absoluteX;
      rawStartY.value = point.absoluteY;
      rawLastY.value = point.absoluteY;
      rawLastTime.value = Date.now();
      rawVelocityY.value = 0;
    })
    .onTouchesMove((event, manager) => {
      const point = event.allTouches[0];
      if (event.numberOfTouches !== 1 || !point) { manager.fail(); return; }
      const dx = point.absoluteX - rawStartX.value;
      const dy = point.absoluteY - rawStartY.value;
      const now = Date.now();
      const elapsed = now - rawLastTime.value;
      if (elapsed > 0) rawVelocityY.value = (point.absoluteY - rawLastY.value) * 1000 / elapsed;
      rawLastY.value = point.absoluteY;
      rawLastTime.value = now;
      if (!rawActive.value && dx * dx + dy * dy >= 36) {
        rawActive.value = true;
        manager.activate();
      }
      if (rawActive.value) updatePan(dx, dy);
    })
    .onTouchesUp((_event, manager) => {
      if (!rawActive.value) { manager.fail(); return; }
      const velocity = Date.now() - rawLastTime.value < 150 && Number.isFinite(rawVelocityY.value) ? rawVelocityY.value : 0;
      endPan(velocity);
      manager.end();
    })
    .onTouchesCancelled((_event, manager) => { manager.fail(); })
    .onFinalize(resetPan);
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((event, success) => {
      if (!success) return;
      const next = scale.value > 1.2 ? 1 : 2.5;
      savedScale.value = next;
      savedX.value =
        next === 1
          ? 0
          : bounded(
              (size.width / 2 - event.x) * (next - 1),
              fitWidth,
              size.width,
              next,
            );
      savedY.value =
        next === 1
          ? 0
          : bounded(
              (size.height / 2 - event.y) * (next - 1),
              fitHeight,
              size.height,
              next,
            );
      scale.value = withSpring(next, { stiffness: 290, damping: 29 });
      x.value = withSpring(savedX.value, { stiffness: 290, damping: 29 });
      y.value = withSpring(savedY.value, { stiffness: 290, damping: 29 });
    });
  return Gesture.Simultaneous(pinch, Platform.OS === "ios" ? iosPan : pan, doubleTap);
  }, [dragX, dragY, transitionProgress, dismiss, reducedMotion, fitWidth, fitHeight, size.width, size.height, scale, savedScale, x, y, savedX, savedY, dismissing, rawActive, rawStartX, rawStartY, rawLastY, rawLastTime, rawVelocityY]);
  const transform = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value * (transitionProgress?.value ?? 1) },
      { translateY: y.value * (transitionProgress?.value ?? 1) },
      { scale: 1 + (scale.value - 1) * (transitionProgress?.value ?? 1) },
    ],
  }));
  return (
    <GestureHandlerRootView style={styles.fill}>
      <View
        style={styles.viewport}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setSize((current) => current.width === width && current.height === height ? current : { width, height });
        }}
      >
        {/* Keep the gesture target interactive and untransformed on iOS. */}
        <GestureDetector gesture={gestures}>
          <View collapsable={false} style={styles.fill}>
            <View pointerEvents="none" style={styles.fill}>
              <Animated.Image
                accessibilityLabel={file.generation?.prompt || file.name}
                source={imageSource(file)}
                resizeMode="contain"
                onLoadEnd={() => setLoading(false)}
                onError={(event) => {
                  setLoading(false);
                  setError("无法加载图片");
                  console.warn(
                    "Ochi image preview load failed",
                    event.nativeEvent.error,
                  );
                }}
                style={[styles.fill, transform]}
              />
            </View>
          </View>
        </GestureDetector>
        {loading && (
          <ActivityIndicator
            color="#a5a5a5"
            style={StyleSheet.absoluteFill}
          />
        )}
        {error && (
          <View style={[StyleSheet.absoluteFill, { justifyContent: "center" }]}>
            <Text accessibilityRole="alert" style={{ color: "#ff9999", fontFamily: fonts.regular, fontSize: 14, textAlign: "center" }}>{error}</Text>
          </View>
        )}
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, width: "100%", height: "100%" },
  viewport: { flex: 1, overflow: "hidden" },
});
