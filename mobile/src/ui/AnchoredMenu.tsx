import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BackHandler, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { OverKeyboardView, useWindowDimensions as useOverlayDimensions } from 'react-native-keyboard-controller';
import { GestureHandlerRootView, Pressable as GesturePressable, ScrollView as GestureScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, type LucideIcon } from 'lucide-react-native';
import { useTheme } from '../providers/AppProvider';
import { GlassSurface } from './GlassSurface';
import { Icon } from './Icon';
import Animated from 'react-native-reanimated';
import { useModalTransition } from './useModalTransition';
import { useKeyboardTop } from '../hooks/useKeyboardTop';
import { anchorGeometryKey, anchoredMenuLayout, modalOrientations } from './overlayGeometry';

export type AnchorRect = { x: number; y: number; width: number; height: number };
export type MenuItem = {
  key: string; title?: string; label?: string; subtitle?: string; icon?: LucideIcon;
  leading?: ReactNode;
  onPress: () => void; selected?: boolean; disabled?: boolean; danger?: boolean; separatorBefore?: boolean;
};

export function AnchoredMenu({ visible, onClose, anchor, items, width = 260, align = 'start', preview, preserveKeyboard = false }: {
  visible: boolean; onClose: () => void; anchor: AnchorRect | null;
  items: MenuItem[]; width?: number; align?: 'start' | 'end'; preview?: ReactNode; preserveKeyboard?: boolean;
}) {
  const { colors, fonts } = useTheme();
  const window = useWindowDimensions();
  const overlayWindow = useOverlayDimensions();
  const keyboardOverlay = preserveKeyboard && Platform.OS !== 'web';
  const androidKeyboardOverlay = keyboardOverlay && Platform.OS === 'android';
  const MenuPressable = androidKeyboardOverlay ? GesturePressable : Pressable;
  const MenuScrollView = androidKeyboardOverlay ? GestureScrollView : ScrollView;
  const viewport = keyboardOverlay ? overlayWindow : window;
  const insets = useSafeAreaInsets();
  const keyboardTop = useKeyboardTop();
  const lastAnchor = useRef(anchor);
  if (anchor) lastAnchor.current = anchor;
  const rect = anchor ?? lastAnchor.current;
  const bounds = rect ?? { x: 0, y: 0, width: 0, height: 0 };
  const [measured, setMeasured] = useState({ key: '', height: 0 });
  const contentKey = `${viewport.width}:${insets.left}:${insets.right}:${width}:${window.fontScale}:${items.map((item) => `${item.key}/${item.title ?? item.label}/${item.subtitle ?? ''}/${Boolean(item.separatorBefore)}`).join('|')}`;
  const estimate = items.reduce((height, item) => height + (item.subtitle ? 62 : 46) + (item.separatorBefore ? 10 : 0), 12);
  const layout = anchoredMenuLayout(viewport, insets, bounds, width, measured.key === contentKey ? measured.height : estimate, align, keyboardTop);
  const { left, top, width: menuWidth, height: menuHeight, safe } = layout;
  // Keep native glass ancestor alpha stable while its geometry springs into place.
  const motion = useModalTransition(visible, { fadeSurface: Platform.OS !== 'ios', collapseTo: Platform.OS === 'ios' ? {
    x: bounds.x + bounds.width / 2 - left - menuWidth / 2,
    y: bounds.y + bounds.height / 2 - top - menuHeight / 2,
  } : undefined });
  const pendingAction = useRef<{ owner: number; callback: () => void } | null>(null);
  // Separate native Modal IDs keep late dismissals attached to their opening.
  const presentation = useRef({ visible: false, mounted: motion.mounted, owner: 0 });
  if (visible && !presentation.current.visible) {
    presentation.current.owner++;
    pendingAction.current = null;
  }
  presentation.current.visible = visible;
  presentation.current.mounted = motion.mounted;
  const owner = presentation.current.owner;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; pendingAction.current = null; };
  }, []);
  const finishAction = useCallback((dismissedOwner: number) => {
    const action = pendingAction.current;
    if (!alive.current || presentation.current.visible || presentation.current.mounted || presentation.current.owner !== dismissedOwner || action?.owner !== dismissedOwner) return;
    pendingAction.current = null;
    action.callback();
  }, []);
  const close = useCallback(() => {
    if (!alive.current || !presentation.current.visible || presentation.current.owner !== owner) return;
    onClose();
  }, [onClose, owner]);
  const geometry = anchorGeometryKey(viewport.width, insets);
  const anchorGeometry = useRef(geometry);
  const anchorVisible = useRef(false);
  if (visible && !anchorVisible.current) anchorGeometry.current = geometry;
  anchorVisible.current = visible;
  const anchorValid = anchorGeometry.current === geometry;
  useEffect(() => {
    // A window-space trigger rectangle cannot survive a rotation or split-view resize.
    if (visible && !anchorValid) close();
  }, [visible, anchorValid, close]);
  useEffect(() => {
    // iOS must finish dismissing its controller before another Modal can present.
    if (motion.mounted || (!keyboardOverlay && Platform.OS === 'ios') || !pendingAction.current) return;
    const frame = requestAnimationFrame(() => finishAction(owner));
    return () => cancelAnimationFrame(frame);
  }, [motion.mounted, finishAction, keyboardOverlay, owner]);
  useEffect(() => {
    if (!keyboardOverlay || !motion.mounted) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true; });
    return () => back.remove();
  }, [keyboardOverlay, motion.mounted, close]);
  if (!rect) return null;

  const content = (
    <View style={StyleSheet.absoluteFill} collapsable={false} pointerEvents={visible && anchorValid ? 'auto' : 'none'} accessibilityViewIsModal onAccessibilityEscape={close}>
      <Animated.View style={[StyleSheet.absoluteFill, motion.backdrop]}><MenuPressable style={[StyleSheet.absoluteFill, { backgroundColor: preview ? '#00000066' : '#0000000d' }]} onPress={close} accessibilityLabel="关闭菜单" /></Animated.View>
      {preview && anchorValid && <Animated.View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[{ position: 'absolute', left: safe.left, top: safe.top, width: safe.width, height: safe.height, overflow: 'hidden' }, motion.backdrop]}>
        <View style={{ position: 'absolute', left: rect.x - safe.left, top: rect.y - safe.top, width: rect.width }}>{preview}</View>
      </Animated.View>}
      <Animated.View style={[styles.position, { top, left, width: menuWidth }, motion.surface, !anchorValid && styles.hidden]}>
        <GlassSurface style={[styles.menu, { maxHeight: menuHeight, borderRadius: 20 }]}>
          <MenuScrollView bounces={false} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="always" keyboardDismissMode="none" contentContainerStyle={styles.items}
            onContentSizeChange={(_width, height) => {
              if (height > 0 && alive.current && presentation.current.visible && presentation.current.owner === owner) setMeasured((current) => current.key === contentKey && current.height === height ? current : { key: contentKey, height });
            }}>
            {items.map((item) => (
              <View key={item.key}>
                {item.separatorBefore && <View style={[styles.separator, { backgroundColor: colors.border }]} />}
                <MenuPressable disabled={item.disabled} onPress={() => {
                  if (!alive.current || !presentation.current.visible || presentation.current.owner !== owner || pendingAction.current) return;
                  pendingAction.current = { owner, callback: item.onPress };
                  onClose();
                }} accessibilityRole="button"
                  accessibilityState={{ selected: item.selected, disabled: item.disabled }}
                  style={({ pressed }) => [styles.row, { minHeight: item.subtitle ? 62 : 46, opacity: item.disabled ? 0.35 : 1,
                    backgroundColor: item.selected || pressed ? colors.hover : undefined }]}>
                  {item.leading ?? (item.icon && <Icon name={item.icon} size={22} color={item.danger ? colors.error : colors.text} />)}
                  <View style={styles.label}>
                    <Text numberOfLines={1} style={{ fontFamily: fonts.medium, fontSize: 16, color: item.danger ? colors.error : colors.text }}>{item.title ?? item.label}</Text>
                    {item.subtitle && <Text numberOfLines={1} style={[styles.subtitle, { fontFamily: fonts.regular, color: colors.muted }]}>{item.subtitle}</Text>}
                  </View>
                  {item.selected && <Icon name={Check} size={20} />}
                </MenuPressable>
              </View>
            ))}
          </MenuScrollView>
        </GlassSurface>
      </Animated.View>
    </View>
  );
  // This native overlay never takes keyboard focus. Do not dismiss/refocus the input.
  // Android moves it to a separate window; its gestures need their own native root.
  if (androidKeyboardOverlay) return <OverKeyboardView visible={motion.mounted}><GestureHandlerRootView style={styles.overlayRoot} pointerEvents={visible ? 'auto' : 'none'}>{content}</GestureHandlerRootView></OverKeyboardView>;
  if (keyboardOverlay) return <OverKeyboardView visible={motion.mounted}>{content}</OverKeyboardView>;
  return <Modal key={owner} visible={motion.mounted} transparent hardwareAccelerated animationType="none" onRequestClose={close} onDismiss={() => finishAction(owner)} supportedOrientations={modalOrientations} statusBarTranslucent navigationBarTranslucent>{content}</Modal>;
}

const styles = StyleSheet.create({
  overlayRoot: { flex: 1 },
  hidden: { opacity: 0 },
  position: { position: 'absolute', shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: Platform.OS === 'ios' ? 0.14 : 0.18, shadowRadius: 24, elevation: 16 },
  menu: { overflow: 'hidden' }, items: { padding: 6 }, row: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { flex: 1 }, subtitle: { fontSize: 13, marginTop: 3 }, separator: { height: StyleSheet.hairlineWidth, marginHorizontal: 10, marginVertical: 5 },
});
