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
  const { colors, loading, authError, signIn } = useApp();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const compact = height < 500;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState(getAPIBaseURL());
  const [serverOpen, setServerOpen] = useState(() => !isConfiguredAPIBaseURL() || getAPIBaseURL() !== DEFAULT_API_BASE_URL);
  const [error, setError] = useState("");
  async function login() {
    if (!username.trim() || !password || loading || !isConfiguredAPIBaseURL(server)) return;
    setError("");
    try {
      await signIn(username.trim(), password, server);
      router.replace("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
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
            label="账号"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
            value={username}
            onChangeText={setUsername}
            returnKeyType="next"
          />
          <Field
            label="密码"
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
            登录
          </Button>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: serverOpen }}
            disabled={loading}
            onPress={() => setServerOpen(!serverOpen)}
            style={styles.serverToggle}
          >
            <AppText muted size={13}>
              使用自部署后端
            </AppText>
            {serverOpen ? (
              <ChevronUp size={14} color={colors.muted} />
            ) : (
              <ChevronDown size={14} color={colors.muted} />
            )}
          </Pressable>
          {serverOpen && (
            <View>
              <Field
                label="服务地址"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="https://your-server.com"
                value={server}
                onChangeText={setServer}
                editable={!loading}
              />
              <AppText muted size={12}>
                支持 HTTP 和 HTTPS。HTTP 不加密，请仅在可信网络使用。
              </AppText>
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
                  <AppText muted size={13}>使用 Ochi 默认服务</AppText>
                </Pressable>
              )}
            </View>
          )}
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
});
