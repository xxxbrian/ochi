import { Platform } from 'react-native';
import tokens from '../../../web/src/design/tokens.json';

export type ThemePreference = 'system' | 'light' | 'dark';
export const fonts = {
  regular: 'Geist_400Regular', medium: 'Geist_500Medium', semibold: 'Geist_600SemiBold',
  mono: Platform.OS === 'ios' ? 'SFMono-Regular' : 'monospace',
};
export { tokens };

export function themeColors(dark: boolean) {
  const palette = dark ? tokens.theme.dark : tokens.theme.light;
  return {
    canvas: dark ? '#000000' : '#ffffff',
    surface: dark ? '#111111' : '#f4f4f4',
    raised: dark ? palette.raised : '#ffffff', input: dark ? palette.field : '#ffffff',
    hover: dark ? palette.hover : '#e9e9e9',
    border: dark ? palette.line : '#dedede', text: dark ? palette.ink : '#111111',
    muted: dark ? palette.muted : '#686868', subtle: dark ? palette.subtle : '#929292',
    error: palette.danger, success: palette.success,
  };
}
export type Colors = ReturnType<typeof themeColors>;
