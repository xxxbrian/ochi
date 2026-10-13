import { useCallback, useRef, useState } from "react";
import {
  AppState,
  FlatList,
  Platform,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import { LockKeyhole, Puzzle } from "lucide-react-native";
import { useFocusEffect } from "expo-router";
import { api, getAPIBaseURL } from "../lib/api";
import type { Plugin } from "../lib/types";
import { useApp } from "../providers/AppProvider";
import {
  AppText,
  EmptyState,
  ErrorNotice,
  LoadingState,
} from "../components/ScreenChrome";
import {
  SettingsHeader,
  SettingsPage,
  settingsStyles,
} from "../components/SettingsChrome";

type PluginState = {
  owner: string;
  items: Plugin[];
  loaded: boolean;
  refreshing: boolean;
  pending: string[];
  error: string;
};
type RequestScope = {
  owner: string;
  active: boolean;
  refresh?: AbortController;
  changes: Map<string, AbortController>;
};

const initialState = (owner: string): PluginState => ({
  owner,
  items: [],
  loaded: false,
  refreshing: false,
  pending: [],
  error: "",
});
const isLocked = (plugin: Plugin) => plugin.default_enabled || Boolean(plugin.locked);
const isEnabled = (plugin: Plugin) => plugin.enabled && (isLocked(plugin) || Boolean(plugin.effective_enabled));

export function PluginsScreen() {
  const { colors, dark, user } = useApp();
  const owner = user ? `${getAPIBaseURL()}\0${user.id}` : "";
  const [state, setState] = useState(() => initialState(owner));
  const ownerRef = useRef(owner);
  const stateRef = useRef(state);
  const scopeRef = useRef<RequestScope | null>(null);
  ownerRef.current = owner;
  stateRef.current = state;
  const current = useCallback((scope: RequestScope) =>
    scope.active && scopeRef.current === scope && ownerRef.current === scope.owner, []);

  const refresh = useCallback(async (scope = scopeRef.current) => {
    if (!scope || !current(scope) || scope.changes.size) return;
    scope.refresh?.abort();
    const controller = new AbortController();
    scope.refresh = controller;
    setState((previous) => ({
      ...(previous.owner === scope.owner ? previous : initialState(scope.owner)),
      refreshing: true,
      error: "",
    }));
    try {
      const items = await api.plugins(controller.signal);
      if (!current(scope) || controller.signal.aborted || scope.refresh !== controller) return;
      setState((previous) => ({ ...previous, items: items.filter((item) => item.enabled), loaded: true }));
    } catch (reason) {
      if (!current(scope) || controller.signal.aborted || scope.refresh !== controller) return;
      setState((previous) => ({ ...previous, error: reason instanceof Error ? reason.message : "加载失败" }));
    } finally {
      if (current(scope) && scope.refresh === controller) {
        scope.refresh = undefined;
        setState((previous) => ({ ...previous, refreshing: false }));
      }
    }
  }, [current]);

  useFocusEffect(useCallback(() => {
    if (!owner) return;
    const scope: RequestScope = { owner, active: true, changes: new Map() };
    scopeRef.current = scope;
    setState((previous) => ({
      ...(previous.owner === owner ? previous : initialState(owner)),
      pending: [],
    }));
    void refresh(scope);
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") void refresh(scope);
    });
    return () => {
      scope.active = false;
      scope.refresh?.abort();
      scope.changes.forEach((controller) => controller.abort());
      subscription.remove();
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [owner, refresh]));

  const toggle = useCallback(async (pluginId: string, enabled: boolean, expectedOwner: string) => {
    const scope = scopeRef.current;
    if (!scope || !current(scope) || scope.owner !== expectedOwner || scope.changes.has(pluginId)) return;
    const before = stateRef.current.owner === scope.owner
      ? stateRef.current.items.find((item) => item.id === pluginId)
      : undefined;
    if (!before || !before.enabled || isLocked(before) || isEnabled(before) === enabled) return;
    // An older list response must not undo an in-flight switch change.
    scope.refresh?.abort();
    scope.refresh = undefined;
    const controller = new AbortController();
    scope.changes.set(pluginId, controller);
    setState((previous) => ({
      ...previous,
      items: previous.items.map((item) => item.id === pluginId ? { ...item, effective_enabled: enabled } : item),
      pending: [...scope.changes.keys()],
      refreshing: false,
      error: "",
    }));
    try {
      const updated = await api.updatePlugin(pluginId, enabled, controller.signal);
      if (!current(scope) || controller.signal.aborted) return;
      setState((previous) => ({
        ...previous,
        items: previous.items.map((item) => item.id === pluginId ? updated : item).filter((item) => item.enabled),
      }));
    } catch (reason) {
      if (!current(scope) || controller.signal.aborted) return;
      setState((previous) => ({
        ...previous,
        items: previous.items.map((item) => item.id === pluginId ? before : item),
        error: reason instanceof Error ? reason.message : "保存失败",
      }));
    } finally {
      scope.changes.delete(pluginId);
      if (current(scope)) setState((previous) => ({ ...previous, pending: [...scope.changes.keys()] }));
    }
  }, [current]);

  const view = state.owner === owner ? state : initialState(owner);
  const track = { false: dark ? "#3b3b3d" : "#d0d0d3", true: dark ? "#848489" : "#343436" };
  return (
    <SettingsPage>
      <SettingsHeader title="插件" />
      <FlatList
        data={view.items}
        keyExtractor={(item) => item.id}
        refreshing={view.loaded && view.refreshing}
        onRefresh={() => void refresh()}
        contentContainerStyle={settingsStyles.content}
        ListHeaderComponent={<ErrorNotice error={view.error} retry={() => void refresh()} />}
        ListEmptyComponent={!view.loaded && !view.error ? <LoadingState /> : !view.error ? <EmptyState icon={Puzzle} text="暂无可用插件" /> : null}
        renderItem={({ item, index }) => {
          const locked = isLocked(item);
          const pending = view.pending.includes(item.id);
          return (
            <View style={[
              styles.row,
              { backgroundColor: colors.raised },
              index === 0 && styles.first,
              index === view.items.length - 1 && styles.last,
            ]}>
              <View style={styles.detail}>
                <AppText size={16} weight="medium">{item.name}</AppText>
                {item.description ? <AppText muted size={13}>{item.description}</AppText> : null}
                {locked ? (
                  <View style={styles.locked}>
                    <LockKeyhole size={12} color={colors.muted} />
                    <AppText muted size={12}>管理员已开启</AppText>
                  </View>
                ) : null}
              </View>
              <View style={styles.control}>
                <Switch
                  accessibilityLabel={item.name}
                  accessibilityHint={locked ? "管理员默认开启，不可关闭" : undefined}
                  accessibilityState={{ disabled: locked || pending, checked: isEnabled(item), busy: pending }}
                  value={isEnabled(item)}
                  disabled={locked || pending}
                  onValueChange={(enabled) => void toggle(item.id, enabled, owner)}
                  trackColor={track}
                  thumbColor={Platform.OS === "ios" ? undefined : "#ffffff"}
                  ios_backgroundColor={track.false}
                />
              </View>
              {index < view.items.length - 1 ? <View style={[styles.separator, { backgroundColor: colors.border }]} /> : null}
            </View>
          );
        }}
      />
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 16, paddingVertical: 14 },
  first: { borderTopLeftRadius: 22, borderTopRightRadius: 22 },
  last: { borderBottomLeftRadius: 22, borderBottomRightRadius: 22 },
  detail: { flex: 1, gap: 4 },
  locked: { flexDirection: "row", alignItems: "center", gap: 4, paddingTop: 2 },
  control: { justifyContent: "center", minHeight: 44 },
  separator: { position: "absolute", bottom: 0, left: 16, right: 16, height: StyleSheet.hairlineWidth },
});
