import { errorForDisplay, type DisplayError } from "../lib/errors";
import { t, useI18n } from "../lib/i18n";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type ScrollViewProps,
} from "react-native";
import {
  ChevronRight,
  Folder,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react-native";
import { router, useFocusEffect } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { api } from "../lib/api";
import type { Project, Session } from "../lib/types";
import { useApp } from "../providers/AppProvider";
import { Sheet } from "../ui/Sheet";
import { MenuTrigger } from "../ui/MenuTrigger";
import {
  ActionIcon,
  AppText,
  Button,
  EmptyState,
  ErrorNotice,
  Field,
  LoadingState,
  PageHeader,
  screenStyles,
  usePageContentStyle,
} from "../components/ScreenChrome";
import { Composer, type ComposerSubmission } from "../components/Composer";
import { SessionSearch, sessionDate } from "../components/SessionSearch";

export function ProjectsScreen() {
  useI18n();
  const { colors, invalidateLists, invalidateVersion } = useApp();
  const contentStyle = usePageContentStyle();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<DisplayError>("");
  const [creating, setCreating] = useState(false);
  const refresh = useCallback(() => {
    setLoading(true);
    void api
      .projects()
      .then(setProjects)
      .catch((reason) =>
        setError(errorForDisplay(reason, "error.load")),
      )
      .finally(() => setLoading(false));
  }, []);
  useEffect(refresh, [refresh, invalidateVersion]);
  return (
    <View style={[screenStyles.fill, { backgroundColor: colors.canvas }]}>
      <PageHeader
        title={t("project.title")}
        right={
          <ActionIcon
            icon={Plus}
            label={t("project.create")}
            onPress={() => setCreating(true)}
          />
        }
      />
      <ErrorNotice error={error} retry={refresh} safeArea />
      {loading ? (
        <LoadingState />
      ) : (
        <FlatList
          data={projects}
          keyExtractor={(item) => item.id}
          contentContainerStyle={contentStyle}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.name}
              onPress={() => router.push(`/projects/${item.id}`)}
              style={[styles.projectRow, { borderBottomColor: colors.border }]}
            >
              <View
                style={[styles.folderIcon, { backgroundColor: colors.surface }]}
              >
                <Folder size={24} color={colors.text} strokeWidth={1.6} />
              </View>
              <View style={{ flex: 1 }}>
                <AppText size={17} weight="medium" numberOfLines={1}>
                  {item.name}
                </AppText>
                <AppText muted size={13}>
                  {t("chat.count", { count: item.session_count ?? 0 })}
                </AppText>
              </View>
              <ChevronRight size={18} color={colors.subtle} />
            </Pressable>
          )}
          ListEmptyComponent={<EmptyState icon={Folder} text={t("project.none")} />}
          refreshing={loading}
          onRefresh={refresh}
        />
      )}
      <ProjectEditor
        visible={creating}
        onClose={() => setCreating(false)}
        onSaved={(project) => {
          setCreating(false);
          invalidateLists();
          router.push(`/projects/${project.id}`);
        }}
      />
    </View>
  );
}

