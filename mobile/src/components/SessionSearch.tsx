import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { Search, X } from "lucide-react-native";
import {
  useGenericKeyboardHandler,
  useKeyboardContext,
} from "react-native-keyboard-controller";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../lib/api";
import type { Session } from "../lib/types";
import { useTheme } from "../providers/AppProvider";
import { GlassSurface } from "../ui/GlassSurface";
import { IconButton } from "../ui/IconButton";
import { ActionIcon, AppText, EmptyState, ErrorNotice } from "./ScreenChrome";

export function sessionDate(value: string) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "今天";
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export function SessionSearch({
  visible,
  onClose,
  onSelect,
  projectId,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (session: Session) => void;
  projectId?: string;
}) {
  const { colors, fonts, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const viewport = useWindowDimensions();
  const shortViewport = viewport.width > viewport.height && viewport.height < 600;
  const reducedMotion = useReducedMotion();
  const { reanimated } = useKeyboardContext();
  const keyboardHeight = useSharedValue(Math.max(0, -reanimated.height.value));
  const keyboardProgress = useSharedValue(reanimated.progress.value);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Session[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const loadingMore = useRef(false);
  const pageRequest = useRef<AbortController | null>(null);
  const itemProject = useRef(projectId);
  const input = useRef<TextInput>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingSelection = useRef<{ session: Session; owner: number; onSelect: (session: Session) => void } | null>(null);
  const presentation = useRef({ visible: false, projectId, owner: 0 });
  // Give each opening its own native Modal/event owner, including late dismissals.
  if (visible && (!presentation.current.visible || presentation.current.projectId !== projectId)) presentation.current.owner += 1;
  presentation.current.visible = visible;
  presentation.current.projectId = projectId;
  const owner = presentation.current.owner;
  const mounted = useRef(true);
  const latest = useRef({ visible, onClose, onSelect, owner });
  latest.current = { visible, onClose, onSelect, owner };
  const normalizedQuery = query.trim();

  useEffect(() => () => clearTimeout(focusTimer.current), [visible, owner]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingSelection.current = null;
    };
  }, []);

  // The opaque full-screen canvas stays fixed; only the input/results avoid the IME.
  useGenericKeyboardHandler(
    {
      onStart: (event) => {
        "worklet";
        if (event.duration === 0) {
          keyboardHeight.value = Math.max(0, event.height);
          keyboardProgress.value = Math.max(0, Math.min(1, event.progress));
        }
      },
      onMove: (event) => {
        "worklet";
        keyboardHeight.value = Math.max(0, event.height);
        keyboardProgress.value = Math.max(0, Math.min(1, event.progress));
      },
      onInteractive: (event) => {
        "worklet";
        keyboardHeight.value = Math.max(0, event.height);
        keyboardProgress.value = Math.max(0, Math.min(1, event.progress));
      },
      onEnd: (event) => {
        "worklet";
        keyboardHeight.value = Math.max(0, event.height);
        keyboardProgress.value = Math.max(0, Math.min(1, event.progress));
      },
    },
    [],
  );
  const avoidance = useAnimatedStyle(() => ({
    paddingBottom:
      keyboardHeight.value + insets.bottom * (1 - keyboardProgress.value),
  }));
  const finishSelection = useCallback((dismissedOwner: number) => {
    const selected = pendingSelection.current;
    if (!mounted.current || latest.current.visible || latest.current.owner !== dismissedOwner || selected?.owner !== dismissedOwner) return;
    pendingSelection.current = null;
    selected.onSelect(selected.session);
  }, []);
  useEffect(() => {
    if (visible) {
      pendingSelection.current = null;
      return;
    }
    // iOS waits for the native dismissal; Android removes the Dialog on this commit.
    if (Platform.OS === "ios" || !pendingSelection.current) return;
    const frame = requestAnimationFrame(() => finishSelection(owner));
    return () => cancelAnimationFrame(frame);
  }, [visible, owner, finishSelection]);
  useEffect(() => {
    const current = ++sequence.current;
    pageRequest.current?.abort();
    loadingMore.current = false;
    setPaging(false);
    if (itemProject.current !== projectId) {
      itemProject.current = projectId;
      setItems([]);
    }
    if (!visible) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setCursor(undefined);
    const timer = setTimeout(
      () => {
        void api
          .sessionsPage(
            { q: normalizedQuery, project_id: projectId, limit: 40 },
            controller.signal,
          )
          .then((page) => {
            if (!controller.signal.aborted && current === sequence.current) {
              setItems(page.items ?? []);
              setCursor(page.next_cursor);
            }
          })
          .catch((reason) => {
            if (!controller.signal.aborted && current === sequence.current)
              setError(reason instanceof Error ? reason.message : "搜索失败");
          })
          .finally(() => {
            if (!controller.signal.aborted && current === sequence.current)
              setLoading(false);
          });
      },
      normalizedQuery ? 230 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
      pageRequest.current?.abort();
      if (current === sequence.current) sequence.current += 1;
    };
  }, [normalizedQuery, projectId, visible]);
  async function more() {
    if (!visible || !cursor || loading || loadingMore.current) return;
    const current = sequence.current;
    const controller = new AbortController();
    pageRequest.current = controller;
    loadingMore.current = true;
    setPaging(true);
    try {
      const page = await api.sessionsPage(
        { q: normalizedQuery, project_id: projectId, cursor, limit: 40 },
        controller.signal,
      );
      if (!controller.signal.aborted && current === sequence.current) {
        setItems((previous) => [
          ...previous,
          ...page.items.filter(
            (item) => !previous.some((existing) => existing.id === item.id),
          ),
        ]);
        setCursor(page.next_cursor);
        setError("");
      }
    } catch (reason) {
      if (!controller.signal.aborted && current === sequence.current)
        setError(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      if (current === sequence.current) {
        loadingMore.current = false;
        setPaging(false);
      }
    }
  }
  function close() {
    if (!mounted.current || !latest.current.visible || latest.current.owner !== owner) return;
    pendingSelection.current = null;
    Keyboard.dismiss();
    latest.current.onClose();
  }
  function select(session: Session) {
    if (!mounted.current || !latest.current.visible || latest.current.owner !== owner || pendingSelection.current) return;
    pendingSelection.current = { session, owner, onSelect: latest.current.onSelect };
    Keyboard.dismiss();
    latest.current.onClose();
  }
  const background = dark ? "#000000" : "#fafafa";
  return (
    <Modal
      key={owner}
      visible={visible}
      // Keep the presenting native-stack screen appeared; fullScreen emits a false route departure.
      presentationStyle="overFullScreen"
      animationType={reducedMotion ? "none" : "fade"}
      backdropColor={background}
      statusBarTranslucent
      navigationBarTranslucent
      supportedOrientations={["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]}
      hardwareAccelerated
      onRequestClose={close}
      onDismiss={() => finishSelection(owner)}
      onShow={() => {
        if (!mounted.current || !latest.current.visible || latest.current.owner !== owner) return;
        clearTimeout(focusTimer.current);
        const focus = () => { if (mounted.current && latest.current.visible && latest.current.owner === owner) input.current?.focus(); };
        // Android's new Dialog needs window focus before requesting the IME.
        if (Platform.OS === "android") focusTimer.current = setTimeout(focus, 150);
        else focus();
      }}
    >
      <View
        style={[styles.root, { backgroundColor: background }]}
        accessibilityViewIsModal
      >
        <View style={[styles.header, { paddingTop: insets.top + (shortViewport ? 3 : 8), paddingLeft: (insets.left || 0) + 16, paddingRight: (insets.right || 0) + 16 }, shortViewport && { paddingBottom: 4 }]}>
          <View style={styles.headerSpacer} />
          <AppText
            size={17}
            weight="medium"
            accessibilityRole="header"
            style={styles.title}
          >
            搜索对话
          </AppText>
          <IconButton icon={X} label="关闭搜索" variant="glass" onPress={close} />
        </View>
        <Animated.View style={[styles.body, { paddingLeft: insets.left, paddingRight: insets.right }, avoidance]}>
          <FlatList
            style={styles.results}
            data={items}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
            onEndReached={() => void more()}
            onEndReachedThreshold={0.4}
            contentContainerStyle={styles.resultContent}
            ListHeaderComponent={<ErrorNotice error={error} />}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={item.title}
                onPress={() => select(item)}
                style={({ pressed }) => [
                  styles.result,
                  pressed && { backgroundColor: colors.hover },
                ]}
              >
                <AppText numberOfLines={2} size={16}>
                  {item.title}
                </AppText>
                {normalizedQuery && item.excerpt ? (
                  <AppText muted size={13} numberOfLines={2}>
                    {item.excerpt}
                  </AppText>
                ) : null}
                <AppText muted size={12}>
                  {sessionDate(item.updated_at)}
                  {item.project_name ? ` · ${item.project_name}` : ""}
                </AppText>
              </Pressable>
            )}
            ListEmptyComponent={
              loading ? (
                <ActivityIndicator color={colors.muted} style={{ padding: 20 }} />
              ) : (
                <EmptyState
                  icon={Search}
                  text={normalizedQuery ? "没有找到对话" : "暂无对话"}
                />
              )
            }
            ListFooterComponent={
              paging ? (
                <ActivityIndicator color={colors.muted} style={{ padding: 16 }} />
              ) : null
            }
          />
          <View style={styles.searchBottom}>
            <GlassSurface style={styles.searchField}>
              {loading ? (
                <ActivityIndicator size={20} color={colors.muted} />
              ) : (
                <Search size={20} color={colors.muted} />
              )}
              <TextInput
                ref={input}
                accessibilityLabel="搜索对话"
                value={query}
                onChangeText={setQuery}
                placeholder="搜索"
                placeholderTextColor={colors.subtle}
                returnKeyType="search"
                disableFullscreenUI
                submitBehavior="blurAndSubmit"
                onSubmitEditing={() => Keyboard.dismiss()}
                style={[
                  styles.input,
                  { color: colors.text, fontFamily: fonts.regular },
                ]}
              />
              {query ? (
                <ActionIcon
                  icon={X}
                  label="清空搜索"
                  size={16}
                  onPress={() => {
                    setQuery("");
                    input.current?.focus();
                  }}
                />
              ) : null}
            </GlassSurface>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 12,
  },
  headerSpacer: { width: 44 },
  title: { flex: 1, textAlign: "center" },
  body: { flex: 1 },
  results: { flex: 1, width: "100%", maxWidth: 780, alignSelf: "center" },
  resultContent: { paddingHorizontal: 14, paddingBottom: 18 },
  result: {
    minHeight: 72,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 12,
    gap: 4,
  },
  searchBottom: { width: "100%", maxWidth: 780, alignSelf: "center", paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12 },
  searchField: {
    borderRadius: 26,
    paddingLeft: 16,
    flexDirection: "row",
    alignItems: "center",
    minHeight: 50,
  },
  input: { flex: 1, fontSize: 16, paddingHorizontal: 10, paddingVertical: 12 },
});
