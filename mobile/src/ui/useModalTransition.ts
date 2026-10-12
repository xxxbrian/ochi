import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelAnimation, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

export function useModalTransition(visible: boolean, { fadeSurface = true, collapseTo }: { fadeSurface?: boolean; collapseTo?: { x: number; y: number } } = {}) {
  const [mounted, setMounted] = useState(visible);
  const lifecycle = useRef({ visible, mounted: visible, generation: 0 });
  lifecycle.current.visible = visible;
  const progress = useSharedValue(visible ? 1 : 0);
  const collapse = useSharedValue(0);
  const reducedMotion = useReducedMotion();
  const collapses = Boolean(collapseTo);
  const finishDismiss = useCallback((generation: number) => {
    // A UI-thread completion may reach JS after this menu has already reopened.
    if (lifecycle.current.generation !== generation || lifecycle.current.visible) return;
    lifecycle.current.mounted = false;
    setMounted(false);
  }, []);
  useEffect(() => {
    const generation = ++lifecycle.current.generation;
    if (visible) {
      if (collapses) collapse.value = lifecycle.current.mounted && collapse.value > 0 && !reducedMotion ? withTiming(0, { duration: 120 }) : 0;
      lifecycle.current.mounted = true;
      setMounted(true);
      progress.value = reducedMotion ? withTiming(1, { duration: 120 }) : withSpring(1, { stiffness: 300, damping: 26, mass: 0.7, overshootClamping: true });
    } else if (!lifecycle.current.mounted) {
      progress.value = 0;
      collapse.value = 0;
    } else if (collapses && !reducedMotion) {
      progress.value = withTiming(0, { duration: 200 });
      // Opaque native material must finish its geometry exit before removal.
      collapse.value = withTiming(1, { duration: 200 }, (finished) => { if (finished) runOnJS(finishDismiss)(generation); });
    } else {
      progress.value = withTiming(0, { duration: reducedMotion && !fadeSurface ? 0 : 130 }, (finished) => { if (finished) runOnJS(finishDismiss)(generation); });
    }
    return () => {
      lifecycle.current.generation++;
      cancelAnimation(progress);
      cancelAnimation(collapse);
    };
  }, [visible, progress, collapse, reducedMotion, collapses, fadeSurface, finishDismiss]);
  const backdrop = useAnimatedStyle(() => ({ opacity: progress.value }));
  const surface = useAnimatedStyle(() => ({
    opacity: fadeSurface ? progress.value : 1,
    transform: reducedMotion ? [] : collapseTo ? [
      { translateX: collapseTo.x * collapse.value },
      { translateY: (1 - progress.value) * 18 * (1 - collapse.value) + collapseTo.y * collapse.value },
      { scale: (0.97 + progress.value * 0.03) * (1 - collapse.value) + 0.01 * collapse.value },
    ] : [{ translateY: (1 - progress.value) * 18 }, { scale: 0.97 + progress.value * 0.03 }],
  }));
  return { mounted, backdrop, surface };
}
