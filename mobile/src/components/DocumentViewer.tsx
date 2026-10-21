import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, Linking, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { StatusBar } from "expo-status-bar";
import { FileText, Share2, X } from "lucide-react-native";
import Pdf from "react-native-pdf";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { fileURL, getAPIBaseURL } from "../lib/api";
import type { Artifact } from "../lib/types";
import { useApp, useTheme } from "../providers/AppProvider";
import { IconButton } from "../ui/IconButton";
import { modalOrientations } from "../ui/overlayGeometry";
import { AppText, Button, ErrorNotice } from "./ScreenChrome";
import { Markdown } from "./Markdown";
import { downloadArtifact, fileSize, fileType, shareArtifact, type LocalArtifact } from "./artifactFiles";

const textPreviewLimit = 4 * 1024 * 1024;

export function openDocumentLink(value: string) {
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password)
      void Linking.openURL(url.href).catch(() => undefined);
  } catch { /* PDF links can also be internal document destinations. */ }
}

export function DocumentViewer({ file, onClose }: { file: Artifact; onClose: () => void }) {
  const { user } = useApp();
  // Changing account, backend, artifact or version must not reuse another preview's bytes/state.
  const identity = JSON.stringify([getAPIBaseURL(), user?.id, file.id, fileURL(file), file.version, file.size]);
  return <DocumentPreview key={identity} file={file} onClose={onClose} />;
}

