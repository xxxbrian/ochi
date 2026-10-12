import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated from 'react-native-reanimated';
import { useTheme } from '../providers/AppProvider';
import { AppText } from '../components/ScreenChrome';
import { GlassSurface } from './GlassSurface';
import { useModalTransition } from './useModalTransition';
import { modalOrientations } from './overlayGeometry';

export type SessionTitleDialogProps = {
  visible: boolean;
  title: string;
  onClose: () => void;
  onSave: (title: string) => Promise<void>;
};

export function SessionTitleDialog(props: SessionTitleDialogProps) {
  return Platform.OS === 'ios' ? <NativeTitlePrompt {...props} /> : <TitlePrompt {...props} />;
}

function NativeTitlePrompt({ visible, ...props }: SessionTitleDialogProps) {
  const { dark } = useTheme();
  const latest = useRef({ ...props, dark });
  latest.current = { ...props, dark };
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const present = (value: string, message?: string) => {
      if (disposed) return;
      // UIKit owns the text field, keyboard avoidance and system glass alert.
      Alert.prompt('重命名对话', message, [
        { text: '取消', style: 'cancel', onPress: () => { if (!disposed) latest.current.onClose(); } },
        { text: '确定', isPreferred: true, onPress: (input?: string) => {
          if (disposed) return;
          const title = (input ?? '').trim();
          const retry = (error: string) => {
            if (disposed) return;
            // UIAlertController dismisses automatically before the JS save completes.
            timer = setTimeout(() => present(input ?? '', error), 300);
          };
          if (!title) { retry('标题不能为空'); return; }
          void latest.current.onSave(title).then(() => {
            if (!disposed) latest.current.onClose();
          }).catch((error: unknown) => {
            if (!disposed) retry(error instanceof Error ? error.message : '保存失败，请重试');
          });
        } },
      ], 'plain-text', value, 'default', { userInterfaceStyle: latest.current.dark ? 'dark' : 'light' });
    };
    timer = setTimeout(() => present(latest.current.title), 0);
    return () => { disposed = true; clearTimeout(timer); };
  }, [visible]);
  return null;
}

function TitlePrompt({ visible, title, onClose, onSave }: SessionTitleDialogProps) {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const viewport = useWindowDimensions();
  const compact = viewport.width > viewport.height;
  const [draft, setDraft] = useState(title);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const input = useRef<TextInput>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shown = useRef(visible);
  shown.current = visible;
  const motion = useModalTransition(visible);
  useEffect(() => { if (visible) { setDraft(title); setError(''); } }, [visible, title]);
  useEffect(() => () => clearTimeout(focusTimer.current), [visible]);
  const save = async () => {
    if (!draft.trim() || saving) return;
    setSaving(true);
    setError('');
    try { await onSave(draft.trim()); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重试'); }
    finally { setSaving(false); }
  };
  return (
    <Modal visible={motion.mounted} transparent animationType="none" supportedOrientations={modalOrientations} statusBarTranslucent navigationBarTranslucent
      onRequestClose={() => { if (!saving) onClose(); }} onShow={() => {
        clearTimeout(focusTimer.current);
        // The Android Dialog must own window focus before its new editor requests the IME.
        if (shown.current) focusTimer.current = setTimeout(() => {
          if (shown.current) input.current?.focus();
        }, 150);
      }}>
      <Animated.View style={[StyleSheet.absoluteFill, motion.backdrop]}>
        <Pressable accessibilityLabel="取消重命名" disabled={saving} onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: '#00000050' }]} />
      </Animated.View>
      <KeyboardAvoidingView style={styles.fill} behavior="padding" pointerEvents="box-none">
        <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="none" bounces={false} contentContainerStyle={[styles.center, {
          paddingLeft: insets.left + 20, paddingRight: insets.right + 20,
          paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8,
        }]}>
        <Animated.View style={[styles.dialog, motion.surface]}>
          <GlassSurface style={[styles.panel, compact && { gap: 12, padding: 14 }]}>
            <AppText size={18} weight="medium" style={styles.title}>重命名对话</AppText>
            <TextInput ref={input} value={draft} onChangeText={setDraft} selectTextOnFocus editable={!saving} disableFullscreenUI
              accessibilityLabel="对话标题" returnKeyType="done" onSubmitEditing={() => void save()}
              style={[styles.input, { color: colors.text, backgroundColor: colors.hover, fontFamily: fonts.regular }]} />
            {Boolean(error) && <AppText size={13} style={{ color: colors.error }}>{error}</AppText>}
            <View style={styles.buttons}>
              <Pressable accessibilityRole="button" onPress={onClose} disabled={saving}
                style={({ pressed }) => [styles.button, { backgroundColor: colors.hover, opacity: pressed ? 0.7 : 1 }]}>
                <AppText weight="medium">取消</AppText>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => void save()} disabled={!draft.trim() || saving}
                style={({ pressed }) => [styles.button, { backgroundColor: colors.text, opacity: !draft.trim() || pressed ? 0.5 : 1 }]}>
                {saving ? <ActivityIndicator color={colors.canvas} /> : <AppText weight="medium" style={{ color: colors.canvas }}>确定</AppText>}
              </Pressable>
            </View>
          </GlassSurface>
        </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flexGrow: 1, justifyContent: 'center', alignItems: 'center' },
  dialog: { width: '100%', maxWidth: 350 },
  panel: { borderRadius: 28, padding: 18, gap: 16 },
  title: { textAlign: 'center', marginVertical: 4 },
  input: { height: 48, borderRadius: 24, paddingHorizontal: 16, fontSize: 16 },
  buttons: { flexDirection: 'row', gap: 10 },
  button: { flex: 1, height: 46, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
