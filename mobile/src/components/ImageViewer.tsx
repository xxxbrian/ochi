import { useCallback, useEffect, useRef, useState } from "react";
import { Image, Keyboard, Modal, Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Info, Share2, X } from "lucide-react-native";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { Easing, cancelAnimation, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { SafeAreaListener, useSafeAreaInsets, type Metrics } from "react-native-safe-area-context";
import { fileURL, resourceHeaders } from "../lib/api";
import type { Artifact } from "../lib/types";
import { useTheme } from "../providers/AppProvider";
import { IconButton } from "../ui/IconButton";
import { fileSize, shareArtifact } from "./artifactFiles";
import { ZoomImage } from "./ZoomImage";
import { modalOrientations } from "../ui/overlayGeometry";

export type ImageRect = { x: number; y: number; width: number; height: number; radius: number };
export type ImageOrigin = {
  rect: ImageRect;
  aspectRatio?: number;
  measure?: (done: (rect: ImageRect | null) => void) => void;
};

function visibleRect(rect: ImageRect | null | undefined, width: number, height: number): rect is ImageRect {
  return Boolean(rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0 && rect.x < width && rect.y < height
    && rect.x + rect.width > 0 && rect.y + rect.height > 0);
}

export function measureImageOrigin(view: View | null, radius: number, done: (origin?: ImageOrigin) => void, aspectRatio?: number) {
  if (!view) { done(); return; }
  const measure = (callback: (rect: ImageRect | null) => void) => {
    view.measureInWindow((x, y, width, height) => callback(width > 0 && height > 0 ? { x, y, width, height, radius } : null));
  };
  measure((rect) => done(rect ? { rect, aspectRatio, measure } : undefined));
}

export function ImageViewer({ file, origin, onClose, onTransitionActive }: {
  file: Artifact; origin?: ImageOrigin; onClose: () => void; onTransitionActive?: (active: boolean) => void;
}) {
  const viewport = useWindowDimensions();
  const parentInsets = useSafeAreaInsets();
  const geometry = `${viewport.width}:${viewport.height}`;
  const modalGeometry = useRef(geometry);
  modalGeometry.current = geometry;
  const [modalMetrics, setModalMetrics] = useState(() => ({ geometry, frame: { x: 0, y: 0, width: viewport.width, height: viewport.height }, insets: parentInsets }));
  const insets = modalMetrics.geometry === geometry ? modalMetrics.insets : parentInsets;
  const canvas = modalMetrics.geometry === geometry ? modalMetrics.frame : viewport;
  const updateModalMetrics = useCallback(({ frame, insets }: Metrics) => {
    if (modalGeometry.current !== geometry || frame.width <= 0 || frame.height <= 0) return;
    // Android's fullscreen Dialog includes system bars excluded by the Activity.
    setModalMetrics((current) => current.geometry === geometry && current.frame.width === frame.width && current.frame.height === frame.height
      && current.insets.top === insets.top && current.insets.bottom === insets.bottom && current.insets.left === insets.left && current.insets.right === insets.right
      ? current : { geometry, frame, insets });
  }, [geometry]);
  const { fonts } = useTheme();
  const reducedMotion = useReducedMotion();
  const [ratio, setRatio] = useState(file.generation?.width && file.generation.height ? file.generation.width / file.generation.height : origin?.aspectRatio ?? 1);
  const [showInfo, setShowInfo] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState("");
  const [presented, setPresented] = useState(Platform.OS !== "android");
  const initialViewport = useRef({ width: viewport.width, height: viewport.height });
  const previousViewport = useRef({ width: viewport.width, height: viewport.height });
  const currentViewport = useRef({ width: viewport.width, height: viewport.height });
  currentViewport.current = { width: viewport.width, height: viewport.height };
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onTransitionActiveRef = useRef(onTransitionActive);
  onTransitionActiveRef.current = onTransitionActive;
  const revealFrame = useRef(0);
  const closeFrame = useRef(0);
  const completeClose = useCallback(() => {
    onTransitionActiveRef.current?.(false);
    // Commit the aligned thumbnail before removing the native modal surface.
    revealFrame.current = requestAnimationFrame(() => {
      closeFrame.current = requestAnimationFrame(() => onCloseRef.current());
    });
  }, []);
  const closing = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progress = useSharedValue(0);
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const target = {
    x: insets.left, y: insets.top + 64,
    width: Math.max(1, canvas.width - insets.left - insets.right),
    height: Math.max(1, canvas.height - insets.top - insets.bottom - 72), radius: 0,
  };
  const sourceRect = useSharedValue<ImageRect>(visibleRect(origin?.rect, viewport.width, viewport.height) ? origin.rect : target);
  const morph = useSharedValue(visibleRect(origin?.rect, viewport.width, viewport.height));
  useEffect(() => {
    // The underlying thumbnail and active gesture coordinates reflow on rotation.
    if (previousViewport.current.width === viewport.width && previousViewport.current.height === viewport.height) return;
    previousViewport.current = { width: viewport.width, height: viewport.height };
    morph.value = false;
    cancelAnimation(dragX); cancelAnimation(dragY);
    dragX.value = 0; dragY.value = 0;
    if (!closing.current) { cancelAnimation(progress); progress.value = 1; }
  }, [viewport.width, viewport.height, morph, dragX, dragY, progress]);

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    cancelAnimationFrame(revealFrame.current);
    cancelAnimationFrame(closeFrame.current);
    onTransitionActiveRef.current?.(false);
  }, []);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    // Android's Dialog copies Activity status-bar appearance when it is shown.
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setPresented(true));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, []);

  const open = () => {
    onTransitionActiveRef.current?.(true);
    Keyboard.dismiss();
    if (!origin?.aspectRatio && !(file.generation?.width && file.generation.height)) {
      Image.getSizeWithHeaders(fileURL(file), resourceHeaders(file), (w, h) => setRatio(w / Math.max(1, h)), () => undefined);
    }
    progress.value = withTiming(1, { duration: reducedMotion ? 120 : 240, easing: Easing.out(Easing.cubic) });
  };
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const closeViewport = { width: viewport.width, height: viewport.height };
    let started = false;
    const animate = (rect?: ImageRect | null) => {
      if (started) return;
      started = true;
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = null;
      const sameViewport = currentViewport.current.width === closeViewport.width && currentViewport.current.height === closeViewport.height;
      morph.value = sameViewport && visibleRect(rect, viewport.width, viewport.height);
      if (morph.value && rect) sourceRect.value = rect;
      progress.value = withTiming(0, { duration: reducedMotion ? 120 : 220, easing: Easing.out(Easing.cubic) }, (finished) => {
        if (finished) runOnJS(completeClose)();
      });
    };
    if (origin?.measure) {
      // A finished run can replace the originating native view before its measurement returns.
      closeTimer.current = setTimeout(() => animate(null), 80);
      try { origin.measure(animate); } catch { animate(null); }
    } else animate(initialViewport.current.width === viewport.width && initialViewport.current.height === viewport.height ? origin?.rect : null);
  }, [origin, completeClose, reducedMotion, progress, sourceRect, morph, viewport.width, viewport.height]);

  const backdrop = useAnimatedStyle(() => ({
    opacity: progress.value * (1 - Math.min(dragY.value / (viewport.height * 0.6), 0.7)),
  }));
  const image = useAnimatedStyle(() => {
    const p = reducedMotion ? 1 : progress.value;
    const start = morph.value ? sourceRect.value : target;
    const shrink = 1 - Math.min(dragY.value / viewport.height, 0.4) * 0.65 * progress.value;
    return {
      left: start.x + (target.x - start.x) * p,
      top: start.y + (target.y - start.y) * p,
      width: start.width + (target.width - start.width) * p,
      height: start.height + (target.height - start.height) * p,
      borderRadius: start.radius * (1 - p),
      opacity: !morph.value || reducedMotion ? progress.value : 1,
      transform: [{ translateX: dragX.value * progress.value }, { translateY: dragY.value * progress.value }, { scale: shrink }],
    };
  });
  const chrome = useAnimatedStyle(() => ({
    opacity: progress.value * (1 - Math.min(dragY.value / 100, 1)),
  }));
  async function share() {
    if (sharing) return;
    setSharing(true); setError("");
    try { await shareArtifact(file); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "下载失败"); }
    finally { setSharing(false); }
  }
  const generation = file.generation;
  return (
    <>
      <StatusBar style="light" />
      <Modal visible={presented} transparent animationType="none" presentationStyle="overFullScreen" onShow={open} onRequestClose={close} statusBarTranslucent navigationBarTranslucent supportedOrientations={modalOrientations}>
      <SafeAreaListener style={styles.root} onChange={updateModalMetrics}>
      <GestureHandlerRootView style={styles.root}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.black, backdrop]} />
        <Animated.View style={[styles.image, image]}>
          <ZoomImage file={file} imageRatio={ratio} transitionProgress={progress} dragX={dragX} dragY={dragY} onDismiss={close} />
        </Animated.View>
        <Animated.View style={[styles.toolbar, { top: insets.top + 8, left: insets.left + 14, right: insets.right + 14 }, chrome]}>
          <IconButton icon={X} label="关闭图片" onPress={close} variant="glass" colorScheme="dark" size={44} />
          <View style={{ flex: 1 }} />
          <IconButton icon={Info} label="图片信息" onPress={() => setShowInfo(!showInfo)} variant="glass" colorScheme="dark" size={44} />
          <IconButton icon={Share2} label="下载或分享" onPress={() => void share()} variant="glass" colorScheme="dark" size={44} disabled={sharing} />
        </Animated.View>
        {showInfo && (
          <Animated.View style={[styles.info, { top: insets.top + 64, left: insets.left + 14, right: insets.right + 14, maxHeight: Math.min(canvas.height * 0.36, target.height) }, chrome]}>
            <ScrollView contentContainerStyle={styles.infoContent}>
              <Text style={[styles.infoTitle, { fontFamily: fonts.medium }]}>{generation ? "生成信息" : file.name}</Text>
              {generation && <Text selectable style={[styles.prompt, { fontFamily: fonts.regular }]}>{generation.prompt}</Text>}
              {generation?.revised_prompt && generation.revised_prompt !== generation.prompt && <Text selectable style={[styles.meta, { fontFamily: fonts.regular }]}>{generation.revised_prompt}</Text>}
              <Text style={[styles.meta, { fontFamily: fonts.regular }]}>{[generation?.model_name || generation?.model_id, generation?.size, generation?.quality, generation?.output_format, fileSize(file.size)].filter(Boolean).join(" · ")}</Text>
            </ScrollView>
          </Animated.View>
        )}
        {Boolean(error) && <Text accessibilityRole="alert" style={[styles.error, { bottom: insets.bottom + 18, left: insets.left + 20, right: insets.right + 20, fontFamily: fonts.regular }]}>{error}</Text>}
      </GestureHandlerRootView>
      </SafeAreaListener>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 }, black: { backgroundColor: "#000" },
  image: { position: "absolute", overflow: "hidden" },
  toolbar: { position: "absolute", flexDirection: "row", alignItems: "center", gap: 10 },
  info: { position: "absolute", borderRadius: 20, backgroundColor: "#1c1c1cf2", borderWidth: StyleSheet.hairlineWidth, borderColor: "#ffffff30", overflow: "hidden" },
  infoContent: { padding: 16, gap: 9 }, infoTitle: { color: "#fff", fontSize: 15 }, prompt: { color: "#e8e8e8", fontSize: 14, lineHeight: 21 }, meta: { color: "#a5a5a5", fontSize: 12, lineHeight: 18 },
  error: { position: "absolute", color: "#ff9999", textAlign: "center", fontSize: 14 },
});
