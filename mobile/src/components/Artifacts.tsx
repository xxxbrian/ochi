import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import {
  FileText,
  ImageIcon,
  Play,
  Share2,
  X,
} from "lucide-react-native";
import { WebView } from "react-native-webview";
import { resourceHeaders, fileURL, imageSource } from "../lib/api";
import type { Artifact } from "../lib/types";
import { useTheme } from "../providers/AppProvider";
import { Sheet } from "../ui/Sheet";
import { ActionIcon, AppText, Button, ErrorNotice } from "./ScreenChrome";
import { Markdown } from "./Markdown";
import { ImageViewer, measureImageOrigin, type ImageOrigin } from "./ImageViewer";
import { fileSize, fileType, shareArtifact } from "./artifactFiles";
export { fileSize, fileType } from "./artifactFiles";

export const ArtifactCards = memo(function ArtifactCards({
  files,
  compact = false,
  onRemove,
}: {
  files?: Artifact[];
  compact?: boolean;
  onRemove?: (id: string) => void;
}) {
  const { colors } = useTheme();
  const [selected, setSelected] = useState<{ file: Artifact; origin?: ImageOrigin } | null>(null);
  const [imageTransitionActive, setImageTransitionActive] = useState(false);
  if (!files?.length) return null;
  return (
    <>
      <View style={[styles.files, compact && styles.compactFiles]}>
        {files.map((file) => {
          const type = fileType(file);
          if (type === "image" && !compact)
            return (
              <ImageCard
                key={file.id}
                file={file}
                hidden={imageTransitionActive && selected?.file.id === file.id}
                onPress={(origin) => setSelected({ file, origin })}
              />
            );
          if (type === "image" && compact)
            return (
              <ImageThumbnail
                key={file.id}
                file={file}
                hidden={imageTransitionActive && selected?.file.id === file.id}
                onPress={(origin) => setSelected({ file, origin })}
                onRemove={onRemove}
              />
            );
          const Icon =
            type === "html" ? Play : type === "image" ? ImageIcon : FileText;
          return (
            <View
              key={file.id}
              style={[
                styles.file,
                { backgroundColor: colors.surface, borderColor: colors.border },
                compact && styles.compactFile,
              ]}
            >
              <Pressable
                style={styles.fileOpen}
                onPress={() => setSelected({ file })}
                accessibilityLabel={`打开 ${file.name}`}
              >
                <Icon size={20} color={colors.muted} strokeWidth={1.7} />
                <View style={{ flex: 1 }}>
                  <AppText size={14} weight="medium" numberOfLines={1}>
                    {file.name}
                  </AppText>
                  <AppText muted size={12}>
                    {fileSize(file.size)}
                    {file.version && file.version > 1
                      ? ` · v${file.version}`
                      : ""}
                  </AppText>
                </View>
              </Pressable>
              {onRemove && (
                <ActionIcon
                  icon={X}
                  size={16}
                  label={`移除 ${file.name}`}
                  onPress={() => onRemove(file.id)}
                />
              )}
            </View>
          );
        })}
      </View>
      {selected && (
        <ArtifactViewer file={selected.file} origin={selected.origin} onClose={() => setSelected(null)} onTransitionActive={setImageTransitionActive} />
      )}
    </>
  );
});

function ImageThumbnail({ file, hidden, onPress, onRemove }: {
  file: Artifact; hidden?: boolean; onPress: (origin?: ImageOrigin) => void; onRemove?: (id: string) => void;
}) {
  const { colors } = useTheme();
  const view = useRef<View>(null);
  const [ratio, setRatio] = useState<number>();
  return (
    <View style={[styles.thumbnail, { backgroundColor: colors.surface }]}>
      <Pressable ref={view} collapsable={false} accessibilityLabel={`查看 ${file.name}`} onPress={() => measureImageOrigin(view.current, 12, onPress, ratio)}>
        <Image source={imageSource(file)} style={[styles.thumbnailImage, { opacity: hidden ? 0 : 1 }]} onLoad={(event) => { const { width, height } = event.nativeEvent.source; if (width > 0 && height > 0) setRatio(width / height); }} />
      </Pressable>
      {onRemove && <ActionIcon icon={X} size={13} label={`移除 ${file.name}`} onPress={() => onRemove(file.id)} style={{ position: "absolute", top: 2, right: 2, width: 24, height: 24, backgroundColor: colors.surface }} />}
    </View>
  );
}

