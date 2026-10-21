import { memo, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import {
  FileText,
  ImageIcon,
  Play,
  X,
} from "lucide-react-native";
import { resourceHeaders, fileURL, imageSource } from "../lib/api";
import type { Artifact } from "../lib/types";
import { useTheme } from "../providers/AppProvider";
import { ActionIcon, AppText, ErrorNotice } from "./ScreenChrome";
import { ImageViewer, measureImageOrigin, type ImageOrigin } from "./ImageViewer";
import { DocumentViewer } from "./DocumentViewer";
import { fileSize, fileType } from "./artifactFiles";
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
});