function DocumentPreview({ file, onClose }: { file: Artifact; onClose: () => void }) {
  const { colors, dark } = useTheme();
  const type = fileType(file);
  const previewable = ["pdf", "html", "markdown", "code"].includes(type);
  const [source, setSource] = useState("");
  const [uri, setURI] = useState("");
  const [loading, setLoading] = useState(previewable);
  const [error, setError] = useState("");
  const [shareError, setShareError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [sharing, setSharing] = useState(false);
  const [pages, setPages] = useState({ page: 1, total: 0 });
  const active = useRef(true);
  const currentPreview = useRef({ uri, attempt });
  currentPreview.current = { uri, attempt };
  const isCurrentPreview = () => active.current && currentPreview.current.uri === uri && currentPreview.current.attempt === attempt;
  useEffect(() => {
    active.current = true;
    Keyboard.dismiss();
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let local: LocalArtifact | undefined;
    setSource(""); setURI(""); setError(""); setPages({ page: 1, total: 0 });
    setLoading(previewable);
    if (previewable) void (async () => {
      try {
        local = await downloadArtifact(file, controller.signal);
        if (controller.signal.aborted) return;
        if (type === "pdf") {
          setURI(local.uri);
          return;
        }
        const info = await FileSystem.getInfoAsync(local.uri);
        if (!info.exists) throw new Error("无法加载文件");
        if (info.size > textPreviewLimit) throw new Error("文件较大，请下载后查看");
        const text = await FileSystem.readAsStringAsync(local.uri);
        if (!controller.signal.aborted) { setSource(text); setURI(local.uri); setLoading(false); }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "无法加载文件");
          setLoading(false);
        }
      } finally {
        if (controller.signal.aborted) await local?.dispose().catch(() => undefined);
      }
    })();
    return () => {
      controller.abort();
      void local?.dispose().catch(() => undefined);
    };
  }, [file, type, attempt, previewable]);

  async function share() {
    if (sharing) return;
    setSharing(true); setShareError("");
    try { await shareArtifact(file, uri || undefined); }
    catch (reason) { if (active.current) setShareError(reason instanceof Error ? reason.message : "下载失败"); }
    finally { if (active.current) setSharing(false); }
  }
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "text";
  const language = ({ py: "python", js: "javascript", ts: "typescript", sh: "bash", yml: "yaml", svg: "xml", txt: "text", log: "text" } as Record<string, string>)[extension] ?? extension;
  const fence = "`".repeat(Math.max(3, ...(source.match(/`+/g) ?? []).map((value) => value.length + 1)));
  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" supportedOrientations={modalOrientations} onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <SafeAreaProvider style={[styles.root, { backgroundColor: colors.canvas }]}>
        <StatusBar style={dark ? "light" : "dark"} />
        <SafeAreaView style={styles.root}>
          <View style={[styles.toolbar, { borderBottomColor: colors.border }]}>
            <IconButton icon={X} label="关闭文件" onPress={onClose} variant="glass" size={44} />
            <View style={styles.title}>
              <AppText size={15} weight="medium" numberOfLines={1}>{file.name}</AppText>
              <AppText muted size={12}>{pages.total ? `${pages.page} / ${pages.total} 页 · ` : ""}{fileSize(file.size)}</AppText>
            </View>
            <IconButton icon={Share2} label="下载或分享" disabled={sharing} onPress={() => void share()} variant="glass" size={44} />
          </View>
          {["html", "markdown"].includes(type) && (
            <View style={styles.modeToolbar}>
              <View style={[styles.segment, { backgroundColor: colors.hover }]}>
                {(["preview", "source"] as const).map((value) => (
                  <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: mode === value }} onPress={() => setMode(value)} style={[styles.segmentItem, mode === value && { backgroundColor: colors.raised }]}>
                    <AppText size={13} weight="medium">{value === "preview" ? "预览" : "源码"}</AppText>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
          <ErrorNotice error={shareError} />
          <View style={[styles.preview, { backgroundColor: colors.surface }]}>
            {Boolean(error) ? (
              <ScrollView contentContainerStyle={styles.empty}>
                <FileText size={40} color={colors.muted} />
                <AppText accessibilityRole="alert" style={styles.centered}>{error}</AppText>
                <Button onPress={() => setAttempt((value) => value + 1)}>重新加载</Button>
              </ScrollView>
            ) : type === "pdf" && uri ? (
              <Pdf key={`${uri}:${attempt}`} source={{ uri, cache: false }} trustAllCerts={false} fitPolicy={0} maxScale={5} enableDoubleTapZoom enableTextSelection
                onLoadComplete={(total) => { if (isCurrentPreview()) { setPages({ page: 1, total }); setLoading(false); } }}
                onPageChanged={(page, total) => { if (isCurrentPreview()) setPages({ page, total }); }}
                onError={() => { if (isCurrentPreview()) { setError("无法打开 PDF，文件可能损坏或需要密码"); setLoading(false); } }}
                onPressLink={openDocumentLink}
                renderActivityIndicator={() => <ActivityIndicator color={colors.muted} />}
                style={[styles.root, { backgroundColor: colors.surface }]} />
            ) : loading ? null : type === "html" && mode === "preview" ? (
              <WebView incognito source={{ html: source, baseUrl: "about:blank" }}
                startInLoadingState renderLoading={() => <ActivityIndicator color={colors.muted} style={styles.loading} />}
                onError={() => { if (isCurrentPreview()) setError("无法打开预览"); }}
                originWhitelist={["*"]} javaScriptEnabled mixedContentMode="never" setSupportMultipleWindows={false}
                allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
                onShouldStartLoadWithRequest={(request) => {
                  if (request.url === "about:blank" || request.url.startsWith("data:")) return true;
                  if (request.isTopFrame) { openDocumentLink(request.url); return false; }
                  return /^https?:/.test(request.url);
                }}
                style={[styles.root, { backgroundColor: colors.canvas }]} />
            ) : type === "markdown" && mode === "preview" ? (
              <ScrollView contentContainerStyle={styles.textPreview}><Markdown content={source} /></ScrollView>
            ) : type === "code" || mode === "source" ? (
              <ScrollView contentContainerStyle={styles.textPreview}><Markdown content={`${fence}${language}\n${source}\n${fence}`} /></ScrollView>
            ) : (
              <ScrollView contentContainerStyle={styles.empty}>
                <FileText size={44} color={colors.muted} />
                <AppText numberOfLines={2} style={styles.centered}>{file.name}</AppText>
                <AppText muted size={14}>此格式暂不支持预览</AppText>
                <Button busy={sharing} onPress={() => void share()}>下载文件</Button>
              </ScrollView>
            )}
            {loading && !error && <View pointerEvents="none" style={[styles.loading, { backgroundColor: colors.surface }]}><ActivityIndicator color={colors.muted} /></View>}
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, minWidth: 0, gap: 1 },
  preview: { flex: 1, minHeight: 0, overflow: "hidden" },
  modeToolbar: { alignItems: "center", paddingVertical: 7 },
  segment: { flexDirection: "row", padding: 3, borderRadius: 10 },
  segmentItem: { paddingHorizontal: 18, paddingVertical: 7, borderRadius: 7 },
  textPreview: { width: "100%", maxWidth: 720, alignSelf: "center", padding: 18 },
  empty: { flexGrow: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centered: { textAlign: "center" },
  loading: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, justifyContent: "center", alignItems: "center" },
});
