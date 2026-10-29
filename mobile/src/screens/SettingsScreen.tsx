import { errorForDisplay, type DisplayError } from "../lib/errors";
import { t, useI18n } from "../lib/i18n";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import {
  Brain,
  Check,
  CircleUserRound,
  Contrast,
  LogOut,
  Languages,
  Monitor,
  Moon,
  Puzzle,
  Shield,
  Sun,
} from "lucide-react-native";
import { router } from "expo-router";
import { brand } from "../../brand.config";
import { getAPIBaseURL, isConfiguredAPIBaseURL } from "../lib/api";
import { useApp } from "../providers/AppProvider";
import {
  AppText,
  ErrorNotice,
  SettingRow,
  Surface,
} from "../components/ScreenChrome";
import {
  SettingsHeader,
  SettingsPage,
  settingsStyles,
} from "../components/SettingsChrome";

export function SettingsScreen() {
  useI18n();
  const { user, theme, colors, signOut, language } = useApp();
  const [error, setError] = useState<DisplayError>("");
  const server = getAPIBaseURL();
  return (
    <SettingsPage>
      <SettingsHeader title={t("settings.title")} root />
      <ScrollView contentContainerStyle={settingsStyles.content}>
        <Surface
          style={{ ...settingsStyles.group, backgroundColor: colors.raised }}
        >
          <View style={styles.account}>
            <View style={[styles.avatar, { backgroundColor: colors.hover }]}>
              <AppText size={24} weight="medium">
                {user?.display_name?.slice(0, 1) || brand.displayName[0]}
              </AppText>
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <AppText size={18} weight="medium">
                {user?.display_name || user?.username || brand.displayName}
              </AppText>
              <AppText muted size={14}>
                @{user?.username}
              </AppText>
            </View>
            <CircleUserRound size={22} color={colors.muted} strokeWidth={1.6} />
          </View>
        </Surface>
        <AppText muted size={13} weight="medium" style={settingsStyles.section}>
          {t("settings.app")}</AppText>
        <Surface
          style={{ ...settingsStyles.group, backgroundColor: colors.raised }}
        >
          <SettingRow
            icon={Languages}
            title={t("settings.language")}
            detail={language === "system" ? t("settings.languageSystem") : language === "en" ? "English" : language === "zh-TW" ? "繁體中文" : "简体中文"}
            onPress={() => router.push("/settings/language")}
          />
          <SettingRow
            icon={theme === "dark" ? Moon : theme === "light" ? Sun : Contrast}
            title={t("settings.appearance")}
            detail={
              theme === "system"
                ? t("settings.system")
                : theme === "dark"
                  ? t("settings.dark")
                  : t("settings.light")
            }
            onPress={() => router.push("/settings/appearance")}
          />
          <SettingRow
            icon={Brain}
            title={t("memory.title")}
            onPress={() => router.push("/settings/memories")}
          />
          <SettingRow
            icon={Puzzle}
            title={t("plugin.title")}
            onPress={() => router.push("/settings/plugins")}
            last
          />
        </Surface>
        <AppText muted size={13} weight="medium" style={settingsStyles.section}>
          {t("settings.accountSection")}</AppText>
        <Surface
          style={{ ...settingsStyles.group, backgroundColor: colors.raised }}
        >
          {user?.role === "admin" && (
            <SettingRow
              icon={Shield}
              title={t("admin.title")}
              onPress={() => router.push("/admin")}
            />
          )}
          <SettingRow
            icon={Monitor}
            title={t("settings.server")}
            detail={isConfiguredAPIBaseURL(server) ? new URL(server).host : t("settings.notConfigured")}
            last
          />
        </Surface>
        <ErrorNotice error={error} />
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            Alert.alert(t("account.signOutConfirm"), undefined, [
              { text: t("common.cancel"), style: "cancel" },
              {
                text: t("account.signOut"),
                onPress: () =>
                  void signOut()
                    .then(() => router.replace("/login"))
                    .catch((reason) =>
                      setError(
                        errorForDisplay(reason, "error.signOut"),
                      ),
                    ),
              },
            ])
          }
          style={styles.logout}
        >
          <LogOut size={17} color={colors.muted} />
          <AppText muted size={14}>
            {t("account.signOut")}</AppText>
        </Pressable>
      </ScrollView>
    </SettingsPage>
  );
}

export function AppearanceScreen() {
  useI18n();
  const { theme, setTheme, colors } = useApp();
  return (
    <SettingsPage>
      <SettingsHeader title={t("settings.appearance")} />
      <ScrollView contentContainerStyle={settingsStyles.content}>
        <View style={styles.appearanceChoices}>
          {(
            [
              { value: "system", title: t("settings.system"), icon: Contrast },
              { value: "light", title: t("settings.light"), icon: Sun },
              { value: "dark", title: t("settings.dark"), icon: Moon },
            ] as const
          ).map((choice) => {
            const selected = theme === choice.value;
            return (
              <Pressable
                key={choice.value}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={choice.title}
                onPress={() => setTheme(choice.value)}
                style={styles.appearanceChoice}
              >
                <View
                  style={[
                    styles.appearanceCard,
                    {
                      backgroundColor: selected ? colors.raised : "transparent",
                      borderColor: selected ? colors.raised : colors.border,
                    },
                  ]}
                >
                  <choice.icon
                    size={28}
                    color={selected ? colors.text : colors.muted}
                    strokeWidth={1.8}
                  />
                  {selected && (
                    <Check
                      size={13}
                      color={colors.muted}
                      style={styles.selectionCheck}
                    />
                  )}
                </View>
                <AppText
                  size={14}
                  muted={!selected}
                  weight={selected ? "medium" : "regular"}
                >
                  {choice.title}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </SettingsPage>
  );
}

export function LanguageScreen() {
  useI18n();
  const { language, selectLanguage, colors } = useApp();
  const [error, setError] = useState<DisplayError>("");
  return (
    <SettingsPage>
      <SettingsHeader title={t("settings.language")} />
      <ScrollView contentContainerStyle={settingsStyles.content}>
        <Surface style={{ ...settingsStyles.group, backgroundColor: colors.raised }}>
          {([
            { value: "system", title: t("settings.languageSystem") },
            { value: "zh-CN", title: "简体中文" },
            { value: "zh-TW", title: "繁體中文" },
            { value: "en", title: "English" },
          ] as const).map((choice, index) => (
            <Pressable
              key={choice.value}
              accessibilityRole="radio"
              accessibilityLabel={choice.title}
              accessibilityState={{ checked: language === choice.value }}
              onPress={() => {
                setError("");
                void selectLanguage(choice.value).catch((reason: unknown) => setError(errorForDisplay(reason, "error.save")));
              }}
              style={[styles.languageRow, index < 3 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}
            >
              <AppText style={{ flex: 1 }}>{choice.title}</AppText>
              {language === choice.value && <Check size={19} color={colors.text} />}
            </Pressable>
          ))}
        </Surface>
        <ErrorNotice error={error} />
      </ScrollView>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  account: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 18,
    minHeight: 96,
  },
  avatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
  },
  logout: {
    flexDirection: "row",
    gap: 9,
    alignItems: "center",
    alignSelf: "center",
    padding: 16,
    marginTop: 12,
  },
  appearanceChoices: { flexDirection: "row", gap: 10 },
  appearanceChoice: { flex: 1, alignItems: "center", gap: 10 },
  appearanceCard: {
    width: "100%",
    height: 82,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  selectionCheck: { position: "absolute", right: 10, bottom: 9 },
  languageRow: { minHeight: 54, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", gap: 12 },
});
