import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Download, X } from "lucide-react-native";
import { router, useSegments } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardState } from "react-native-keyboard-controller";
import { t, useI18n } from "../lib/i18n";
import { availableAndroidRelease } from "../lib/clientUpdates";
import { useApp } from "../providers/AppProvider";
import { useClientUpdates } from "../providers/ClientReleaseProvider";
import { AppText } from "./ScreenChrome";

export function ClientUpdateNotice() {
  useI18n();
  const { user, colors } = useApp();
  const { state, controller } = useClientUpdates();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const segments = useSegments();
  const release = availableAndroidRelease(state);
  if (!user || !release || !state.showNotice || keyboardVisible || segments.join("/").startsWith("settings")) return null;
  return (
    <View pointerEvents="box-none" style={[styles.position, {
      top: insets.top + (height < 500 ? 48 : 58),
      left: insets.left + 12, right: insets.right + 12,
    }]}>
      <View style={[styles.notice, { backgroundColor: colors.raised, borderColor: colors.border }]}>
        <Pressable accessibilityRole="button" onPress={() => router.push("/settings/updates")} style={styles.body}>
          <Download size={19} color={colors.text} />
          <View style={styles.copy}>
            <AppText size={14} weight="medium" numberOfLines={2}>{t("updates.available", { version: release.version_name })}</AppText>
            <AppText muted size={12}>{t("updates.view")}</AppText>
          </View>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t("common.close")} onPress={controller.dismissNotice} style={styles.close}>
          <X size={18} color={colors.muted} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  position: { position: "absolute", zIndex: 20, alignItems: "center" },
  notice: { width: "100%", maxWidth: 440, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center" },
  body: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, padding: 14 },
  copy: { flex: 1, gap: 2 },
  close: { width: 44, minHeight: 48, alignItems: "center", justifyContent: "center" },
});
