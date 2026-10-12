import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, View, useWindowDimensions, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AnchoredMenu, type AnchorRect, type MenuItem } from './AnchoredMenu';
import { anchorGeometryKey } from './overlayGeometry';

export type MenuTriggerProps = { items: MenuItem[]; children: ReactNode; style?: ViewStyle; label?: string };

export function MenuTrigger({ items, children, style, label }: MenuTriggerProps) {
  const trigger = useRef<View>(null);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const { width: windowWidth } = useWindowDimensions();
  const geometry = anchorGeometryKey(windowWidth, useSafeAreaInsets());
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
      <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel={label} style={style} onPress={() => {
        const generation = ++measurement.current.generation;
        trigger.current?.measureInWindow((x, y, width, height) => {
          if (!measurement.current.alive || measurement.current.generation !== generation || width <= 0 || height <= 0) return;
          setAnchor({ x, y, width, height });
        });
      }}>{children}</Pressable>
      <AnchoredMenu visible={Boolean(anchor)} anchor={anchor} onClose={() => setAnchor(null)} items={items} />
    </>
  );
}
