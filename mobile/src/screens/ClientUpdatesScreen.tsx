import { useEffect } from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import { Download, ExternalLink, RefreshCw, Trash2 } from "lucide-react-native";
import { t, useI18n, type MessageKey } from "../lib/i18n";
import { availableAndroidRelease, type ClientUpdateErrorCode } from "../lib/clientUpdates";
import { useTheme } from "../providers/AppProvider";
import { useClientUpdates } from "../providers/ClientReleaseProvider";
import { AppText, Button, SettingRow, Surface } from "../components/ScreenChrome";
import { SettingsHeader, SettingsPage, settingsStyles } from "../components/SettingsChrome";
import { fileSize } from "../components/artifactFiles";

const errors: Record<ClientUpdateErrorCode, MessageKey> = {
  check: "updates.checkFailed", download: "updates.downloadFailed", integrity: "updates.integrityFailed",
  package: "updates.packageFailed", permission: "updates.permissionFailed", install: "updates.installFailed", open: "updates.openFailed",
};

export function ClientUpdatesScreen() {
  useI18n();
  const { colors } = useTheme();
  const { state, controller } = useClientUpdates();
  const android = Platform.OS === "android";
  const release = availableAndroidRelease(state);
  const busy = state.checking || state.phase === "downloading" || state.phase === "verifying";
  useEffect(() => { void controller.check(true); }, [controller]);
  const percentage = state.total ? Math.min(100, Math.floor(state.received / state.total * 100)) : 0;
  return (
    <SettingsPage>
      <SettingsHeader title={t("updates.title")} />
      <ScrollView contentContainerStyle={[settingsStyles.content, styles.content]}>
        <Surface style={{ ...settingsStyles.group, backgroundColor: colors.raised }}>
          {android && state.installed && (
            <SettingRow title={t("updates.current")} detail={`${state.installed.versionName} (${state.installed.versionCode})`} />
          )}
          <SettingRow icon={RefreshCw} title={state.checking ? t("updates.checking") : t("updates.check")}
            onPress={busy ? undefined : () => void controller.check(true)} last />
        </Surface>
        {state.error && <AppText accessibilityRole="alert" size={14} style={{ color: colors.error }}>{t(errors[state.error])}</AppText>}
        {android ? release ? (
          <Surface style={{ ...styles.card, backgroundColor: colors.raised }}>
            <View style={styles.heading}>
              <Download size={23} color={colors.text} />
              <View style={styles.grow}>
                <AppText weight="semibold">{t("updates.available", { version: release.version_name })}</AppText>
                <AppText muted size={13}>{fileSize(release.size_bytes)}</AppText>
              </View>
            </View>
            {Boolean(release.release_notes.trim()) && <AppText size={14}>{release.release_notes}</AppText>}
            {state.phase === "downloading" ? (
              <>
                <AppText muted size={14}>{t("updates.downloading", { progress: percentage })}</AppText>
                <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: percentage }}
                  style={[styles.track, { backgroundColor: colors.hover }]}>
                  <View style={[styles.progress, { backgroundColor: colors.text, width: `${percentage}%` }]} />
                </View>
                <Button secondary onPress={controller.cancel}>{t("common.cancel")}</Button>
              </>
            ) : state.phase === "verifying" ? (
              <>
                <AppText muted size={14}>{t("updates.verifying")}</AppText>
                <Button secondary onPress={controller.cancel}>{t("common.cancel")}</Button>
              </>
            ) : state.phase === "permission" ? (
              <>
                <AppText size={14}>{t("updates.permissionHint")}</AppText>
                <Button disabled={state.checking} onPress={() => void controller.openPermissionSettings()}>{t("updates.allowSource")}</Button>
                <Button disabled={state.checking} secondary onPress={() => void controller.install()}>{t("updates.retryInstall")}</Button>
              </>
            ) : state.localPath ? (
              <>
                <AppText muted size={14}>{t("updates.readyHint")}</AppText>
                <Button disabled={state.checking} onPress={() => void controller.install()}>{t("updates.install")}</Button>
              </>
            ) : (
              <Button disabled={state.checking} onPress={() => void controller.download()}>
                {state.error && state.error !== "check" ? t("common.retry") : t("updates.download")}
              </Button>
            )}
            {state.localPath && !busy && (
              <SettingRow icon={Trash2} title={t("updates.clearDownload")} onPress={() => void controller.clearDownload()} last />
            )}
          </Surface>
        ) : state.checked && <AppText muted size={14}>{state.releases?.android ? t("updates.upToDate") : t("updates.notPublished")}</AppText>
          : state.releases?.ios ? (
            <Surface style={{ ...styles.card, backgroundColor: colors.raised }}>
              <AppText size={14}>{t("updates.iosHint")}</AppText>
              <SettingRow icon={ExternalLink} title={t("updates.openIOS")} onPress={() => void controller.openIOS()} last />
            </Surface>
          ) : state.checked && <AppText muted size={14}>{t("updates.iosUnavailable")}</AppText>}
      </ScrollView>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  content: { gap: 16 },
  card: { padding: 18, borderRadius: 22, gap: 16 },
  heading: { flexDirection: "row", alignItems: "center", gap: 12 },
  grow: { flex: 1 },
  track: { height: 4, borderRadius: 2, overflow: "hidden" },
  progress: { height: "100%" },
});
