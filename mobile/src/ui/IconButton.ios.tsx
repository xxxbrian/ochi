import { Pressable, View } from 'react-native';
import { Button, Host, RNHostView } from '@expo/ui/swift-ui';
import { accessibilityLabel, buttonBorderShape, buttonStyle, disabled as disable, frame, tint } from '@expo/ui/swift-ui/modifiers';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { useTheme } from '../providers/AppProvider';
import { themeColors } from '../lib/theme';
import type { IconButtonProps } from './IconButton';
import { GlassSurface } from './GlassSurface';
import { Icon } from './Icon';

export function IconButton({ icon, label, onPress, size = 44, iconSize = 22, variant = 'plain', disabled = false, color, colorScheme, style }: IconButtonProps) {
  const theme = useTheme();
  const dark = colorScheme ? colorScheme === 'dark' : theme.dark;
  const colors = colorScheme ? themeColors(dark) : theme.colors;
  const foreground = color ?? (variant === 'filled' ? dark ? '#000' : '#fff' : colors.text);
  if (variant !== 'plain' && isLiquidGlassAvailable()) {
    return <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.text} style={[{ width: size, height: size }, style]}>
      <Button onPress={onPress} modifiers={[buttonStyle(variant === 'filled' ? 'glassProminent' : 'glass'), buttonBorderShape('circle'), ...(variant === 'filled' ? [tint(colors.text)] : []), frame({ width: size, height: size }), accessibilityLabel(label), disable(disabled)]}>
        <RNHostView matchContents><View pointerEvents="none" style={{ width: iconSize, height: iconSize, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={iconSize} color={foreground} /></View></RNHostView>
      </Button>
    </Host>;
  }
  const content = <Icon name={icon} size={iconSize} color={foreground} />;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={4}
    style={({ pressed }) => [{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.35 : variant !== 'glass' && pressed ? 0.65 : 1, backgroundColor: variant === 'filled' ? colors.text : undefined }, style]}>
    {variant === 'glass' ? <GlassSurface interactive colorScheme={colorScheme} style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }}>{content}</GlassSurface> : content}
  </Pressable>;
}
