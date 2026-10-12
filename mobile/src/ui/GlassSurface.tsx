import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren, type ReactNode, type RefObject } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View, type ViewProps } from 'react-native';
import { BlurTargetView, BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated';
import { useTheme } from '../providers/AppProvider';
import { themeColors } from '../lib/theme';

const BlurTarget = createContext<RefObject<View | null> | undefined>(undefined);

export function BlurScene({ children, overlay, style, blurEnabled = true }: PropsWithChildren<{ overlay?: ReactNode; style?: ViewProps['style']; blurEnabled?: boolean }>) {
  const target = useRef<View | null>(null);
  return (
    <BlurTarget.Provider value={blurEnabled ? target : undefined}>
      <View style={[styles.scene, style]}>
        {/* Live Android sampling re-draws the native transcript on every frame. */}
        {blurEnabled ? <BlurTargetView ref={target} style={styles.scene}>{children}</BlurTargetView> : <View style={styles.scene}>{children}</View>}
        {overlay}
      </View>
    </BlurTarget.Provider>
  );
}

export function GlassSurface({ children, style, interactive = false, colorScheme, ...props }: ViewProps & { interactive?: boolean; colorScheme?: 'light' | 'dark' }) {
  const theme = useTheme();
  const dark = colorScheme ? colorScheme === 'dark' : theme.dark;
  const colors = colorScheme ? themeColors(dark) : theme.colors;
  const target = useContext(BlurTarget);
  const [reducedTransparency, setReducedTransparency] = useState(false);
  const reducedMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  useEffect(() => {
    void AccessibilityInfo.isReduceTransparencyEnabled().then(setReducedTransparency);
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReducedTransparency);
    return () => subscription.remove();
  }, []);

  if (Platform.OS === 'ios' && isLiquidGlassAvailable() && !reducedTransparency) {
    return <GlassView {...props} style={[styles.glass, style]} glassEffectStyle="regular" colorScheme={dark ? 'dark' : 'light'} isInteractive={interactive}>{children}</GlassView>;
  }

  const canBlur = !reducedTransparency && (Platform.OS === 'ios' || (Platform.OS === 'android' && Boolean(target)));
  const settle = (value: number) => {
    if (interactive && !reducedMotion) scale.value = withSpring(value, { stiffness: 390, damping: 27, mass: 0.65 });
  };
  return (
    <Animated.View {...props} onTouchStart={(event) => { settle(1.035); props.onTouchStart?.(event); }} onTouchEnd={(event) => { settle(1); props.onTouchEnd?.(event); }} onTouchCancel={(event) => { settle(1); props.onTouchCancel?.(event); }} style={[styles.glass, { backgroundColor: reducedTransparency || !canBlur ? colors.raised : dark ? '#242424e8' : '#ffffffd9', borderWidth: StyleSheet.hairlineWidth, borderColor: dark ? '#ffffff1c' : '#00000020', boxShadow: dark ? '0px 1px 4px rgba(0,0,0,0.12)' : '0px 2px 8px rgba(0,0,0,0.06)' }, style, pressStyle]}>
      {canBlur && <BlurView pointerEvents="none" style={StyleSheet.absoluteFill} blurTarget={target} blurMethod="dimezisBlurViewSdk31Plus" tint={dark ? 'dark' : 'light'} intensity={55} />}
      {canBlur && !dark && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#ffffff33' }]} />}
      {/* A bright sampled image must not wash out Android's dark material. */}
      {canBlur && Platform.OS === 'android' && dark && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#181818e0' }]} />}
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({ scene: { flex: 1 }, glass: { borderRadius: 24, overflow: 'hidden' } });
