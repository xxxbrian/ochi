import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { RefreshCw } from "lucide-react-native";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getAPIBaseURL, isConfiguredAPIBaseURL, webViewSource } from "../lib/api";
import { useTheme } from "../providers/AppProvider";
import {
  ActionIcon,
  ErrorNotice,
  PageHeader,
} from "../components/ScreenChrome";

export function ComputerScreen() {
  return <TrustedWebScreen title="电脑" path="/native/computer" />;
}
export function AdminScreen() {
  return <TrustedWebScreen title="管理后台" path="/admin/providers" />;
}

function TrustedWebScreen({ title, path }: { title: string; path: string }) {
  const { colors, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const ref = useRef<WebView>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const server = getAPIBaseURL();
  const configured = isConfiguredAPIBaseURL(server);
  const source = useMemo(
    () => configured ? webViewSource(path) : undefined,
    [path, retry, server, configured],
  );
  const origin = configured ? new URL(server).origin : undefined;
  const documentScript = `document.documentElement.dataset.theme='${dark ? "dark" : "light"}';document.documentElement.dataset.nativeShell='true';true;`;
  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <PageHeader
        title={title}
        right={
          <ActionIcon
            icon={RefreshCw}
            label="重新连接"
            onPress={() => {
              setError("");
              setLoading(true);
              setRetry((value) => value + 1);
            }}
          />
        }
      />
      <ErrorNotice error={source ? error : "请先设置服务地址"} safeArea />
      <View style={{ flex: 1, marginLeft: insets.left, marginRight: insets.right, marginBottom: insets.bottom }}>
        {source && (
          <WebView
            key={retry}
            ref={ref}
            source={source}
            sharedCookiesEnabled
            javaScriptEnabled
            domStorageEnabled
            bounces={false}
            contentInsetAdjustmentBehavior="never"
            mixedContentMode="never"
            allowsInlineMediaPlayback
            keyboardDisplayRequiresUserAction={false}
            injectedJavaScriptBeforeContentLoaded={documentScript}
            injectedJavaScript={documentScript}
            onLoadEnd={() => setLoading(false)}
            onError={(event) => {
              setLoading(false);
              setError(event.nativeEvent.description || "无法连接");
            }}
            onHttpError={() => {
              setError("无法访问");
              setLoading(false);
            }}
            onShouldStartLoadWithRequest={(request) => {
              try {
                return (
                  new URL(request.url).origin === origin ||
                  request.url === "about:blank"
                );
              } catch {
                return false;
              }
            }}
            style={{ backgroundColor: colors.canvas }}
          />
        )}
        {source && loading && (
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { alignItems: "center", justifyContent: "center" },
            ]}
          >
            <ActivityIndicator color={colors.muted} />
          </View>
        )}
      </View>
    </View>
  );
}
