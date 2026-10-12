import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { selectionHaptic } from '../lib/haptics';
import { AnchoredMenu, type AnchorRect, type MenuItem } from './AnchoredMenu';
import { anchorGeometryKey } from './overlayGeometry';

export type LongPressMenuProps = {
  items: MenuItem[];
  children: ReactNode;
  preview?: ReactNode;
  label?: string;
  onPress?: () => void;
  style?: ViewStyle;
  previewRadius?: number;
  selected?: boolean;
};

export function LongPressMenu({ items, children, preview, label, onPress, style, selected }: LongPressMenuProps) {
  const trigger = useRef<View>(null);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const [visible, setVisible] = useState(false);
  const longPressed = useRef(false);
  const viewport = useWindowDimensions();
  const geometry = anchorGeometryKey(viewport.width, useSafeAreaInsets());
  const measurement = useRef({ geometry, generation: 0, alive: true });
  if (measurement.current.geometry !== geometry) {
    measurement.current.geometry = geometry;
    measurement.current.generation++;
  }
  useEffect(() => {
    measurement.current.alive = true;
    return () => { measurement.current.alive = false; measurement.current.generation++; };
  }, []);
  return (
    <>
      <Pressable ref={trigger} collapsable={false} accessibilityLabel={label}
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityState={selected === undefined ? undefined : { selected }}
        accessibilityActions={items.filter((item) => !item.disabled).map((item) => ({ name: item.key, label: item.title ?? item.label }))}
        onAccessibilityAction={({ nativeEvent }) => items.find((item) => item.key === nativeEvent.actionName && !item.disabled)?.onPress()}
        onPressIn={() => { longPressed.current = false; measurement.current.generation++; }}
        onPress={() => { if (!longPressed.current) onPress?.(); }} delayLongPress={420}
        onLongPress={() => {
          longPressed.current = true;
          void selectionHaptic();
          const generation = measurement.current.generation;
          trigger.current?.measureInWindow((x, y, width, height) => {
            if (!measurement.current.alive || measurement.current.generation !== generation || width <= 0 || height <= 0) return;
            setAnchor({ x, y, width, height }); setVisible(true);
          });
        }}
        style={[style, visible && styles.hidden]}>
        {children}
      </Pressable>
      <AnchoredMenu visible={visible} onClose={() => setVisible(false)} anchor={anchor} items={items}
        align="end" width={220} preview={preview ?? children} />
    </>
  );
}

const styles = StyleSheet.create({ hidden: { opacity: 0 } });
