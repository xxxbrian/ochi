import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import {
  Brain,
  Check,
  CircleUserRound,
  Contrast,
  LogOut,
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
  const { user, theme, colors, signOut } = useApp();
  const [error, setError] = useState("");
  const server = getAPIBaseURL();
  return (
    <SettingsPage>
      <SettingsHeader title="设置" root />
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
          应用
        </AppText>
        <Surface
          style={{ ...settingsStyles.group, backgroundColor: colors.raised }}
        >
          <SettingRow
            icon={theme === "dark" ? Moon : theme === "light" ? Sun : Contrast}
            title="外观"
            detail={
              theme === "system"
                ? "跟随系统"
                : theme === "dark"
                  ? "深色"
                  : "浅色"
            }
            onPress={() => router.push("/settings/appearance")}
          />
          <SettingRow
            icon={Brain}
            title="记忆"
            onPress={() => router.push("/settings/memories")}
          />
          <SettingRow
            icon={Puzzle}
            title="插件"
            onPress={() => router.push("/settings/plugins")}
            last
          />
        </Surface>
        <AppText muted size={13} weight="medium" style={settingsStyles.section}>
          账号
        </AppText>
        <Surface
          style={{ ...settingsStyles.group, backgroundColor: colors.raised }}
        >
          {user?.role === "admin" && (
            <SettingRow
              icon={Shield}
              title="管理后台"
              onPress={() => router.push("/admin")}
            />
          )}
          <SettingRow
            icon={Monitor}
            title="服务"
            detail={isConfiguredAPIBaseURL(server) ? new URL(server).host : "未配置"}
            last
          />
        </Surface>
        <ErrorNotice error={error} />
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            Alert.alert("退出登录？", undefined, [
              { text: "取消", style: "cancel" },
              {
                text: "退出登录",
                onPress: () =>
                  void signOut()
                    .then(() => router.replace("/login"))
                    .catch((reason) =>
                      setError(
                        reason instanceof Error ? reason.message : "退出失败",
                      ),
                    ),
              },
            ])
          }
          style={styles.logout}
        >
          <LogOut size={17} color={colors.muted} />
          <AppText muted size={14}>
            退出登录
          </AppText>
        </Pressable>
      </ScrollView>
    </SettingsPage>
  );
}

export function AppearanceScreen() {
  const { theme, setTheme, colors } = useApp();
  return (
    <SettingsPage>
      <SettingsHeader title="外观" />
      <ScrollView contentContainerStyle={settingsStyles.content}>
        <View style={styles.appearanceChoices}>
          {(
            [
              { value: "system", title: "跟随系统", icon: Contrast },
              { value: "light", title: "浅色", icon: Sun },
              { value: "dark", title: "深色", icon: Moon },
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
});
