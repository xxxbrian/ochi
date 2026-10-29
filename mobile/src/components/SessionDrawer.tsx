import { errorForDisplay, type DisplayError } from "../lib/errors";
import { t, useI18n } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import {
  CalendarClock,
  Folder,
  LogOut,
  Monitor,
  Pencil,
  Search,
  Settings,
  Shield,
  SquarePen,
  Trash2,
} from "lucide-react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { brand } from "../../brand.config";
import { api } from "../lib/api";
import type { Session } from "../lib/types";
import { useApp, useSessionList, useTheme } from "../providers/AppProvider";
import { appendSessionPage, mergeFirstSessionPage, sessionActivity, type DrawerSessionList } from "../lib/sessionList";
import { GlassSurface } from "../ui/GlassSurface";
import { IconButton } from "../ui/IconButton";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { LongPressMenu } from "../ui/LongPressMenu";
import { SessionTitleDialog } from "../ui/SessionTitleDialog";
import { AppText, ErrorNotice } from "./ScreenChrome";
import { SessionSearch, sessionDate } from "./SessionSearch";

export function SessionDrawer({
  open,
  canAct,
  onNavigate,
  onSelectSession,
  onNewChat,
  onDeletedSession,
  activeId,
}: {
  open: boolean;
  canAct: () => boolean;
  onNavigate: (path: string) => boolean;
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
  onDeletedSession: (sessionId: string) => void;
  activeId?: string;
}) {
  useI18n();
  const { user, colors, dark, invalidateLists, signOut } =
    useApp();
  const { page, refreshing, error: listError, cache } = useSessionList();
  const insets = useSafeAreaInsets();
  const viewport = useWindowDimensions();
  const geometry = `${viewport.width}:${viewport.height}:${insets.left}:${insets.top}`;
  const menuGeometry = useRef(geometry);
  menuGeometry.current = geometry;
  const [retained, setRetained] = useState(() => ({ cache, list: mergeFirstSessionPage({ items: [], paged: false }, page ?? { items: [] }) }));
  const list: DrawerSessionList = retained.cache === cache ? retained.list : { items: page?.items ?? [], cursor: page?.next_cursor, paged: false };
  const { items, cursor } = list;
  const loading = !page && refreshing;
  const [pulling, setPulling] = useState(false);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  const [search, setSearch] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0, width: 44, height: 44 });
  const [renaming, setRenaming] = useState<Session | null>(null);
  const loadingMore = useRef(false);
  const refreshingList = useRef(false);
  const sequence = useRef(0);
  const account = useRef<View>(null);
  const searchSelection = useRef(onSelectSession);
  useEffect(() => { setAccountMenu(false); }, [geometry]);
  useEffect(() => {
    if (open && canAct()) return;
    setSearch(false);
    setAccountMenu(false);
    setRenaming(null);
  }, [open, canAct]);
  useEffect(() => {
    if (open && canAct()) void cache.refresh();
  }, [open, cache, canAct]);
  useEffect(() => {
    if (!page || !open || !canAct()) return;
    setRetained((current) => ({ cache, list: mergeFirstSessionPage(current.cache === cache ? current.list : { items: [], paged: false }, page) }));
  }, [page, cache, open, canAct]);
  useEffect(() => {
    loadingMore.current = false;
    refreshingList.current = false;
    setPaging(false);
    setPulling(false);
    return () => {
      sequence.current += 1;
    };
  }, [cache]);
  async function refresh() {
    if (!open || !canAct() || refreshingList.current) return;
    const current = ++sequence.current;
    refreshingList.current = true;
    loadingMore.current = false;
    setPaging(false);
    setPulling(true);
    try {
      const updated = await cache.refresh();
      if (current === sequence.current && updated) {
        setRetained({ cache, list: mergeFirstSessionPage({ items: [], paged: false }, updated) });
        setError("");
      }
    } finally {
      if (current === sequence.current) {
        refreshingList.current = false;
        setPulling(false);
      }
    }
  }
  async function more() {
    if (!open || !canAct() || !cursor || loadingMore.current || refreshingList.current || refreshing) return;
    const current = sequence.current;
    loadingMore.current = true;
    setPaging(true);
    try {
      const page = await api.sessionsPage({ cursor, limit: 40 });
      if (current === sequence.current) {
        setRetained((previous) => previous.cache === cache ? { cache, list: appendSessionPage(previous.list, page) } : previous);
        setError("");
      }
    } catch (reason) {
      if (current === sequence.current)
        setError(errorForDisplay(reason, "error.load"));
    } finally {
      if (current === sequence.current) {
        loadingMore.current = false;
        setPaging(false);
      }
    }
  }
  function navigate(path: string) {
    try {
      onNavigate(path);
    } catch (reason) {
      setError(errorForDisplay(reason, "error.openPage"));
    }
  }
  async function rename(title: string) {
    if (!renaming) return;
    const owner = sequence.current;
    const updated = await api.updateSession(renaming.id, { title });
    if (owner !== sequence.current) return;
    setRetained((current) => ({ ...current, list: { ...current.list, items: current.list.items.map((item) => item.id === updated.id ? { ...item, title: updated.title } : item) } }));
    cache.updateSession(updated);
    invalidateLists();
  }
  function remove(item: Session) {
    Alert.alert(t("chat.deleteConfirm"), item.title || t("chat.new"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: () => {
          if (!canAct()) return;
          const owner = sequence.current;
          void api
            .deleteSession(item.id)
            .then(() => {
              if (owner !== sequence.current) return;
              setRetained((current) => ({ ...current, list: { ...current.list, items: current.list.items.filter((existing) => existing.id !== item.id) } }));
              cache.removeSession(item.id);
              invalidateLists();
              onDeletedSession(item.id);
            })
            .catch((reason) => {
              if (owner === sequence.current) setError(errorForDisplay(reason, "error.delete"));
            });
        },
      },
    ]);
  }
  function logout() {
    setAccountMenu(false);
    Alert.alert(t("account.signOutConfirm"), undefined, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("account.signOut"),
        onPress: () => {
          void signOut()
            .then(() => router.replace("/login"))
            .catch((reason) =>
              setError(errorForDisplay(reason, "error.signOut")),
            );
        },
      },
    ]);
  }
  const accountItems = [
    ...(user?.role === "admin"
      ? [
          {
            key: "admin",
            title: t("admin.title"),
            icon: Shield,
            onPress: () => {
              setAccountMenu(false);
              navigate("/admin");
            },
          },
        ]
      : []),
    {
      key: "logout",
      title: t("account.signOut"),
      icon: LogOut,
      separatorBefore: user?.role === "admin",
      onPress: logout,
    },
  ];
  return (
    <View
      style={[
        styles.drawer,
        {
          backgroundColor: dark ? "#000000" : "#fafafa",
          paddingTop: insets.top + 8,
          paddingBottom: Math.max(10, insets.bottom),
          paddingLeft: (insets.left || 0) + 14,
        },
      ]}
    >
      <Pressable
        ref={account}
        accessibilityRole="button"
        accessibilityLabel={t("account.options")}
        onPress={() => {
          if (!canAct()) return;
          const owner = canAct;
          const measuredGeometry = menuGeometry.current;
          account.current?.measureInWindow((x, y, width, height) => {
            if (!owner() || measuredGeometry !== menuGeometry.current) return;
            setAnchor({ x, y, width, height });
            setAccountMenu(true);
          });
        }}
        style={styles.account}
      >
        <View style={[styles.avatar, { backgroundColor: colors.hover }]}>
          <AppText weight="semibold" size={18}>
            {user?.display_name?.slice(0, 1) || "O"}
          </AppText>
        </View>
        <View style={{ flex: 1 }}>
          <AppText weight="medium" size={17} numberOfLines={1}>
            {user?.display_name || user?.username || brand.displayName}
          </AppText>
          <AppText muted size={12}>
            {brand.displayName}
          </AppText>
        </View>
      </Pressable>
      <FlatList
        style={styles.list}
        data={items}
        extraData={activeId}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        refreshing={pulling}
        onRefresh={() => void refresh()}
        onEndReached={() => void more()}
        onEndReachedThreshold={0.5}
        contentContainerStyle={{ paddingBottom: 12 }}
        ListHeaderComponent={
          <View>
            <View style={styles.destinations}>
              {[
                { icon: CalendarClock, title: t("schedule.title"), path: "/tasks" },
                { icon: Folder, title: t("project.title"), path: "/projects" },
                { icon: Monitor, title: t("computer.title"), path: "/computer" },
              ].map((item) => (
                <Pressable
                  key={item.path}
                  accessibilityRole="button"
                  accessibilityLabel={item.title || t("chat.new")}
                  onPress={() => navigate(item.path)}
                  style={styles.destination}
                >
                  <item.icon size={22} color={colors.muted} strokeWidth={1.8} />
                  <AppText size={16}>{item.title || t("chat.new")}</AppText>
                </Pressable>
              ))}
            </View>
            <AppText muted size={13} style={styles.label}>
              {t("chat.chats")}</AppText>
            <ErrorNotice error={error || listError} />
          </View>
        }
        renderItem={({ item }) => (
          <DrawerSession
            item={item}
            selected={activeId === item.id}
            onPress={() => onSelectSession(item.id)}
            onRename={() => {
              if (canAct()) setRenaming(item);
            }}
            onDelete={() => remove(item)}
          />
        )}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.muted} style={{ padding: 20 }} />
          ) : null
        }
        ListFooterComponent={
          paging ? (
            <ActivityIndicator color={colors.muted} style={{ padding: 12 }} />
          ) : null
        }
      />
      <View style={styles.bottom}>
        <IconButton
          icon={Settings}
          label={t("settings.title")}
          variant="glass"
          onPress={() => navigate("/settings")}
        />
        <GlassSurface interactive style={styles.search}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("search.chats")}
            onPress={() => {
              if (!canAct()) return;
              searchSelection.current = onSelectSession;
              setSearch(true);
            }}
            style={styles.searchInner}
          >
            <Search size={20} color={colors.muted} />
            <AppText muted size={15}>
              {t("common.search")}</AppText>
          </Pressable>
        </GlassSurface>
        <IconButton
          icon={SquarePen}
          label={t("chat.new")}
          variant="filled"
          onPress={onNewChat}
        />
      </View>
      <SessionSearch
        visible={search}
        onClose={() => setSearch(false)}
        onSelect={(item) => searchSelection.current(item.id)}
      />
      <AnchoredMenu
        visible={accountMenu}
        onClose={() => setAccountMenu(false)}
        anchor={anchor}
        items={accountItems}
        width={210}
      />
      <SessionTitleDialog
        key={renaming?.id ?? "closed"}
        visible={Boolean(renaming)}
        title={renaming?.title ?? ""}
        onClose={() => setRenaming(null)}
        onSave={rename}
      />
    </View>
  );
}

