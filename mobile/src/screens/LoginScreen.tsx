import { errorForDisplay, localizedError, type DisplayError } from "../lib/errors";
import { t, useI18n } from "../lib/i18n";
import { useState } from "react";
import {
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { DEFAULT_API_BASE_URL, getAPIBaseURL, isConfiguredAPIBaseURL } from "../lib/api";
import { useApp } from "../providers/AppProvider";
import { brand } from "../../brand.config";
import {
  AppText,
  Button,
  ErrorNotice,
  Field,
} from "../components/ScreenChrome";

export function LoginScreen() {
  useI18n();
  const { colors, loading, authError, signIn, language, selectLanguage } = useApp();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const compact = height < 500;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState(getAPIBaseURL());
  const [serverOpen, setServerOpen] = useState(() => !isConfiguredAPIBaseURL() || getAPIBaseURL() !== DEFAULT_API_BASE_URL);
  const [error, setError] = useState<DisplayError>("");
  async function login() {
    if (!username.trim() || !password || loading || !isConfiguredAPIBaseURL(server)) return;
    setError("");
    try {
      await signIn(username.trim(), password, server);
      router.replace("/");
    } catch (reason) {
      setError(errorForDisplay(reason, "error.login"));
    }
  }
  return (
    <View
      style={{ flex: 1, backgroundColor: colors.canvas }}
    >
      <KeyboardAwareScrollView
        bottomOffset={16}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.body,
          {
            paddingTop: insets.top + (compact ? 20 : 70),
            paddingBottom: insets.bottom + 24,
            paddingLeft: insets.left + 28,
            paddingRight: insets.right + 28,
          },
        ]}
      >
        <View style={styles.form}>
          <AppText
            size={38}
            weight="medium"
            style={{ letterSpacing: -1.2, marginBottom: compact ? 18 : 36 }}
          >
            {brand.displayName}
          </AppText>
          <Field
            label={t("account.username")}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
            value={username}
            onChangeText={setUsername}
            returnKeyType="next"
          />
          <Field
            label={t("account.password")}
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            value={password}
            onChangeText={setPassword}
            returnKeyType="go"
            onSubmitEditing={() => void login()}
          />
          <ErrorNotice error={error || authError} />
          <Button
            disabled={!username.trim() || !password || !isConfiguredAPIBaseURL(server)}
            busy={loading}
            onPress={() => void login()}
          >
            {t("account.signIn")}</Button>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: serverOpen }}
            disabled={loading}
            onPress={() => setServerOpen(!serverOpen)}
            style={styles.serverToggle}
          >
            <AppText muted size={13}>
              {t("account.selfHosted")}</AppText>
            {serverOpen ? (
              <ChevronUp size={14} color={colors.muted} />
            ) : (
              <ChevronDown size={14} color={colors.muted} />
            )}
          </Pressable>
          {serverOpen && (
            <View>
              <Field
                label={t("account.serverAddress")}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="https://your-server.com"
                value={server}
                onChangeText={setServer}
                editable={!loading}
              />
              <AppText muted size={12}>
                {t("account.httpNotice")}</AppText>
              {server.trim() !== DEFAULT_API_BASE_URL && (
                <Pressable
                  accessibilityRole="button"
                  disabled={loading}
                  onPress={() => {
                    setServer(DEFAULT_API_BASE_URL);
                    setServerOpen(false);
                    setError("");
                  }}
                  style={styles.defaultServer}
                >
                  <AppText muted size={13}>{t("account.defaultServer")}</AppText>
                </Pressable>
              )}
            </View>
          )}
          <View style={styles.languages} accessibilityLabel={t("settings.language")}>
            {([
              { value: "system", title: t("settings.languageSystem") },
              { value: "zh-CN", title: "简体中文" },
              { value: "zh-TW", title: "繁體中文" },
              { value: "en", title: "English" },
            ] as const).map((choice) => <Pressable
              key={choice.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: language === choice.value }}
              disabled={loading}
              onPress={() => { setError(""); void selectLanguage(choice.value).catch(() => setError(localizedError("error.save"))); }}
              style={[styles.language, language === choice.value && { backgroundColor: colors.hover }]}
            >
              <AppText muted={language !== choice.value} size={12}>{choice.title}</AppText>
            </Pressable>)}
          </View>
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  body: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  form: { width: "100%", maxWidth: 380 },
  serverToggle: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "center",
    gap: 5,
    paddingVertical: 18,
  },
  defaultServer: { alignSelf: "center", minHeight: 44, justifyContent: "center" },
  languages: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 4, marginTop: 8 },
  language: { minHeight: 44, justifyContent: "center", paddingHorizontal: 9, borderRadius: 14 },
});