export function ProjectScreen({ projectId }: { projectId: string }) {
  useI18n();
  const { colors, models, invalidateLists, invalidateVersion } = useApp();
  const { height } = useWindowDimensions();
  const compact = height < 500;
  const contentStyle = usePageContentStyle({ horizontal: 18, top: 0, bottom: 30, gap: 0 });
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState(false);
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("");
  const [computer, setComputer] = useState(true);
  useEffect(() => {
    const model = models.find((item) => item.is_default) ?? models[0];
    if (!modelId && model) {
      setModelId(model.id);
      setEffort(model.default_effort);
    }
  }, [models, modelId]);
  const refresh = useCallback(() => {
    setLoading(true);
    void Promise.all([
      api.project(projectId),
      api.sessionsPage({ project_id: projectId, limit: 40 }),
    ])
      .then(([value, page]) => {
        setProject(value);
        setSessions(page.items ?? []);
        setCursor(page.next_cursor);
        setError("");
      })
      .catch((reason) =>
        setError(errorForDisplay(reason, "error.load")),
      )
      .finally(() => setLoading(false));
  }, [projectId]);
  useEffect(refresh, [refresh, invalidateVersion]);
  async function more() {
    if (!cursor || paging) return;
    setPaging(true);
    try {
      const page = await api.sessionsPage({
        project_id: projectId,
        cursor,
        limit: 40,
      });
      setSessions((current) => [
        ...current,
        ...page.items.filter(
          (item) => !current.some((existing) => existing.id === item.id),
        ),
      ]);
      setCursor(page.next_cursor);
    } catch (reason) {
      setError(errorForDisplay(reason, "error.load"));
    } finally {
      setPaging(false);
    }
  }
  async function submit({ text, options }: ComposerSubmission) {
    const session = await api.createSession(
      modelId,
      effort,
      projectId,
      computer,
    );
    try {
      await api.startRun(session.id, text, options);
    } finally {
      invalidateLists();
      router.push(`/c/${session.id}`);
    }
  }
  function remove() {
    if (!project) return;
    Alert.alert(t("project.deleteConfirm"), project.name, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: () =>
          void api
            .deleteProject(project.id)
            .then(() => {
              invalidateLists();
              router.replace("/projects");
            })
            .catch((reason) =>
              setError(errorForDisplay(reason, "error.delete")),
            ),
      },
    ]);
  }
  const header = (
    <View style={[styles.projectHeader, compact && { paddingTop: 8 }]}>
      <View style={[styles.projectName, compact && { marginBottom: 12 }]}>
        <Folder size={29} color={colors.text} strokeWidth={1.6} />
        <AppText
          size={26}
          weight="semibold"
          style={{ flex: 1, letterSpacing: -0.6 }}
        >
          {project?.name}
        </AppText>
      </View>
      {project?.instructions ? (
        <Pressable
          onPress={() => setEditing(true)}
          style={{ paddingBottom: 15 }}
        >
          <AppText muted size={14} numberOfLines={2}>
            {project.instructions}
          </AppText>
        </Pressable>
      ) : null}
      <Composer
        draftKey={`project-${projectId}`}
        models={models}
        modelId={modelId}
        effort={effort}
        onModel={(id) => {
          setModelId(id);
          setEffort(
            models.find((item) => item.id === id)?.default_effort ?? "",
          );
        }}
        onEffort={setEffort}
        computerEnabled={computer}
        onComputer={setComputer}
        onStop={() => undefined}
        onSubmit={submit}
      />
      <View style={styles.sessionHeading}>
        <AppText size={15} weight="medium">
          {t("chat.chats")}{" "}
          <AppText muted size={13}>
            {project?.session_count ?? sessions.length}
          </AppText>
        </AppText>
        <ActionIcon
          icon={Search}
          label={t("project.searchChats")}
          onPress={() => setSearch(true)}
        />
      </View>
    </View>
  );
  return (
    <View style={[screenStyles.fill, { backgroundColor: colors.canvas }]}>
      <PageHeader
        title={project?.name ?? t("project.title")}
        right={
          <MenuTrigger
            label={t("project.options")}
            items={[
              {
                key: "rename",
                title: t("project.settings"),
                icon: Pencil,
                onPress: () => setEditing(true),
              },
              {
                key: "delete",
                title: t("project.delete"),
                icon: Trash2,
                danger: true,
                separatorBefore: true,
                onPress: remove,
              },
            ]}
          >
            <View
              style={{
                width: 44,
                height: 44,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <MoreHorizontal size={21} color={colors.text} />
            </View>
          </MenuTrigger>
        }
      />
      <ErrorNotice error={error} retry={refresh} safeArea />
      {loading ? (
        <LoadingState />
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          contentContainerStyle={contentStyle}
          renderScrollComponent={projectScrollComponent}
          removeClippedSubviews={false}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.title || t("chat.new")}
              onPress={() => router.push(`/c/${item.id}`)}
              style={[styles.sessionRow, { borderBottomColor: colors.border }]}
            >
              <View style={{ flex: 1, gap: 3 }}>
                <AppText size={15} numberOfLines={2}>
                  {item.title || t("chat.new")}
                </AppText>
                <AppText muted size={12}>
                  {sessionDate(item.updated_at)}
                </AppText>
              </View>
              <ChevronRight size={17} color={colors.subtle} />
            </Pressable>
          )}
          ListEmptyComponent={<EmptyState icon={Folder} text={t("chat.none")} />}
          onEndReached={() => void more()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            paging ? <ActivityIndicator color={colors.muted} /> : null
          }
        />
      )}
      <ProjectEditor
        visible={editing}
        project={project ?? undefined}
        onClose={() => setEditing(false)}
        onSaved={(value) => {
          setProject(value);
          setEditing(false);
          invalidateLists();
        }}
      />
      <SessionSearch
        visible={search}
        projectId={projectId}
        onClose={() => setSearch(false)}
        onSelect={(item) => router.push(`/c/${item.id}`)}
      />
    </View>
  );
}

function projectScrollComponent(props: ScrollViewProps) {
  return <KeyboardAwareScrollView {...props} bottomOffset={16} keyboardDismissMode="interactive" />;
}

function ProjectEditor({
  visible,
  project,
  onClose,
  onSaved,
}: {
  visible: boolean;
  project?: Project;
  onClose: () => void;
  onSaved: (project: Project) => void;
}) {
  useI18n();
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  useEffect(() => {
    if (visible) {
      setName(project?.name ?? "");
      setInstructions(project?.instructions ?? "");
      setError("");
    }
  }, [visible, project?.id]);
  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      onSaved(
        await api.saveProject({
          id: project?.id,
          name: name.trim(),
          instructions,
        }),
      );
    } catch (reason) {
      setError(errorForDisplay(reason, "error.save"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={project ? t("project.settings") : t("project.create")}
      height={460}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.editorBody}
      >
        <Field label={t("common.name")} value={name} onChangeText={setName} autoFocus />
        <Field
          label={t("project.instructions")}
          value={instructions}
          onChangeText={setInstructions}
          multiline
        />
        <ErrorNotice error={error} />
        <Button busy={busy} disabled={!name.trim()} onPress={() => void save()}>
          {t("common.save")}</Button>
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  editorBody: { width: "100%", maxWidth: 680, alignSelf: "center", padding: 20 },
  projectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    minHeight: 83,
    paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  folderIcon: {
    width: 46,
    height: 46,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  projectHeader: { paddingTop: 18 },
  projectName: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    marginBottom: 20,
  },
  sessionHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 22,
    paddingBottom: 5,
  },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 15,
    minHeight: 67,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
