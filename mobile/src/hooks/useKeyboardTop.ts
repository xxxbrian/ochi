import { useEffect, useState } from 'react';
import { Keyboard, Platform, type KeyboardEvent } from 'react-native';
import { useWindowDimensions } from 'react-native-keyboard-controller';

export function useKeyboardTop() {
  const { width, height } = useWindowDimensions();
  const readTop = () => Keyboard.isVisible() ? Keyboard.metrics()?.screenY ?? null : null;
  const [frame, setFrame] = useState(() => ({ top: readTop(), width, height }));
  useEffect(() => {
    const updateTop = (top: number | null) => setFrame((current) => current.top === top && current.width === width && current.height === height ? current : { top, width, height });
    const update = (event: KeyboardEvent) => updateTop(event.endCoordinates.height > 0 ? event.endCoordinates.screenY : null);
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow', update);
    const hide = Keyboard.addListener('keyboardDidHide', () => updateTop(null));
    // Wait for native window metrics after rotation rather than reuse a portrait IME frame.
    const refresh = requestAnimationFrame(() => updateTop(readTop()));
    return () => { show.remove(); hide.remove(); cancelAnimationFrame(refresh); };
  }, [width, height]);
  const top = frame.width === width && frame.height === height ? frame.top : null;
  return top !== null && Number.isFinite(top) && top >= 0 && top < height ? top : null;
}