function ImageCard({ file, hidden, onPress }: { file: Artifact; hidden?: boolean; onPress: (origin?: ImageOrigin) => void }) {
  const { colors } = useTheme();
  const view = useRef<View>(null);
  const generation = file.generation;
  const [imageError, setImageError] = useState("");
  const [imageLoading, setImageLoading] = useState(true);
  const [ratio, setRatio] = useState(
    generation?.width && generation.height
      ? generation.width / generation.height
      : 1,
  );
  useEffect(() => {
    if (generation?.width && generation.height) return;
    Image.getSizeWithHeaders(
      fileURL(file.url),
      resourceHeaders(file),
      (width, height) => setRatio(width / Math.max(1, height)),
      () => undefined,
    );
  }, [file.url, generation?.width, generation?.height]);
  return (
    <Pressable
      ref={view}
      collapsable={false}
      accessibilityLabel={generation?.prompt || `查看 ${file.name}`}
      onPress={() => measureImageOrigin(view.current, 16, onPress, ratio)}
      style={[styles.imageFrame, { backgroundColor: colors.surface }]}
    >
      <Image
        source={imageSource(file)}
        resizeMode="contain"
        onLoadEnd={() => setImageLoading(false)}
        onError={(event) => {
          setImageLoading(false);
          setImageError("无法加载图片");
          console.warn("Ochi image load failed", event.nativeEvent.error);
        }}
        style={{ width: "100%", aspectRatio: ratio, opacity: hidden ? 0 : 1 }}
      />
      {imageLoading && (
        <ActivityIndicator
          color={colors.muted}
          style={StyleSheet.absoluteFill}
        />
      )}
      {imageError && (
        <View style={[StyleSheet.absoluteFill, { justifyContent: "center" }]}>
          <ErrorNotice error={imageError} />
        </View>
      )}
    </Pressable>
  );
}

export function ArtifactViewer({
  file,
  origin,
  onClose,
  onTransitionActive,
}: {
  file: Artifact;
  origin?: ImageOrigin;
  onClose: () => void;
  onTransitionActive?: (active: boolean) => void;
}) {
  return fileType(file) === "image"
    ? <ImageViewer file={file} origin={origin} onClose={onClose} onTransitionActive={onTransitionActive} />
    : <DocumentViewer file={file} onClose={onClose} />;
}

