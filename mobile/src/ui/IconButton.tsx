import { Pressable, StyleSheet, type ViewStyle } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { useTheme } from '../providers/AppProvider';
import { themeColors } from '../lib/theme';
import { GlassSurface } from './GlassSurface';
import { Icon } from './Icon';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type IconButtonProps = {
  icon: LucideIcon; label: string; onPress?: () => void; size?: number; iconSize?: number;
  variant?: 'plain' | 'glass' | 'filled'; disabled?: boolean; color?: string; style?: ViewStyle;
  colorScheme?: 'light' | 'dark';
};
export function IconButton({ icon, label, onPress, size = 44, iconSize = 22, variant = 'plain', disabled = false, color, colorScheme, style }: IconButtonProps) {
  const theme = useTheme();
  const dark = colorScheme ? colorScheme === 'dark' : theme.dark;
  const colors = colorScheme ? themeColors(dark) : theme.colors;
  const scale = useSharedValue(1);
  const reducedMotion = useReducedMotion();
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const settle = (value: number) => { if (variant === 'filled' && !reducedMotion) scale.value = withSpring(value, { stiffness: 390, damping: 27, mass: 0.65 }); };
  const content = <Icon name={icon} size={iconSize} color={color ?? (variant === 'filled' ? dark ? '#000' : '#fff' : colors.text)} />;
  return (
    <AnimatedPressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={4}
      onPressIn={() => settle(1.06)} onPressOut={() => settle(1)}
      style={[styles.button, { width: size, height: size, borderRadius: size / 2, opacity: disabled ? 0.35 : 1,
        backgroundColor: variant === 'filled' ? colors.text : undefined }, style, pressStyle]}>
      {variant === 'glass' ? <GlassSurface interactive colorScheme={colorScheme} style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }}>{content}</GlassSurface> : content}
    </AnimatedPressable>
  );
}
const styles = StyleSheet.create({ button: { alignItems: 'center', justifyContent: 'center' } });
