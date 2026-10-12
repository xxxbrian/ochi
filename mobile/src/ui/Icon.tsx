import type { LucideIcon } from 'lucide-react-native';
import { useTheme } from '../providers/AppProvider';

export function Icon({ name: Glyph, size = 22, color, strokeWidth = 1.8 }: { name: LucideIcon; size?: number; color?: string; strokeWidth?: number }) {
  const { colors } = useTheme();
  return <Glyph size={size} color={color ?? colors.text} strokeWidth={strokeWidth} />;
}