function DocumentViewer({ file, onClose }: { file: Artifact; onClose: () => void }) {
  const { colors } = useTheme();
  const type = fileType(file);
  const [source, setSource] = useState("");
  const headers = useMemo(() => resourceHeaders(file), [file.url]);
  const [loading, setLoading] = useState(
    ["html", "markdown", "code"].includes(type),
  );
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      if (!["html", "markdown", "code"].includes(type)) return;
      try {
        const response = await fetch(fileURL(file.url), {
          headers,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("无法加载文件");
        const text = await response.text();
        if (!controller.signal.aborted) setSource(text);
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "无法加载文件");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [file.url, type]);
  async function share() {
    if (sharing) return;
    setSharing(true);
    setError("");
    try {
      await shareArtifact(file);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "下载失败");
    } finally {
      setSharing(false);
    }
  }
  const lang =
    (
      {
        py: "python",
        js: "javascript",
        ts: "typescript",
        sh: "bash",
        yml: "yaml",
        svg: "xml",
      } as Record<string, string>
    )[file.name.split(".").pop() ?? ""] ??
    file.name.split(".").pop() ??
    "text";
  const fence = "`".repeat(
    Math.max(
      3,
      ...(source.match(/`+/g) ?? []).map((value) => value.length + 1),
    ),
  );
  return (
    <Sheet
      visible
      title={file.name}
      onClose={onClose}
      height="full"
    >
      <View style={styles.toolbar}>
        {["html", "markdown"].includes(type) && (
          <View style={[styles.segment, { backgroundColor: colors.hover }]}>
            {(["preview", "source"] as const).map((value) => (
              <Pressable
                key={value}
                onPress={() => setMode(value)}
                style={[
                  styles.segmentItem,
                  mode === value && { backgroundColor: colors.raised },
                ]}
              >
                <AppText size={13} weight="medium">
                  {value === "preview" ? "预览" : "源码"}
                </AppText>
              </Pressable>
            ))}
          </View>
        )}
        <View style={{ flex: 1 }} />
        <AppText muted size={12}>
          {fileSize(file.size)}
        </AppText>
        <ActionIcon
          icon={Share2}
          label="下载或分享"
          disabled={sharing}
          onPress={() => void share()}
        />
      </View>
      <ErrorNotice error={error} />
      <View style={styles.preview}>
        {loading ? (
          <ActivityIndicator color={colors.muted} style={{ flex: 1 }} />
        ) : type === "html" && mode === "preview" ? (
          <WebView
            incognito
            source={{ html: source, baseUrl: "about:blank" }}
            startInLoadingState
            renderLoading={() => (
              <View
                style={[
                  StyleSheet.absoluteFill,
                  {
                    justifyContent: "center",
                    backgroundColor: colors.canvas,
                  },
                ]}
              >
                <ActivityIndicator color={colors.muted} />
              </View>
            )}
            onError={() => setError("无法打开预览")}
            originWhitelist={["*"]}
            javaScriptEnabled
            mixedContentMode="never"
            setSupportMultipleWindows={false}
            onShouldStartLoadWithRequest={(request) => {
              if (
                request.url === "about:blank" ||
                request.url.startsWith("data:")
              )
                return true;
              if (request.isTopFrame && /^https?:/.test(request.url)) {
                void Linking.openURL(request.url).catch(() => undefined);
                return false;
              }
              return !request.isTopFrame;
            }}
            style={{ flex: 1, backgroundColor: colors.canvas }}
          />
        ) : type === "markdown" && mode === "preview" ? (
          <ScrollView contentContainerStyle={styles.textPreview}>
            <Markdown content={source} />
          </ScrollView>
        ) : type === "code" || mode === "source" ? (
          <ScrollView contentContainerStyle={styles.textPreview}>
            <Markdown content={`${fence}${lang}\n${source}\n${fence}`} />
          </ScrollView>
        ) : type === "pdf" && Platform.OS === "ios" ? (
          <WebView
            source={{ uri: fileURL(file.url), headers }}
            style={{ flex: 1 }}
          />
        ) : (
          <ScrollView contentContainerStyle={styles.binary}>
            <FileText size={44} color={colors.subtle} />
            <AppText numberOfLines={2}>{file.name}</AppText>
            <Button busy={sharing} onPress={() => void share()}>
              下载文件
            </Button>
          </ScrollView>
        )}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  files: { width: "100%", gap: 10, marginVertical: 8 },
  compactFiles: {
    width: undefined,
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 8,
  },
  thumbnail: { width: 72, height: 72, borderRadius: 12, overflow: "hidden" },
  thumbnailImage: { width: 72, height: 72 },
  file: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
  },
  compactFile: { maxWidth: 215 },
  fileOpen: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    padding: 12,
    flex: 1,
  },
  imageFrame: {
    borderRadius: 16,
    overflow: "hidden",
    width: "100%",
    maxWidth: 520,
  },
  toolbar: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  segment: { flexDirection: "row", padding: 3, borderRadius: 10 },
  segmentItem: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 7 },
  preview: { flex: 1, minHeight: 0 },
  textPreview: { width: "100%", maxWidth: 720, alignSelf: "center", padding: 18 },
  binary: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
  },
});