function DrawerSession({
  item,
  selected,
  onPress,
  onRename,
  onDelete,
}: {
  item: Session;
  selected: boolean;
  onPress: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  useI18n();
  const { colors } = useTheme();
  const activity = sessionActivity(item);
  const content = <>
    <View style={styles.sessionTitle}>
      <AppText size={15} numberOfLines={1} style={{ flex: 1 }}>
        {item.title || t("chat.new")}
      </AppText>
      {activity?.spinning ? <ActivityIndicator size="small" color={colors.muted} style={styles.runIndicator} /> : activity ? <View style={[styles.statusDot, { backgroundColor: colors.muted }]} /> : null}
    </View>
    <View style={styles.sessionMetadata}>
      <AppText muted size={12}>
        {sessionDate(item.updated_at)}
      </AppText>
      {activity ? <AppText muted size={11}>{activity.label}</AppText> : null}
    </View>
  </>;
  const preview = (
    <View style={[styles.session, { backgroundColor: colors.hover }]}>
      {content}
    </View>
  );
  return (
    <LongPressMenu
      label={activity ? `${item.title || t("chat.new")}，${activity.label}` : item.title}
      selected={selected}
      onPress={onPress}
      preview={preview}
      previewRadius={12}
      style={styles.sessionTrigger}
      items={[
        { key: "rename", title: t("common.rename"), icon: Pencil, onPress: onRename },
        {
          key: "delete",
          title: t("common.delete"),
          icon: Trash2,
          danger: true,
          separatorBefore: true,
          onPress: onDelete,
        },
      ]}
    >
      <View
        style={[styles.session, selected && { backgroundColor: colors.hover }]}
      >
        {content}
      </View>
    </LongPressMenu>
  );
}

const styles = StyleSheet.create({
  drawer: { flex: 1, paddingHorizontal: 14 },
  account: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
  },
  list: { flex: 1 },
  destinations: { paddingVertical: 16, gap: 1 },
  destination: {
    flexDirection: "row",
    alignItems: "center",
    gap: 15,
    minHeight: 46,
    paddingHorizontal: 7,
  },
  label: { marginTop: 4, marginBottom: 8, paddingLeft: 9 },
  sessionTrigger: { width: "100%" },
  sessionTitle: { flexDirection: "row", alignItems: "center", gap: 6 },
  sessionMetadata: { flexDirection: "row", alignItems: "center", gap: 8 },
  runIndicator: { width: 16, height: 16, transform: [{ scale: 0.75 }] },
  statusDot: { width: 5, height: 5, borderRadius: 3, marginHorizontal: 5 },
  session: {
    borderRadius: 12,
    minHeight: 60,
    justifyContent: "center",
    paddingHorizontal: 10,
    paddingVertical: 11,
  },
  bottom: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingTop: 10,
  },
  search: { flex: 1, borderRadius: 24 },
  searchInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 12,
    height: 44,
  },
});
