import { localizedError, type DisplayError } from "../lib/errors";
import { getLocale, t, useI18n } from "../lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
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
  useI18n();
  return <TrustedWebScreen title={t("computer.title")} path="/native/computer" />;
}
export function AdminScreen() {
  useI18n();
  return <TrustedWebScreen title={t("admin.title")} path="/admin/providers" />;
}

function TrustedWebScreen({ title, path }: { title: string; path: string }) {
  const { locale } = useI18n();
  const { colors, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const ref = useRef<WebView>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<DisplayError>("");
  const server = getAPIBaseURL();
  const configured = isConfiguredAPIBaseURL(server);
  // Bootstrap once; live language changes must not reload the remote desktop.
  const source = useMemo(
    () => configured ? webViewSource(path === "/native/computer" ? `${path}?locale=${getLocale()}` : path) : undefined,
    [path, retry, server, configured],
  );
  const origin = configured ? new URL(server).origin : undefined;
  const documentScript = `document.documentElement.dataset.theme='${dark ? "dark" : "light"}';document.documentElement.dataset.nativeShell='true';true;`;
  function updateViewerLocale() {
    if (path === "/native/computer") ref.current?.injectJavaScript(
      `window.dispatchEvent(new CustomEvent('ochi:native-locale',{detail:{locale:${JSON.stringify(getLocale())}}}));true;`,
    );
  }
  useEffect(updateViewerLocale, [locale, path]);
  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <PageHeader
        title={title}
        right={
          <ActionIcon
            icon={RefreshCw}
            label={t("computer.reconnect")}
            onPress={() => {
              setError("");
              setLoading(true);
              setRetry((value) => value + 1);
            }}
          />
        }
      />
      <ErrorNotice error={source ? error : t("error.configureServer")} safeArea />
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
            onLoadEnd={() => { updateViewerLocale(); setLoading(false); }}
            onError={() => {
              setLoading(false);
              setError(localizedError("error.connect"));
            }}
            onHttpError={() => {
              setError(localizedError("error.forbidden"));
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
