import { memo, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ArrowUp,
  Brain,
  Camera,
  Check,
  ChevronDown,
  File,
  ImageIcon,
  Monitor,
  Plus,
  Square,
  X,
} from "lucide-react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as SecureStore from "expo-secure-store";
import { api } from "../lib/api";
import type { InstructionAcceptance } from "../../../web/src/lib/runInstructions";
import type { Artifact, Message, Model, RunOptions } from "../lib/types";
import { useTheme } from "../providers/AppProvider";
import { GlassSurface } from "../ui/GlassSurface";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { Sheet } from "../ui/Sheet";
import { MenuTrigger } from "../ui/MenuTrigger";
import { IconButton } from "../ui/IconButton";
import {
  ActionIcon,
  AppText,
  Button,
  ErrorNotice,
  Field,
} from "./ScreenChrome";
import { ArtifactCards } from "./Artifacts";
import { ModelIcon } from "./ModelIcon";
import { anchorGeometryKey } from "../ui/overlayGeometry";

export type ComposerSubmission = {
  text: string;
  files: Artifact[];
  options: RunOptions;
};
type Props = {
  draftKey: string;
  models: Model[];
  modelId: string;
  effort: string;
  onModel: (id: string) => void;
  onEffort: (value: string) => void;
  computerEnabled: boolean;
  computerBusy?: boolean;
  onComputer: (enabled: boolean) => void;
  running?: boolean;
  stopping?: boolean;
  unavailable?: boolean;
  onStop: () => void;
  onSubmit: (value: ComposerSubmission) => Promise<void | boolean>;
  onSupplement?: (value: string) => Promise<boolean>;
  supplementBusy?: boolean;
  supplementAccepted?: InstructionAcceptance;
  freshDraft?: boolean;
  initialDraft?: string;
  editingMessage?: Message | null;
  onCancelEdit?: () => void;
  availableHeight?: number;
};
type Rect = { x: number; y: number; width: number; height: number };
type InputMeasurement = { key: string; scope: string; height: number };

