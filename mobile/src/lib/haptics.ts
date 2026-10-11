import { Platform } from 'react-native';
import { AndroidHaptics, performAndroidHapticsAsync, selectionAsync } from 'expo-haptics';

export async function selectionHaptic() {
  try {
    // Android's view haptic respects the system touch-feedback setting.
    if (Platform.OS === 'android') await performAndroidHapticsAsync(AndroidHaptics.Long_Press);
    else if (Platform.OS === 'ios') await selectionAsync();
  } catch {
    // Unsupported devices must still open the action menu.
  }
}
