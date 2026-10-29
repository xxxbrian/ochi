import { t, useI18n, setLanguage, getLanguage, type LanguagePreference } from "./lib/i18n";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Check, ChevronRight, Folder, LoaderCircle, SquarePen, X } from "lucide-react";
import { api, isActiveStatus } from "./lib/api";
import { preferredChatModel } from "./lib/modelSelection";
import type {
  Artifact,
  Message,
  Model,
  Project,
  Session,
  SessionPage,
  User,
} from "./lib/types";
import { useConversation } from "./hooks/useConversation";
import { LoginScreen } from "./components/LoginScreen";
import { Sidebar, MobileMenuButton } from "./components/Sidebar";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { RunInstructionStatus } from "./components/RunInstructionStatus";
import { ComputerPanel } from "./components/ComputerPanel";
import { Modal } from "./components/Modal";
import { QueueTray } from "./components/QueueTray";
import { useRouter } from "./lib/router";

const AdminPanel = lazy(() => import("./components/AdminPanel"));
const UserSettings = lazy(() => import("./components/UserSettings"));
const TasksPage = lazy(() => import("./pages/TasksPage"));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage"));

function errorText(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}
function reasoningParameters(
  model: Model | undefined,
  budget: number | undefined,
  enabled: boolean,
) {
  if (!model?.effort_parameter) return {};
  return {
    ...(model.reasoning_kind === "budget"
      ? { budget_tokens: budget ?? model.reasoning_budget_default ?? 2048 }
      : {}),
    ...(model.reasoning_kind === "toggle"
      ? { reasoning_enabled: enabled }
      : {}),
  };
}
function selectionKey(user: User) {
  return `assistant.selection.v2.${user.id}`;
}
function storedSelection(user: User): string | null {
  try {
    return localStorage.getItem(selectionKey(user));
  } catch {
    return null;
  }
}
function storeSelection(user: User, id: string | null) {
  try {
    if (id) localStorage.setItem(selectionKey(user), id);
    else localStorage.removeItem(selectionKey(user));
  } catch {
    /* Storage is optional. */
  }
}
function olderSession(next: Session, current: Session) {
  const nextTime = Date.parse(next.updated_at);
  const currentTime = Date.parse(current.updated_at);
  if (nextTime !== currentTime) return nextTime < currentTime;
  // PostgreSQL timestamps include sub-millisecond precision that Date drops.
  const fraction = (value: string) =>
    (value.match(/\.(\d+)/)?.[1] ?? "").padEnd(9, "0");
  const nextFraction = fraction(next.updated_at);
  const currentFraction = fraction(current.updated_at);
  return nextFraction === currentFraction ? next.id < current.id : nextFraction < currentFraction;
}

