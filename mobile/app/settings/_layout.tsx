import { Stack } from 'expo-router';
import { useTheme } from '../../src/providers/AppProvider';

export default function SettingsLayout() {
  const { colors } = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.surface }, animation: 'slide_from_right', gestureEnabled: true }}>
    <Stack.Screen name="index" options={{ animation: 'none' }} />
  </Stack>;
}