export const Composer = memo(function Composer({
  draftKey,
  models,
  modelId,
  effort,
  onModel,
  onEffort,
  computerEnabled,
  computerBusy,
  onComputer,
  running,
  stopping,
  unavailable,
  onStop,
  onSubmit,
  onSupplement,
  supplementBusy,
  supplementAccepted,
  freshDraft = false,
  initialDraft,
  editingMessage,
  onCancelEdit,
  availableHeight,
}: Props) {
  const { colors, fonts, dark } = useTheme();
  const computerTrack = dark
    ? { false: "#474b52", true: "#808690" }
    : { false: "#c1c5cd", true: "#5b616b" };
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const shortViewport = width > height && height < 600;
  const compact = width < 430;
  const inputScope = `${draftKey}:${editingMessage?.id ?? "draft"}`;
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [files, setFiles] = useState<Artifact[]>([]);
  const [editDraft, setEditDraft] = useState("");
  const [editFiles, setEditFiles] = useState<Artifact[]>([]);
  const [initializedEditId, setInitializedEditId] = useState<string>();
  const [inputWidth, setInputWidth] = useState(0);
  const [inputMeasurements, setInputMeasurements] = useState<{
    draft?: InputMeasurement;
    edit?: InputMeasurement;
  }>({});
  const [posting, setPosting] = useState(false);
  const [uploadOperation, setUploadOperation] = useState<{ scope: string; id: number } | null>(null);
  const uploading = uploadOperation?.scope === inputScope;
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<"attachments" | "models" | "efforts" | null>(
    null,
  );
  const lastMenuKind = useRef<NonNullable<typeof menu>>("models");
  if (menu) lastMenuKind.current = menu;
  // Closing keeps the current menu geometry/content until its exit finishes.
  const menuKind = menu ?? lastMenuKind.current;
  const [anchor, setAnchor] = useState<Rect>({
    x: 0,
    y: 0,
    width: 44,
    height: 44,
  });
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [budget, setBudget] = useState("2048");
  const attachmentRef = useRef<View>(null);
  const modelRef = useRef<View>(null);
  const effortRef = useRef<View>(null);
  const inputRef = useRef<TextInput>(null);
  const draftVersion = useRef(0);
  const mounted = useRef(true);
  const uploadSequence = useRef(0);
  const editReady = initializedEditId === editingMessage?.id;
  const displayedDraft = editingMessage ? (editReady ? editDraft : editingMessage.content) : draft;
  const displayedFiles = editingMessage ? (editReady ? editFiles : editingMessage.attachments ?? []) : files;
  const changeDraft = editingMessage ? setEditDraft : setDraft;
  const changeFiles = editingMessage ? setEditFiles : setFiles;
  const currentInputScope = useRef(inputScope);
  currentInputScope.current = inputScope;
  const latestInput = useRef({ text: displayedDraft, files: displayedFiles });
  latestInput.current = { text: displayedDraft, files: displayedFiles };
  const inputLimit = shortViewport ? 72 : editingMessage ? 224 : 136;
  const accessoryHeight = (editingMessage ? 40 : 0) + (displayedFiles.length ? 88 : 0);
  const maximumInputHeight = availableHeight && availableHeight > 0
    ? Math.max(32, Math.min(inputLimit, availableHeight - accessoryHeight - (shortViewport ? 30 : 100)))
    : inputLimit;
  const inputMeasurementKey = JSON.stringify([
    inputScope, displayedDraft, inputWidth, fonts.regular, fontScale, maximumInputHeight,
  ]);
  const latestMeasurementKey = useRef(inputMeasurementKey);
  latestMeasurementKey.current = inputMeasurementKey;
  const measurementKind = editingMessage ? "edit" : "draft";
  const inputMeasurement = inputMeasurements[measurementKind];
  // Keep the previous measured height while typing; cancel restores the separate draft measurement.
  const inputHeight = displayedDraft && inputMeasurement?.scope === inputScope
    ? Math.min(maximumInputHeight, inputMeasurement.height)
    : 32;
  const geometry = anchorGeometryKey(width, insets);
  const menuGeometry = useRef(geometry);
  menuGeometry.current = geometry;
  useEffect(() => { setMenu(null); }, [geometry]);
  function measureInputHeight(value: number) {
    if (!mounted.current || latestMeasurementKey.current !== inputMeasurementKey) return;
    const height = Math.min(maximumInputHeight, Math.max(32, Math.ceil(value)));
    setInputMeasurements((current) => {
      if (!mounted.current || latestMeasurementKey.current !== inputMeasurementKey) return current;
      const previous = current[measurementKind];
      const measuredHeight = previous?.key === inputMeasurementKey ? Math.max(previous.height, height) : height;
      return previous?.key === inputMeasurementKey && previous.height === measuredHeight
        ? current
        : { ...current, [measurementKind]: { key: inputMeasurementKey, scope: inputScope, height: measuredHeight } };
    });
  }
  const model = models.find((item) => item.id === modelId);
  const busy = posting || uploading || Boolean(unavailable) || Boolean(supplementBusy);
  const canThink =
    Boolean(model?.effort_parameter) &&
    ["effort", "toggle", "budget"].includes(model?.reasoning_kind ?? "");
  const effortValues =
    model?.reasoning_kind === "toggle" ? ["on", "off"] : (model?.efforts ?? []);
  const budgetValue = effort.startsWith("budget:")
    ? effort.slice(7)
    : String(model?.reasoning_budget_default ?? 2048);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      draftVersion.current += 1;
    };
  }, []);
  useEffect(() => {
    const version = ++draftVersion.current;
    setFiles([]);
    setError("");
    setPosting(false);
    setUploadOperation(null);
    setDraft(initialDraft ?? "");
    const key = `draft.${draftKey.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
    const startsFresh = freshDraft && draftKey.startsWith("new-");
    if (startsFresh) void SecureStore.deleteItemAsync(key).catch(() => undefined);
    else if (!initialDraft)
      void SecureStore.getItemAsync(key)
        .then((value) => {
          if (version === draftVersion.current && value) setDraft(value);
        })
        .catch(() => undefined);
  }, [draftKey, initialDraft, freshDraft]);
  useEffect(() => {
    setInitializedEditId(editingMessage?.id);
    if (!editingMessage) return;
    // Revision input is separate from the ordinary draft, so cancel is lossless.
    setEditDraft(editingMessage.content);
    setEditFiles(editingMessage.attachments ?? []);
    setError("");
    const timer = setTimeout(() => {
      if (currentInputScope.current !== inputScope) return;
      const input = inputRef.current;
      if (!input) return;
      // Reset draft scroll position without remounting or cycling native focus.
      if (!input.isFocused()) input.focus();
      input.setNativeProps({ selection: { start: 0, end: 0 } });
    }, 80);
    return () => clearTimeout(timer);
  }, [editingMessage?.id]);
  useEffect(() => {
    const timer = setTimeout(() => {
      const key = `draft.${draftKey.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
      void (
        draft
          ? SecureStore.setItemAsync(key, draft)
          : SecureStore.deleteItemAsync(key)
      ).catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, draftKey]);
  useEffect(() => {
    const current = latestInput.current;
    if (supplementAccepted && !editingMessage && !current.files.length && current.text.trim() === supplementAccepted.content)
      setDraft("");
  }, [supplementAccepted?.id]);
  function openMenu(
    kind: NonNullable<typeof menu>,
    ref: React.RefObject<View | null>,
  ) {
    const measuredGeometry = menuGeometry.current;
    ref.current?.measureInWindow((x, y, width, height) => {
      if (!mounted.current || measuredGeometry !== menuGeometry.current || currentInputScope.current !== inputScope) return;
      setAnchor({ x, y, width, height });
      setMenu(kind);
    });
  }
  async function pick(kind: "camera" | "photos" | "files") {
    if (currentInputScope.current !== inputScope) return;
    const version = draftVersion.current;
    const isCurrent = () => version === draftVersion.current && currentInputScope.current === inputScope;
    setMenu(null);
    setError("");
    const operation = { scope: inputScope, id: ++uploadSequence.current };
    setUploadOperation(operation);
    try {
      let chosen: {
        uri: string;
        name: string;
        mimeType?: string;
        size?: number;
      }[] = [];
      if (kind === "files") {
        const result = await DocumentPicker.getDocumentAsync({
          multiple: true,
          copyToCacheDirectory: true,
        });
        if (!isCurrent()) return;
        if (result.canceled) return;
        chosen = result.assets.map((file) => ({
          uri: file.uri,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
        }));
      } else {
        const permission =
          kind === "camera"
            ? await ImagePicker.requestCameraPermissionsAsync()
            : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!isCurrent()) return;
        if (!permission.granted) {
          setError(kind === "camera" ? "请允许使用相机" : "请允许访问照片");
          return;
        }
        const result =
          kind === "camera"
            ? await ImagePicker.launchCameraAsync({ quality: 0.92 })
            : await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ["images", "videos"],
                allowsMultipleSelection: true,
                quality: 0.92,
              });
        if (!isCurrent()) return;
        if (result.canceled) return;
        chosen = result.assets.map((file, index) => ({
          uri: file.uri,
          name: file.fileName ?? `image-${Date.now()}-${index}.jpg`,
          mimeType: file.mimeType ?? "image/jpeg",
          size: file.fileSize,
        }));
      }
      for (const file of chosen) {
        if (file.size && file.size > 32 * 1024 * 1024)
          throw new Error("文件太大，请选择 32 MB 以内的文件");
        const uploaded = await api.upload(file);
        if (!isCurrent()) return;
        changeFiles((current) => [...current, uploaded]);
      }
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : "上传失败");
    } finally {
      // A draft upload must not lock editing or clear a newer upload's busy state.
      setUploadOperation((current) => current?.id === operation.id ? null : current);
    }
  }
  async function submit() {
    const text = displayedDraft.trim();
    if ((!text && !displayedFiles.length) || busy) return;
    const version = draftVersion.current;
    const revising = Boolean(editingMessage);
    setPosting(true);
    setError("");
    try {
      const accepted = await onSubmit({
        text,
        files: displayedFiles,
        options: {
          model_id: modelId,
          effort,
          attachment_ids: displayedFiles.map((file) => file.id),
          ...(model?.reasoning_kind === "budget"
            ? { budget_tokens: Number(budgetValue) }
            : {}),
          ...(model?.reasoning_kind === "toggle"
            ? { reasoning_enabled: effort !== "off" }
            : {}),
        },
      });
      if (!mounted.current || accepted === false) return;
      const sameScope = currentInputScope.current === inputScope;
      const unchanged = () =>
        version === draftVersion.current &&
        currentInputScope.current === inputScope &&
        latestInput.current.text === displayedDraft &&
        latestInput.current.files === displayedFiles;
      // Adoption can replace the input scope, but its accepted turn still owns the origin cache.
      if (!unchanged() && !(accepted === true && !sameScope && !revising)) return;
      if (!revising) {
        await SecureStore.deleteItemAsync(
          `draft.${draftKey.replace(/[^a-zA-Z0-9._-]/g, "-")}`,
        ).catch(() => undefined);
      }
      if (!mounted.current || !unchanged()) return;
      if (revising) {
        setEditDraft("");
        setEditFiles([]);
      } else {
        setDraft("");
        setFiles([]);
      }
    } catch (reason) {
      if (mounted.current && version === draftVersion.current && currentInputScope.current === inputScope)
        setError(reason instanceof Error ? reason.message : "发送失败");
    } finally {
      if (mounted.current && version === draftVersion.current) setPosting(false);
    }
  }
  async function supplement() {
    const text = displayedDraft.trim();
    if (!onSupplement || !text || displayedFiles.length || editingMessage || busy) return;
    const version = draftVersion.current;
    setPosting(true);
    try {
      const accepted = await onSupplement(text);
      if (accepted && mounted.current && version === draftVersion.current && currentInputScope.current === inputScope &&
        latestInput.current.text === displayedDraft && !latestInput.current.files.length) setDraft("");
    } finally {
      if (mounted.current && version === draftVersion.current && currentInputScope.current === inputScope) setPosting(false);
    }
  }
  const menuItems =
    menuKind === "attachments"
      ? [
          {
            key: "camera",
            title: "相机",
            icon: Camera,
            onPress: () => void pick("camera"),
          },
          {
            key: "photos",
            title: "照片或视频",
            icon: ImageIcon,
            onPress: () => void pick("photos"),
          },
          {
            key: "files",
            title: "文件",
            icon: File,
            onPress: () => void pick("files"),
          },
        ]
      : menuKind === "models"
        ? models.map((item) => ({
            key: item.id,
            title: item.name,
            subtitle: item.provider_name,
            leading: <ModelIcon model={item} size={22} />,
            selected: item.id === modelId,
            onPress: () => {
              onModel(item.id);
              setMenu(null);
            },
          }))
        : [
            {
              key: "default",
              title: "默认",
              selected: !effort,
              onPress: () => {
                onEffort("");
                setMenu(null);
              },
            },
            ...effortValues.map((value) => ({
              key: value,
              title: value,
              selected: effort === value,
              onPress: () => {
                onEffort(value);
                setMenu(null);
              },
            })),
          ];
  const attachments = [
    {
      key: "camera",
      title: "相机",
      icon: Camera,
      disabled: busy,
      onPress: () => void pick("camera"),
    },
    {
      key: "photos",
      title: "照片或视频",
      icon: ImageIcon,
      disabled: busy,
      onPress: () => void pick("photos"),
    },
    {
      key: "files",
      title: "文件",
      icon: File,
      disabled: busy,
      onPress: () => void pick("files"),
    },
  ];
  return (
    <View style={styles.outer}>
      <ErrorNotice error={error} />
      <GlassSurface
        interactive
        style={[styles.composer, shortViewport && styles.composerCompact, { borderColor: colors.border }]}
      >
        {editingMessage && (
          <View style={[styles.editHeading, { borderBottomColor: colors.border }]}>
            <AppText muted size={12}>编辑消息</AppText>
            <ActionIcon icon={X} label="取消编辑" size={17} disabled={posting || uploading} onPress={onCancelEdit ?? (() => undefined)} style={{ width: 36, height: 32 }} />
          </View>
        )}
        {displayedFiles.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <ArtifactCards
              files={displayedFiles}
              compact
              onRemove={(id) =>
                changeFiles((current) => current.filter((file) => file.id !== id))
              }
            />
          </ScrollView>
        )}
        {onSupplement && !editingMessage && <View style={styles.supplementRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="补充当前任务要求"
            accessibilityHint={displayedFiles.length ? "补充要求暂不支持附件" : undefined}
            disabled={!displayedDraft.trim() || displayedFiles.length > 0 || busy}
            onPress={() => void supplement()} style={({ pressed }) => [styles.supplement,
              { backgroundColor: pressed ? colors.hover : "transparent", opacity: !displayedDraft.trim() || displayedFiles.length || busy ? 0.4 : 1 }]}>
            <AppText muted size={12}>补充要求</AppText>
          </Pressable>
        </View>}
        <View style={[styles.entry, shortViewport && styles.entryCompact]}>
        <TextInput
          ref={inputRef}
          accessibilityLabel={editingMessage ? "编辑消息" : "消息"}
          testID="chat-input"
          placeholder="问点什么…"
          placeholderTextColor={colors.subtle}
          selectionColor={colors.text}
          textBreakStrategy="simple"
          lineBreakStrategyIOS="none"
          multiline
          disableFullscreenUI
          value={displayedDraft}
          onChangeText={changeDraft}
          onLayout={(event) => {
            if (mounted.current && currentInputScope.current === inputScope)
              setInputWidth(event.nativeEvent.layout.width);
          }}
          style={[
            styles.input,
            shortViewport && styles.inputCompact,
            {
              maxHeight: maximumInputHeight,
              height: inputHeight,
              color: colors.text,
              fontFamily: fonts.regular,
            },
          ]}
        />
        {inputWidth > 0 && (
          <View
            key={inputMeasurementKey}
            testID="chat-input-measure-container"
            collapsable={false}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
            style={styles.inputProbe}
          >
            <Text
              testID="chat-input-measure"
              textBreakStrategy="simple"
              lineBreakStrategyIOS="none"
              style={[styles.input, { width: inputWidth, fontFamily: fonts.regular }]}
              // Native frame height includes an empty caret line that iOS glyph metrics omit.
              onLayout={(event) => measureInputHeight(event.nativeEvent.layout.height)}
              onTextLayout={(event) => {
                const bottom = event.nativeEvent.lines.reduce(
                  (value, line) => Math.max(value, line.y + line.height), 0,
                );
                measureInputHeight(bottom + styles.input.paddingBottom);
              }}
            >
              {displayedDraft}
            </Text>
          </View>
        )}
        <View style={[styles.toolbar, shortViewport && styles.toolbarCompact]}>
          <MenuTrigger items={attachments} label="添加附件">
            <View
              style={{
                width: 44,
                height: 44,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Plus size={22} color={colors.text} strokeWidth={1.8} />
            </View>
          </MenuTrigger>
          <View ref={modelRef} collapsable={false} style={{ minWidth: 0 }}>
            <Pressable
              onPress={() => openMenu("models", modelRef)}
              accessibilityRole="button"
              accessibilityLabel={`模型 ${model?.name ?? "选择模型"}`}
              disabled={busy}
              hitSlop={2}
              style={({ pressed }) => [
                styles.modelTrigger,
                { backgroundColor: pressed ? colors.hover : "transparent" },
              ]}
            >
              <ModelIcon model={model} size={18} />
              {!compact && (
                <>
                  <AppText
                    size={13}
                    weight="medium"
                    numberOfLines={1}
                    style={{ maxWidth: 88 }}
                  >
                    {model?.name ?? "模型"}
                  </AppText>
                  <ChevronDown size={12} color={colors.muted} />
                </>
              )}
            </Pressable>
          </View>
          {canThink && (
            <View ref={effortRef} collapsable={false}>
              <Pressable
                onPress={() => {
                  if (model?.reasoning_kind === "budget") {
                    setBudget(budgetValue);
                    setBudgetOpen(true);
                  } else openMenu("efforts", effortRef);
                }}
                accessibilityRole="button"
                accessibilityLabel={`思考程度 ${effort || "默认"}`}
                disabled={busy}
                style={styles.effortTrigger}
              >
                <Brain size={17} color={colors.muted} />
                <AppText size={12} muted>
                  {model?.reasoning_kind === "budget"
                    ? Number(budgetValue).toLocaleString()
                    : effort || "默认"}
                </AppText>
              </Pressable>
            </View>
          )}
          <View style={{ flex: shortViewport ? 0 : 1, minWidth: 2 }} />
          <View style={styles.computer}>
            <Monitor size={16} color={colors.muted} />
            <View style={styles.switchTarget}>
              <Switch
                testID="computer-toggle"
                accessibilityLabel="允许使用电脑"
                value={computerEnabled}
                disabled={computerBusy || Boolean(unavailable)}
                onValueChange={onComputer}
                trackColor={computerTrack}
                thumbColor={Platform.OS === "ios" ? undefined : "#ffffff"}
                hitSlop={{ top: 20, bottom: 20, left: 5, right: 5 }}
                ios_backgroundColor={computerTrack.false}
                style={styles.switch}
              />
            </View>
          </View>
          {posting || uploading ? (
            <View style={[styles.send, { backgroundColor: colors.text }]}>
              <ActivityIndicator size="small" color={colors.canvas} />
            </View>
          ) : displayedDraft.trim() || displayedFiles.length ? (
            <IconButton
              icon={ArrowUp}
              label={editingMessage ? "重新发送" : running ? "加入队列" : "发送"}
              size={40}
              iconSize={21}
              variant="filled"
              disabled={busy}
              onPress={() => void submit()}
            />
          ) : running ? (
            stopping ? (
              <View style={[styles.send, { backgroundColor: colors.text }]}>
                <ActivityIndicator size="small" color={colors.canvas} />
              </View>
            ) : (
              <IconButton
                icon={Square}
                label="停止"
                size={40}
                iconSize={16}
                variant="filled"
                onPress={onStop}
              />
            )
          ) : (
            <View style={[styles.send, { backgroundColor: colors.border }]}>
              <ArrowUp size={21} color={colors.canvas} />
            </View>
          )}
        </View>
        </View>
      </GlassSurface>
      <AnchoredMenu
        visible={Boolean(menu)}
        anchor={anchor}
        onClose={() => setMenu(null)}
        items={menuItems}
        width={menuKind === "models" ? 292 : 230}
        preserveKeyboard
      />
      <Sheet
        visible={budgetOpen}
        title="思考预算"
        onClose={() => setBudgetOpen(false)}
        height={280}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20 }}>
          <Field
            label="Tokens"
            value={budget}
            onChangeText={setBudget}
            keyboardType="number-pad"
          />
          <Button
            onPress={() => {
              const number = Math.min(
                model?.reasoning_budget_max ?? 32000,
                Math.max(
                  model?.reasoning_budget_min ?? 1024,
                  Number(budget) || 2048,
                ),
              );
              onEffort(`budget:${number}`);
              setBudgetOpen(false);
            }}
          >
            完成
          </Button>
        </ScrollView>
      </Sheet>
    </View>
  );
});

