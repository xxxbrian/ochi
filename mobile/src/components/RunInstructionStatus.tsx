import { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { instructionStatusLabel, type InstructionReceipt } from '../../../web/src/lib/runInstructions';
import { useTheme } from '../providers/AppProvider';
import { AppText } from './ScreenChrome';

export const RunInstructionStatus = memo(function RunInstructionStatus({
  items, error, syncError, retryPending, submitting, onRetry, onRefresh,
}: {
  items: InstructionReceipt[]; error: string; syncError: string; retryPending: boolean; submitting: boolean;
  onRetry: () => Promise<boolean>; onRefresh: () => Promise<void>;
}) {
  const { colors } = useTheme();
  if (!items.length && !error && !syncError) return null;
  return <View style={styles.outer} accessibilityLabel="补充要求">
    {items.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always">
      {items.map((item) => <View key={item.id} style={[styles.receipt, { borderColor: colors.border }]}>
        <AppText muted size={12} numberOfLines={1} style={styles.content}>{item.content}</AppText>
        <AppText muted size={12} accessibilityLiveRegion="polite">{instructionStatusLabel(item.status)}</AppText>
      </View>)}
    </ScrollView>}
    {(error || syncError) && <View style={styles.notice}>
      <AppText muted size={12} style={{ flex: 1 }}>{error || syncError}</AppText>
      {(retryPending || syncError) && <Pressable accessibilityRole="button" accessibilityLabel="重试补充要求"
        disabled={submitting} onPress={() => void (retryPending ? onRetry() : onRefresh())} style={styles.retry}>
        <AppText size={12}>重试</AppText>
      </Pressable>}
    </View>}
  </View>;
});
const styles = StyleSheet.create({
  outer: { marginHorizontal: 16, marginBottom: 4 },
  receipt: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 28, maxWidth: 288, marginRight: 8, paddingHorizontal: 9, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  content: { maxWidth: 208, flexShrink: 1 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  retry: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
});
