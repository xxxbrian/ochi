import { useState, type ReactNode } from 'react';
import { Dimensions, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useGenericKeyboardHandler, useKeyboardContext } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { useTheme } from '../providers/AppProvider';
import { IconButton } from './IconButton';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useModalTransition } from './useModalTransition';
import { modalOrientations, sheetKeyboardLayout } from './overlayGeometry';

export function Sheet({ visible, onClose, onShow, title, children, height = 'large' }: {
  visible: boolean; onClose: () => void; title?: string; children: ReactNode;
  onShow?: () => void;
  height?: number | 'full' | 'large';
}) {
  const { colors, fonts } = useTheme();
  const viewport = useWindowDimensions();
  const screen = Dimensions.get('screen');
  const geometry = `${screen.width}:${screen.height}`;
  const insets = useSafeAreaInsets();
  const [modalSize, setModalSize] = useState({ geometry, width: viewport.width, height: screen.height });
  const windowHeight = modalSize.geometry === geometry ? modalSize.height : screen.height;
  const compact = screen.width > screen.height;
  const { reanimated } = useKeyboardContext();
  const keyboardHeight = useSharedValue(Math.max(0, -reanimated.height.value));
  const keyboardProgress = useSharedValue(reanimated.progress.value);
  // Modal keyboard callbacks provide live native frames, including Android Dialogs.
  useGenericKeyboardHandler({
    onStart: (event) => {
      'worklet';
      if (event.duration === 0) {
        keyboardHeight.value = Math.max(0, event.height);
        keyboardProgress.value = Math.max(0, Math.min(1, event.progress));
      }
    },
    onMove: (event) => {
      'worklet';
      keyboardHeight.value = Math.max(0, event.height);
      keyboardProgress.value = Math.max(0, Math.min(1, event.progress));
    },
    onInteractive: (event) => {
      'worklet';
      keyboardHeight.value = Math.max(0, event.height);
      keyboardProgress.value = Math.max(0, Math.min(1, event.progress));
    },
    onEnd: (event) => {
      'worklet';
      keyboardHeight.value = Math.max(0, event.height);
      keyboardProgress.value = Math.max(0, Math.min(1, event.progress));
    },
  }, []);
  const safeArea = useAnimatedStyle(() => ({ paddingBottom: insets.bottom * (1 - keyboardProgress.value) }));
  const motion = useModalTransition(visible);
  const availableHeight = Math.max(0, windowHeight - insets.top - 8);
  const sheetHeight = height === 'full' || (height === 'large' && compact) ? availableHeight : height === 'large' ? Math.min(windowHeight * 0.86, availableHeight) : Math.min(height, availableHeight);
  const avoidance = useAnimatedStyle(() => ({ bottom: sheetKeyboardLayout(windowHeight, screen.height, keyboardHeight.value, insets.top + 8, sheetHeight).bottom }));
  const size = useAnimatedStyle(() => ({ height: sheetKeyboardLayout(windowHeight, screen.height, keyboardHeight.value, insets.top + 8, sheetHeight).height }));
  return (
    <Modal visible={motion.mounted} transparent hardwareAccelerated animationType="none" onRequestClose={onClose} onShow={onShow} supportedOrientations={modalOrientations} statusBarTranslucent navigationBarTranslucent>
      <View style={styles.root} onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        if (width > 0 && height > 0) setModalSize((current) => current.geometry === geometry && current.width === width && current.height === height ? current : { geometry, width, height });
      }}>
        {/* The backdrop must not shrink or move with the keyboard. */}
        <Animated.View style={[StyleSheet.absoluteFill, motion.backdrop]}><Pressable style={[StyleSheet.absoluteFill, { backgroundColor: '#00000050' }]} onPress={onClose} accessibilityLabel="关闭" /></Animated.View>
        <Animated.View pointerEvents="box-none" style={[styles.avoiding, { paddingTop: insets.top + 8, paddingLeft: insets.left, paddingRight: insets.right }, avoidance]}>
          <Animated.View style={[styles.sheet, { backgroundColor: colors.surface }, size, safeArea, motion.surface]}>
            <View style={[styles.handleArea, compact && { height: 12 }]}><View style={[styles.handle, { backgroundColor: colors.muted }]} /></View>
            <View style={[styles.header, compact && { minHeight: 44 }]}>
              <View style={styles.spacer} />
              {title && <Text numberOfLines={1} style={[styles.title, { color: colors.text, fontFamily: fonts.semibold }]}>{title}</Text>}
              <IconButton icon={X} label="关闭" onPress={onClose} variant="glass" size={40} iconSize={20} />
            </View>
            <View style={styles.body}>{motion.mounted && children}</View>
          </Animated.View>
        </Animated.View>
      </View>
    </Modal>
  );
}
const styles = StyleSheet.create({ root: { flex: 1 }, avoiding: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, justifyContent: 'flex-end' }, sheet: { width: '100%', maxWidth: 680, alignSelf: 'center', borderTopLeftRadius: 30, borderTopRightRadius: 30, overflow: 'hidden' }, handleArea: { height: 20, flexShrink: 0, justifyContent: 'center', alignItems: 'center' }, handle: { width: 34, height: 4, borderRadius: 3, opacity: 0.45 }, header: { minHeight: 52, flexShrink: 0, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, spacer: { width: 40 }, title: { flex: 1, textAlign: 'center', fontSize: 17 }, body: { flex: 1, minHeight: 0 } });