export default function App() {
  useI18n();
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string>();
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  const railPaged = useRef(false);
  const railGeneration = useRef(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("");
  const { route, navigate } = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [budget, setBudget] = useState<number | undefined>();
  const [reasoningEnabled, setReasoningEnabled] = useState(true);
  const [computerDefault, setComputerDefault] = useState(false);
  const [draftComputerEnabled, setDraftComputerEnabled] = useState(false);
  const [projectComputerDrafts, setProjectComputerDrafts] = useState<Record<string, boolean>>({});
  const [computerUpdating, setComputerUpdating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [computerOpen, setComputerOpen] = useState(false);
  const [revision, setRevision] = useState<{
    message: Message;
    kind: "edit" | "retry";
  } | null>(null);
  const [revisionText, setRevisionText] = useState("");
  const [composerKey, setComposerKey] = useState(0);
  const userRef = useRef<User | null>(null);
  const selectedRef = useRef<string | null>(null);
  const modelsRef = useRef<Model[]>([]);
  const preferredModelRef = useRef("");
  const confirmedModelRef = useRef("");
  const modelPreferenceWrites = useRef(Promise.resolve());
  const modelPreferenceRevision = useRef(0);
  const modelPreferenceOwner = useRef<object | null>(null);
  const languagePreferenceWrites = useRef(Promise.resolve());
  const languagePreferenceRevision = useRef(0);
  const confirmedLanguageRef = useRef<LanguagePreference>(getLanguage());
  const selectionGeneration = useRef(0);
  userRef.current = user;
  modelsRef.current = models;
  const replaceSessions = useCallback(
    (page: SessionPage, reset = false) => {
      const list = page.items;
      // The rail is paginated and omits schedule sessions; it must not own the
      // current conversation's title, Project, or permission state.
      if (reset) railPaged.current = false;
      if (!railPaged.current) setSessionCursor(page.next_cursor);
      setSessions((current) => {
        if (reset || !railPaged.current || !list.length) return list;
        const seen = new Set(list.map((item) => item.id));
        const boundary = list[list.length - 1];
        return [...list, ...current.filter((item) => !seen.has(item.id) && olderSession(item, boundary))];
      });
    },
    [],
  );
  useEffect(() => {
    if (user && user.role !== "admin" && route.kind === "admin")
      navigate("/", true);
  }, [user, route.kind, navigate]);

  const expired = useCallback(() => {
    modelPreferenceOwner.current = null;
    preferredModelRef.current = "";
    confirmedModelRef.current = "";
    selectionGeneration.current += 1;
    selectedRef.current = null;
    setSelectedId(null);
    setUser(null);
    setSessions([]);
    railGeneration.current += 1;
    railPaged.current = false;
    setSessionCursor(undefined);
    setSessionsLoadingMore(false);
    setCreating(false);
    setBootstrapLoading(false);
    setComputerDefault(false);
    setDraftComputerEnabled(false);
    setComputerOpen(false);
    setRevision(null);
    setError("");
  }, []);
  const chat = useConversation(user?.id ?? "", selectedId ?? undefined, String(composerKey), {
    onExpired: expired,
    onSessionChanged: (session) => setSessions((current) => current.map((item) => item.id === session.id ? session : item)),
  });
  const { controller, messages, run: snapshot, reconnecting, instructions, pending: queue,
    hasOlder: olderAvailable, loadingOlder: olderLoading } = chat;
  const loading = bootstrapLoading || chat.loading;
  const posting = creating || chat.posting;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const selected = chat.session?.id === selectedId ? chat.session : null;
  useEffect(() => {
    if (chat.error) setError(errorText(chat.error, t("error.load")));
  }, [chat.error]);
  const selectedModelOwner = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selected || selectedModelOwner.current === selected.id) return;
    selectedModelOwner.current = selected.id;
    const chosen = modelsRef.current.find((model) => model.id === selected.model_id)
      ?? preferredChatModel(modelsRef.current, preferredModelRef.current);
    if (!chosen) return;
    setModelId(chosen.id);
    setBudget(selected.effort?.startsWith("budget:") ? Number(selected.effort.slice(7)) : chosen.reasoning_budget_default);
    setReasoningEnabled(selected.effort !== "off");
    setEffort(chosen.efforts?.includes(selected.effort ?? "") ? selected.effort ?? "" : chosen.default_effort ?? "");
  }, [selected]);
  const computerEnabled = selectedId
    ? Boolean(selected?.computer_enabled)
    : draftComputerEnabled;
  const computerAvailable =
    computerEnabled ||
    (isActiveStatus(snapshot?.status) && Boolean(snapshot?.computer_granted));
  const computerOnce = !computerEnabled && computerAvailable;

  const selectSession = useCallback(async (id: string, restoring = false) => {
    selectionGeneration.current++;
    selectedRef.current = id;
    selectedModelOwner.current = undefined;
    if (userRef.current) storeSelection(userRef.current, id);
    setSelectedId(id);
    setError(""); setRevision(null); setDrawerOpen(false);
    if (!restoring) navigate(`/c/${id}`);
    setComposerKey((value) => value + 1);
  }, [navigate]);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((current) => {
        if (!cancelled) setUser(current);
      })
      .catch((reason: unknown) => {
        if (
          !cancelled &&
          !(
            reason &&
            typeof reason === "object" &&
            "status" in reason &&
            reason.status === 401
          )
        )
          setError(t("error.connect"));
      })
      .finally(() => {
        if (!cancelled) setAuthChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!user) return;
    const preferenceOwner = {};
    modelPreferenceOwner.current = preferenceOwner;
    modelPreferenceWrites.current = Promise.resolve();
    languagePreferenceWrites.current = Promise.resolve();
    languagePreferenceRevision.current = 0;
    preferredModelRef.current = "";
    confirmedModelRef.current = "";
    railGeneration.current += 1;
    let cancelled = false;
    setBootstrapLoading(true);
    Promise.all([
      api.sessionsPage(),
      api.models(),
      api.projects(),
      api.preferences(),
    ])
      .then(([list, available, allProjects, preferences]) => {
        if (cancelled) return;
        modelsRef.current = available ?? [];
        setModels(available ?? []);
        setProjects(allProjects ?? []);
        replaceSessions(list, true);
        if (languagePreferenceRevision.current === 0) {
          confirmedLanguageRef.current = preferences.language;
          setLanguage(preferences.language);
        }
        setComputerDefault(preferences.computer_default);
        setDraftComputerEnabled(preferences.computer_default);
        preferredModelRef.current = preferences.preferred_model_id;
        confirmedModelRef.current = preferences.preferred_model_id;
        const defaultModel = preferredChatModel(available ?? [], preferences.preferred_model_id);
        if (defaultModel) {
          setModelId(defaultModel.id);
          setEffort(defaultModel.default_effort ?? "");
        }
        const pathId = window.location.pathname.startsWith("/c/")
          ? decodeURIComponent(window.location.pathname.split("/")[2])
          : "";
        const chosen =
          pathId ||
          (window.location.pathname === "/"
            ? storedSelection(user)
            : undefined);
        if (chosen) {
          if (!pathId) navigate(`/c/${chosen}`, true);
          void selectSession(chosen, true);
        }
        setBootstrapLoading(false);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(errorText(reason, t("error.loadTemporary")));
          setBootstrapLoading(false);
        }
      });
    const poll = window.setInterval(() => {
      void api
        .sessionsPage()
        .then((list) => {
          if (!cancelled) replaceSessions(list);
        })
        .catch(() => undefined);
    }, 15000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      if (modelPreferenceOwner.current === preferenceOwner) modelPreferenceOwner.current = null;
    };
  }, [user, selectSession, navigate, replaceSessions]);
  const changeLanguage = useCallback(async (next: LanguagePreference) => {
    const owner = modelPreferenceOwner.current;
    if (!owner) return;
    const revision = ++languagePreferenceRevision.current;
    setLanguage(next);
    const write = languagePreferenceWrites.current.then(async () => {
      if (modelPreferenceOwner.current !== owner) return;
      try {
        const preferences = await api.updatePreferences({ language: next });
        if (modelPreferenceOwner.current === owner) confirmedLanguageRef.current = preferences.language;
      } catch (reason) {
        if (modelPreferenceOwner.current !== owner) return;
        if (languagePreferenceRevision.current === revision) setLanguage(confirmedLanguageRef.current);
        throw reason;
      }
    });
    languagePreferenceWrites.current = write.catch(() => undefined);
    await write;
  }, []);
  useEffect(() => {
    setDrawerOpen(false);
    if (!user || loading) return;
    if (route.kind === "chat" && route.id && route.id !== selectedRef.current)
      void selectSession(route.id, true);
    else if (route.kind === "chat" && !route.id && selectedRef.current) {
      selectionGeneration.current += 1;
      selectedRef.current = null;
      setSelectedId(null);
          setDraftComputerEnabled(computerDefault);
      const chosen = preferredChatModel(modelsRef.current, preferredModelRef.current);
      setModelId(chosen?.id ?? "");
      setEffort(chosen?.default_effort ?? "");
      setBudget(chosen?.reasoning_budget_default);
      setReasoningEnabled(true);
      setRevision(null);
      setComposerKey((value) => value + 1);
    }
  }, [
    route.kind,
    route.id,
    user,
    selectSession,
    loading,
    computerDefault,
  ]);
  useEffect(() => {
    if (!drawerOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [drawerOpen]);

  const newConversation = useCallback(() => {
    if (posting) return;
    selectionGeneration.current += 1;
    selectedRef.current = null;
    selectedModelOwner.current = undefined;
    if (user) storeSelection(user, null);
    setSelectedId(null);
    setError("");
    setBootstrapLoading(false);
    setDrawerOpen(false);
    setRevision(null);
    setDraftComputerEnabled(computerDefault);
    const chosen = preferredChatModel(modelsRef.current, preferredModelRef.current);
    setModelId(chosen?.id ?? "");
    setEffort(chosen?.default_effort ?? "");
    setBudget(chosen?.reasoning_budget_default);
    setReasoningEnabled(true);
    navigate("/");
    setComposerKey((value) => value + 1);
  }, [
    posting,
    user,
    navigate,
    computerDefault,
  ]);

  const sendMessage = useCallback(async (content: string, files: Artifact[] = [], now = false, projectId?: string) => {
    if (loading || posting || computerUpdating) return false;
    const token = ++selectionGeneration.current;
    setError("");
    const options = { model_id: modelId, effort, attachment_ids: files.map((file) => file.id), stop_current: now,
      ...reasoningParameters(modelsRef.current.find((model) => model.id === modelId), budget, reasoningEnabled) };
    try {
      if (selectedRef.current && !projectId) {
        await controller.send(content, { ...options, attachments: files });
      } else {
        setCreating(true);
        if (projectId) {
          controller.select({ origin: chat.owner.origin, account: user?.id ?? "", draftId: `project:${projectId}:${token}` });
        }
        const result = await controller.createAndSend(content, {
          ...options, attachments: files, project_id: projectId,
          computer_enabled: projectId ? projectComputerDrafts[projectId] ?? true : draftComputerEnabled,
        });
        if (!result || token !== selectionGeneration.current) return true;
        const created = result.session;
        selectedRef.current = created.id;
        setSelectedId(created.id);
        if (user) storeSelection(user, created.id);
        navigate(`/c/${created.id}`);
        setSessions((current) => [created, ...current.filter((item) => item.id !== created.id)]);
        if (result.error) throw result.error;
      }
      return true;
    } catch (reason) {
      if (token !== selectionGeneration.current) return true;
      setError(errorText(reason, t("error.send")));
      if (projectId && selectedRef.current) {
        try { sessionStorage.setItem(`assistant.draft.v2.${user?.id}.${selectedRef.current}`, content); } catch { /* Storage is optional. */ }
        setComposerKey((value) => value + 1);
      }
      return false;
    } finally { if (token === selectionGeneration.current) setCreating(false); }
  }, [loading, posting, computerUpdating, modelId, effort, budget, reasoningEnabled, controller,
    chat.owner.origin, user, projectComputerDrafts, draftComputerEnabled, navigate]);
  const sendMessageNow = useCallback(
    (content: string, files: Artifact[]) => sendMessage(content, files, true),
    [sendMessage],
  );
  const stopRun = useCallback(async () => {
    try { await controller.stop(); }
    catch (reason) { setError(errorText(reason, t("error.stop"))); }
  }, [controller]);
  const logout = useCallback(async () => {
    try {
      await api.logout();
      expired();
      navigate("/", true);
    } catch (reason) {
      setError(errorText(reason, t("error.logout")));
    }
  }, [expired, navigate]);
  const changeModel = useCallback(
    async (id: string) => {
      const next = models.find((model) => model.id === id);
      const owner = modelPreferenceOwner.current;
      if (!next || !owner) return;
      const nextEffort = next.efforts?.includes(effort)
        ? effort
        : (next.default_effort ?? "");
      const sessionID = route.kind === "chat" && !isActiveStatus(snapshotRef.current?.status) ? selectedRef.current : null;
      const revision = ++modelPreferenceRevision.current;
      preferredModelRef.current = id;
      setModelId(id);
      setBudget(next.reasoning_budget_default);
      setReasoningEnabled(true);
      setEffort(nextEffort);
      const write = modelPreferenceWrites.current.catch(() => undefined).then(async () => {
        if (modelPreferenceOwner.current !== owner) return;
        const saved = await api.updatePreferences({ preferred_model_id: id });
        if (modelPreferenceOwner.current !== owner) return;
        confirmedModelRef.current = saved.preferred_model_id;
        if (modelPreferenceRevision.current === revision) preferredModelRef.current = saved.preferred_model_id;
        if (sessionID && selectedRef.current === sessionID) await controller.updateSession({ model_id: id, effort: nextEffort });
      });
      modelPreferenceWrites.current = write;
      try {
        await write;
      } catch (reason) {
        if (modelPreferenceOwner.current !== owner) return;
        if (modelPreferenceRevision.current === revision) preferredModelRef.current = confirmedModelRef.current;
        setError(errorText(reason, t("error.rememberModel")));
      }
    },
    [models, effort, route.kind, controller],
  );
  const changeEffort = useCallback(async (value: string) => {
    try {
      if (route.kind === "chat" && selectedRef.current && !isActiveStatus(snapshotRef.current?.status))
        await controller.updateSession({ effort: value });
      setEffort(value);
    } catch (reason) {
      setError(errorText(reason, t("error.switch")));
    }
  }, [route.kind, controller]);
  const changeComputer = useCallback(
    async (enabled: boolean) => {
      if (computerUpdating || loading || posting) return;
      const id = selectedRef.current;
      const actor = userRef.current?.id;
      const token = selectionGeneration.current;
      setComputerUpdating(true);
      setError("");
      try {
        if (id) {
          const updated = await controller.updateSession({ computer_enabled: enabled, remember_computer_default: !computerOnce });
          if (!updated || userRef.current?.id !== actor || token !== selectionGeneration.current) return;
          if (!updated.project_id && !computerOnce) setComputerDefault(enabled);
        } else {
          const preferences = await api.updatePreferences({
            computer_default: enabled,
          });
          if (userRef.current?.id !== actor) return;
          setComputerDefault(preferences.computer_default);
          if (!selectedRef.current)
            setDraftComputerEnabled(preferences.computer_default);
        }
      } catch (reason) {
        if (userRef.current?.id === actor)
          setError(errorText(reason, t("error.save")));
      } finally {
        setComputerUpdating(false);
      }
    },
    [
      computerUpdating,
      computerOnce,
      loading,
      posting,
      controller,
      ],
  );
  const resumeRun = useCallback(async (runId: string, answer: string) => {
    if (snapshotRef.current?.run_id === runId) await controller.resume(answer);
  }, [controller]);
  const requestRetry = useCallback((message: Message) => {
    setRevision({ message, kind: "retry" });
    setRevisionText("");
  }, []);
  const requestEdit = useCallback((message: Message) => {
    setRevision({ message, kind: "edit" });
    setRevisionText(message.content);
  }, []);
  async function renameSession(id: string, title: string) {
    try {
      const next = await api.updateSession(id, { title });
      if (selectedRef.current === id) void controller.refresh(true);
      setSessions((current) =>
        current.map((item) => (item.id === id ? next : item)),
      );
    } catch (reason) {
      setError(errorText(reason, t("error.save")));
    }
  }
  async function deleteSession(id: string) {
    try {
      await api.deleteSession(id);
      setSessions((current) => current.filter((item) => item.id !== id));
      if (selectedId === id) newConversation();
    } catch (reason) {
      setError(errorText(reason, t("error.delete")));
    }
  }
  async function loadOlder() {
    try { await controller.loadOlder(); }
    catch (reason) { setError(errorText(reason, t("error.load"))); }
  }
  async function loadMoreSessions() {
    if (!sessionCursor || sessionsLoadingMore) return;
    const token = railGeneration.current;
    setSessionsLoadingMore(true);
    try {
      const page = await api.sessionsPage({ cursor: sessionCursor });
      if (token !== railGeneration.current) return;
      railPaged.current = true;
      setSessions((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setSessionCursor(page.next_cursor);
    } catch (reason) {
      if (token === railGeneration.current) setError(errorText(reason, t("error.load")));
    } finally {
      if (token === railGeneration.current) setSessionsLoadingMore(false);
    }
  }
  async function refreshModels() {
    try {
      const available = await api.models();
      setModels(available ?? []);
      if (!available?.some((model) => model.id === modelId)) {
        const chosen = preferredChatModel(available ?? [], preferredModelRef.current);
        setModelId(chosen?.id ?? "");
        setEffort(chosen?.default_effort ?? "");
      }
    } catch (reason) {
      setError(errorText(reason, t("error.load")));
    }
  }
  async function revise() {
    if (!revision || !selectedId || posting || busy || computerUpdating) return;
    const token = selectionGeneration.current;
    setError("");
    try {
      await controller.send(revision.kind === "edit" ? revisionText.trim() : "", {
        model_id: modelId, effort,
        ...reasoningParameters(modelsRef.current.find((model) => model.id === modelId), budget, reasoningEnabled),
        ...(revision.kind === "edit" ? { edit_message_id: revision.message.id } : { retry_run_id: revision.message.run_id }),
      });
      if (token === selectionGeneration.current) setRevision(null);
    } catch (reason) { if (token === selectionGeneration.current) setError(errorText(reason, t("error.rerun"))); }
  }

  if (!authChecked)
    return (
      <div className="splash">
        <LoaderCircle className="spin" size={24} />
      </div>
    );
  if (!user)
    return (
      <LoginScreen
        onLogin={(current) => {
              setError("");
          setUser(current);
        }}
      />
    );
  async function refreshProjects() {
    try {
      setProjects(await api.projects());
    } catch (reason) {
      setError(errorText(reason, t("error.load")));
    }
  }
  if (route.kind === "admin" && user.role === "admin")
    return (
      <Suspense
        fallback={
          <div className="splash">
            <LoaderCircle className="spin" />
          </div>
        }
      >
        <AdminPanel
          currentUserID={user.id}
          section={route.section ?? "providers"}
          onNavigate={navigate}
          onBack={() => {
            navigate(selectedId ? `/c/${selectedId}` : "/");
            void refreshModels();
          }}
        />
      </Suspense>
    );
  const busy = posting || isActiveStatus(snapshot?.status);
  const empty = messages.length === 0 && !snapshot && !loading;
  const statusText = reconnecting
    ? t("status.reconnecting")
    : snapshot?.status === "waiting_user"
      ? snapshot.waiting_input?.kind === "computer_permission"
        ? t("status.awaitingPermission")
        : t("status.awaitingReply")
      : snapshot?.status === "queued"
        ? t("status.queued")
        : snapshot?.status === "waiting_resource"
          ? t("status.awaitingWorkspace")
          : snapshot?.status === "cancelling"
            ? t("status.stopping")
            : busy
              ? t("status.processing")
              : snapshot?.status === "completed"
                ? t("status.completed")
                : snapshot?.status === "failed"
                  ? t("status.failed")
              : snapshot?.status === "cancelled"
                ? t("status.stopped")
                : snapshot?.status === "interrupted"
                  ? t("status.interrupted")
                  : "";
  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <Sidebar
        sessions={sessions}
        moreAvailable={Boolean(sessionCursor)}
        moreLoading={sessionsLoadingMore}
        onLoadMore={() => void loadMoreSessions()}
        selectedId={route.kind === "chat" ? selectedId : null}
        user={user}
        open={drawerOpen}
        collapsed={collapsed}
        disabled={posting}
        onClose={() => setDrawerOpen(false)}
        onCollapse={() => setCollapsed((value) => !value)}
        onCreate={newConversation}
        onSelect={(id) => {
          if (!posting) void selectSession(id);
        }}
        onRename={renameSession}
        onDelete={deleteSession}
        onLogout={logout}
        onSettings={() => setSettingsOpen(true)}
        onComputer={() => setComputerOpen(true)}
        onAdmin={() => {
          navigate("/admin/providers");
        }}
        projects={projects}
        selectedProjectId={
          route.kind === "projects"
            ? route.id
            : route.kind === "chat" ? selected?.project_id : undefined
        }
        onProjects={() => navigate("/projects")}
        onProject={(id) => navigate(`/projects/${id}`)}
        onSchedules={() => {
          navigate("/tasks");
          setDrawerOpen(false);
        }}
      />
      {route.kind === "projects" ? (
        <Suspense
          fallback={
            <div className="panel-loading">
              <LoaderCircle className="spin" />
            </div>
          }
        >
          <ProjectsPage
            projectId={route.id}
            onNavigate={navigate}
            onRefresh={() => void refreshProjects()}
            onMenu={() => setDrawerOpen(true)}
            renderComposer={(id) => <>
              {error && <p className="form-error" role="alert">{error}</p>}
              <Composer
                key={`project-${id}`}
                draftKey={`assistant.draft.v2.${user.id}.project.${id}`}
                onSubmit={(content, files) => sendMessage(content, files, false, id)}
                onStop={() => undefined}
                onError={setError}
                models={models}
                modelId={modelId}
                effort={effort}
                onModel={changeModel}
                onEffort={changeEffort}
                budget={budget}
                onBudget={setBudget}
                reasoningEnabled={reasoningEnabled}
                onReasoningEnabled={setReasoningEnabled}
                computerEnabled={projectComputerDrafts[id] ?? true}
                onComputer={(enabled) => setProjectComputerDrafts((current) => ({ ...current, [id]: enabled }))}
                busy={false}
                unavailable={loading || posting}
                stopping={false}
              />
            </>}
          />
        </Suspense>
      ) : route.kind === "tasks" ? (
        <Suspense
          fallback={
            <div className="panel-loading">
              <LoaderCircle className="spin" />
            </div>
          }
        >
          <TasksPage
            taskId={route.id}
            executionId={route.runId}
            sessions={sessions}
            models={models}
            projects={projects}
            onNavigate={navigate}
            onMenu={() => setDrawerOpen(true)}
          />
        </Suspense>
      ) : (
        <main className={`chat-shell ochi-chat ${empty ? "is-empty" : ""}`}>
          <header className="chat-header">
            <div className="header-title">
              <MobileMenuButton onClick={() => setDrawerOpen(true)} />
              {selected?.project_id && (
                <button
                  className="header-project chat-project-crumb"
                  onClick={() => navigate(`/projects/${selected.project_id}`)}
                >
                  <Folder size={14} />
                  {
                    projects.find((item) => item.id === selected.project_id)
                      ?.name
                  }
                </button>
              )}
              {selected?.project_id && <ChevronRight className="chat-crumb-chevron" size={13} />}
              {!empty && <h1>{selected?.title || t("chat.newConversation")}</h1>}
            </div>
            <div className="header-actions">
              <span className={`status-text ${snapshot?.status === "completed" ? "status-completed" : ""}`} role="status" aria-live="polite">
                {snapshot?.status === "completed" && <Check size={13} />}
                {statusText}
              </span>
              <button
                className="icon-button mobile-new-chat"
                aria-label={t("chat.newConversation")}
                onClick={newConversation}
              >
                <SquarePen size={19} />
              </button>
            </div>
          </header>
          {loading ? (
            <div className="chat-loading">
              <LoaderCircle className="spin" size={21} aria-label={t("status.loading")} />
            </div>
          ) : (
            <MessageList
              messages={messages}
              snapshot={snapshot}
              sessionId={selectedId}
              onLoadOlder={olderAvailable ? loadOlder : undefined}
              olderLoading={olderLoading}
              onRetry={!busy ? requestRetry : undefined}
              onEdit={!busy ? requestEdit : undefined}
              onResume={resumeRun}
            />
          )}
          {error && (
            <div className="inline-error" role="alert">
              <span>{error}</span>
              <button
                className="icon-button"
                onClick={() => setError("")}
                aria-label={t("common.close")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          <div className={`composer-wrap ${empty ? "composer-home" : ""}`}>
            <QueueTray
              items={queue}
              onCancel={async (id) => {
                if (!selectedId) return;
                try {
                  await controller.cancelQueued(id);
                } catch (reason) {
                  setError(errorText(reason, t("error.cancel")));
                }
              }}
              onEdit={async (id, message) => {
                if (!selectedId) return;
                await controller.updateQueued(id, message);
              }}
            />
            <RunInstructionStatus items={instructions.items} error={instructions.error} syncError={instructions.syncError}
              retryPending={instructions.retryPending} submitting={instructions.submitting} onRetry={instructions.retry} onRefresh={instructions.refresh} />
            <Composer
              key={composerKey}
              draftKey={`assistant.draft.v2.${user.id}.${selectedId ?? "new"}`}
              onSubmit={sendMessage}
              onSubmitNow={sendMessageNow}
              onSupplement={instructions.canSend && !revision ? instructions.send : undefined}
              supplementBusy={instructions.submitting}
              supplementAccepted={instructions.accepted}
              budget={budget}
              onBudget={setBudget}
              reasoningEnabled={reasoningEnabled}
              onReasoningEnabled={setReasoningEnabled}
              computerEnabled={computerAvailable}
              computerOnce={computerOnce}
              computerUpdating={computerUpdating}
              onComputer={changeComputer}
              onStop={stopRun}
              onError={setError}
              busy={busy}
              unavailable={loading || posting || computerUpdating}
              stopping={snapshot?.status === "cancelling"}
              models={models}
              modelId={modelId}
              effort={effort}
              onModel={changeModel}
              onEffort={changeEffort}
            />
          </div>
        </main>
      )}
      {settingsOpen && (
        <Suspense fallback={null}>
          <UserSettings
            onLanguage={changeLanguage}
            projects={projects}
            onNavigate={navigate}
            onClose={() => setSettingsOpen(false)}
          />
        </Suspense>
      )}
      {computerOpen && (
        <ComputerPanel
          onClose={() => setComputerOpen(false)}
        />
      )}
      {revision && (
        <Modal
          title={revision.kind === "edit" ? t("chat.editMessage") : t("chat.regenerateConfirm")}
          onClose={() => setRevision(null)}
          size={revision.kind === "edit" ? "form" : "small"}
          footer={
            <>
              <button
                className="secondary-button"
                onClick={() => setRevision(null)}
                disabled={posting}
              >
                {t("common.cancel")}
              </button>
              <button
                className="primary-button"
                onClick={() => void revise()}
                disabled={
                  posting || (revision.kind === "edit" && !revisionText.trim())
                }
              >
                {posting ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  t("chat.rerun")
                )}
              </button>
            </>
          }
        >
          {revision.kind === "edit" && (
            <textarea
              className="field-input"
              rows={5}
              value={revisionText}
              onChange={(event) => setRevisionText(event.target.value)}
              aria-label={t("chat.messageContent")}
            />
          )}
          {messages.some(
            (message) =>
              message.run_id === revision.message.run_id &&
              (message.step_count ?? 0) > 0,
          ) && <p className="revision-warning">{t("chat.rerunWarning")}</p>}
        </Modal>
      )}
    </div>
  );
}