const styles = StyleSheet.create({
  outer: {
    width: "100%",
    maxWidth: 780,
    alignSelf: "center",
    paddingHorizontal: 10,
    paddingTop: 5,
  },
  composer: {
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 5,
    paddingTop: 12,
    paddingBottom: 5,
    overflow: "hidden",
  },
  composerCompact: { paddingTop: 5, borderRadius: 24 },
  entry: { minWidth: 0 },
  entryCompact: { flexDirection: "row", alignItems: "center" },
  inputCompact: { flex: 1, minWidth: 64 },
  // A separate native Text probe sizes controlled revisions without remounting the input.
  input: {
    minHeight: 32,
    fontSize: 16,
    lineHeight: 24,
    marginHorizontal: 10,
    paddingTop: 0,
    paddingBottom: 4,
    paddingHorizontal: 0,
    includeFontPadding: false,
    textAlignVertical: "top",
  },
  // Android Text ignores pointerEvents; a real View gates the invisible probe.
  inputProbe: { position: "absolute", top: 0, left: 0, opacity: 0 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 2 },
  toolbarCompact: { flexShrink: 0 },
  supplementRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: -4 },
  supplement: { minHeight: 44, paddingHorizontal: 10, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  editHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: -7, marginBottom: 8, paddingLeft: 10, paddingRight: 1, borderBottomWidth: StyleSheet.hairlineWidth },
  modelTrigger: {
    minHeight: 40,
    minWidth: 40,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
  },
  effortTrigger: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 5,
  },
  computer: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    gap: 1,
    marginRight: 3,
  },
  switchTarget: { width: 50, height: 44, alignItems: "center", justifyContent: "center" },
  switch: { transform: [{ scale: 0.65 }] },
  send: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 2,
  },
});
