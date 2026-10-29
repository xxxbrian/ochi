import { errorForDisplay, localizedError, type DisplayError } from "../lib/errors";
import { t, useI18n, getLocale } from "../lib/i18n";
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import {
  Brain,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { KeyboardAvoidingView, KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { api } from "../lib/api";
import type { Memory } from "../lib/types";
import { useApp } from "../providers/AppProvider";
import { IconButton } from "../ui/IconButton";
import { MenuTrigger } from "../ui/MenuTrigger";
import {
  AppText,
  Button,
  EmptyState,
  ErrorNotice,
  Field,
  LoadingState,
  SettingRow,
  Surface,
} from "../components/ScreenChrome";
import {
  SettingsHeader,
  SettingsPage,
  settingsStyles,
} from "../components/SettingsChrome";

export function MemoriesScreen() {
  useI18n();
  const { colors, preferences, refreshPreferences } = useApp();
  const [items, setItems] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.memories(undefined, query));
      setError("");
    } catch (reason) {
      setError(errorForDisplay(reason, "error.load"));
    } finally {
      setLoading(false);
    }
  }, [query]);
  useFocusEffect(
    useCallback(() => {
      const timer = setTimeout(() => void refresh(), query ? 230 : 0);
      return () => clearTimeout(timer);
    }, [refresh, query]),
  );
  async function toggle(enabled: boolean) {
    setMemoryBusy(true);
    try {
      await api.updatePreferences({ memory_enabled: enabled });
      await refreshPreferences();
    } catch (reason) {
      setError(errorForDisplay(reason, "error.save"));
    } finally {
      setMemoryBusy(false);
    }
  }
  function remove(memory: Memory) {
    Alert.alert(t("memory.deleteConfirm"), memory.content, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: () =>
          void api
            .deleteMemory(memory.id)
            .then(refresh)
            .catch((reason) =>
              setError(errorForDisplay(reason, "error.delete")),
            ),
      },
    ]);
  }
  return (
    <SettingsPage>
      <SettingsHeader
        title={t("memory.title")}
        right={
          <IconButton
            icon={Plus}
            label={t("memory.add")}
            variant="glass"
            size={42}
            onPress={() => router.push("/settings/memory/new")}
          />
        }
      />
      <KeyboardAvoidingView behavior="padding" automaticOffset style={{ flex: 1 }}>
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          refreshing={loading}
          onRefresh={() => void refresh()}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={settingsStyles.content}
          ListHeaderComponent={
            <View style={{ gap: 14, marginBottom: 6 }}>
              <Surface
                style={{
                  ...settingsStyles.group,
                  backgroundColor: colors.raised,
                }}
              >
                <SettingRow icon={Brain} title={t("process.saveMemory")} last>
                  <Switch
                    accessibilityLabel={t("process.saveMemory")}
                    value={preferences?.memory_enabled ?? true}
                    disabled={memoryBusy}
                    onValueChange={(enabled) => void toggle(enabled)}
                    trackColor={{ false: colors.border, true: colors.text }}
                    thumbColor={colors.raised}
                  />
                </SettingRow>
              </Surface>
              <Field
                label={t("memory.search")}
                value={query}
                onChangeText={setQuery}
                placeholder={t("common.search")}
              />
              <ErrorNotice error={error} retry={() => void refresh()} />
            </View>
          }
          renderItem={({ item }) => (
            <View style={[styles.memory, { borderBottomColor: colors.border }]}>
              <Pressable
                accessibilityRole="button"
                style={{ flex: 1, gap: 6 }}
                onPress={() => router.push(`/settings/memory/${item.id}`)}
              >
                <AppText size={15}>{item.content}</AppText>
                <AppText muted size={12}>
                  {item.source === "user"
                    ? t("memory.manual")
                    : item.kind === "project_summary"
                      ? t("memory.projectSummary")
                      : item.kind === "session_summary"
                        ? t("memory.chatSummary")
                        : t("memory.title")}
                  {" · "}
                  {new Date(
                    item.updated_at ?? item.created_at,
                  ).toLocaleDateString(getLocale())}
                </AppText>
              </Pressable>
              <MenuTrigger
                label={t("memory.options")}
                items={[
                  {
                    key: "rename",
                    title: t("common.edit"),
                    icon: Pencil,
                    onPress: () => router.push(`/settings/memory/${item.id}`),
                  },
                  {
                    key: "delete",
                    title: t("common.delete"),
                    icon: Trash2,
                    danger: true,
                    onPress: () => remove(item),
                  },
                ]}
              >
                <View style={styles.menuButton}>
                  <MoreHorizontal size={20} color={colors.muted} />
                </View>
              </MenuTrigger>
            </View>
          )}
          ListEmptyComponent={
            !loading ? (
              <EmptyState
                icon={Brain}
                text={query ? t("memory.noResults") : t("memory.none")}
              />
            ) : null
          }
        />
      </KeyboardAvoidingView>
    </SettingsPage>
  );
}

export function MemoryEditorScreen() {
  useI18n();
  const { memoryId } = useLocalSearchParams<{ memoryId: string }>();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(memoryId !== "new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  useEffect(() => {
    if (memoryId === "new") return;
    let disposed = false;
    void api
      .memories()
      .then((items) => {
        if (disposed) return;
        const memory = items.find((item) => item.id === memoryId);
        if (!memory) throw localizedError("error.memoryMissing");
        setContent(memory.content);
      })
      .catch((reason) => {
        if (!disposed)
          setError(errorForDisplay(reason, "error.load"));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [memoryId]);
  async function save() {
    if (!content.trim() || busy || loading) return;
    setBusy(true);
    setError("");
    try {
      if (memoryId === "new") await api.addMemory(content.trim());
      else await api.updateMemory(memoryId, content.trim());
      router.back();
    } catch (reason) {
      setError(errorForDisplay(reason, "error.save"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsPage>
      <SettingsHeader title={memoryId === "new" ? t("memory.add") : t("memory.edit")} />
      {loading ? (
        <LoadingState />
      ) : (
        <KeyboardAwareScrollView
          bottomOffset={16}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={settingsStyles.content}
        >
          <Field
            label={t("common.content")}
            value={content}
            onChangeText={setContent}
            multiline
            autoFocus
            style={{ minHeight: 152 }}
          />
          <ErrorNotice error={error} />
          <Button
            busy={busy}
            disabled={!content.trim()}
            onPress={() => void save()}
          >
            {t("common.save")}</Button>
        </KeyboardAwareScrollView>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  memory: {
    flexDirection: "row",
    gap: 10,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: "flex-start",
  },
  menuButton: {
    width: 36,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
});
