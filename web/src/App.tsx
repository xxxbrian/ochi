import { t, useI18n, setLanguage, type LanguagePreference } from "./lib/i18n";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown, ChevronRight, Download, Folder, PanelLeft, Pin, PinOff, Search, Settings, SquarePen, X } from "lucide-react";
import { usePinnedSessions } from "./lib/pinnedSessions";
import { exportTranscript } from "./lib/exportTranscript";
import { ActionMenu, MenuAction } from "./components/ui/Menu";
import { ToastHost, toast } from "./components/ui/Toast";
import { releaseMemoryOwner } from "./components/settings/memoryStore";
import { EmptyHero } from "./components/EmptyHero";
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
import { PreferencesProvider, useAccountPreferences } from "./hooks/useAccountPreferences";
import { LoginScreen } from "./components/LoginScreen";
import { Sidebar, MobileMenuButton, modKey, type PaletteCommand } from "./components/Sidebar";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { RunInstructionStatus } from "./components/RunInstructionStatus";
import { ComputerPanel } from "./components/ComputerPanel";
import { ArtifactDock } from "./components/ArtifactDock";
import { closeArtifact, setArtifactOwner, useArtifactDock } from "./lib/artifactDock";
import { Modal } from "./components/Modal";
import { QueueTray } from "./components/QueueTray";
import { useRouter } from "./lib/router";
import "./components/shell.css";
import { LoadingDots, SkelRows } from "./components/ui/Loading";

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
  const { owner: preferencesOwner, preferences } = useAccountPreferences(user?.id ?? "");
  const preferencesOwnerRef = useRef(preferencesOwner);
  preferencesOwnerRef.current = preferencesOwner;
  useLayoutEffect(() => {
    setArtifactOwner(user?.id ?? null);
    return () => setArtifactOwner(null);
  }, [user?.id]);
  const [authChecked, setAuthChecked] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string>();
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  const railPaged = useRef(false);
  const railGeneration = useRef(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.("(max-width: 719px)").matches));
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 719px)");
    if (!query) return;
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const pins = usePinnedSessions(user?.id ?? "");
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
  const computerDefault = preferences?.computer_default ?? false;
  const [draftComputerEnabled, setDraftComputerEnabled] = useState(false);
  const [projectComputerDrafts, setProjectComputerDrafts] = useState<Record<string, boolean>>({});
  const [computerUpdating, setComputerUpdating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [computerOpen, setComputerOpen] = useState(false);
  // The right-hand dock holds one panel: opening a file replaces the desktop view.
  const openArtifactFile = useArtifactDock().file;
  useEffect(() => { if (openArtifactFile) setComputerOpen(false); }, [openArtifactFile]);
  const [revision, setRevision] = useState<{
    message: Message;
    kind: "edit" | "retry";
  } | null>(null);
  const [revisionText, setRevisionText] = useState("");
  const [composerKey, setComposerKey] = useState(0);
  const userRef = useRef<User | null>(null);
  const selectedRef = useRef<string | null>(null);
  const modelsRef = useRef<Model[]>([]);
  const modelSelectionRevision = useRef(0);
  const selectionGeneration = useRef(0);
  userRef.current = user;
  modelsRef.current = models;
  const signIn = useCallback((current: User) => {
    const previous = userRef.current;
    if (previous && previous.id !== current.id) {
      releaseMemoryOwner(previous.id);
      preferencesOwnerRef.current.deactivate();
    }
    setUser(current);
  }, []);
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
    if (userRef.current) releaseMemoryOwner(userRef.current.id);
    preferencesOwnerRef.current.deactivate();
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
    setDraftComputerEnabled(false);
    setComputerUpdating(false);
    setComputerOpen(false);
    setSettingsOpen(false);
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
    const chosen = models.find((model) => model.id === selected.model_id)
      ?? preferredChatModel(models, preferencesOwner.getSnapshot().preferences?.preferred_model_id ?? "");
    if (!chosen) return;
    selectedModelOwner.current = selected.id;
    setModelId(chosen.id);
    setBudget(selected.effort?.startsWith("budget:") ? Number(selected.effort.slice(7)) : chosen.reasoning_budget_default);
    setReasoningEnabled(selected.effort !== "off");
    setEffort(chosen.efforts?.includes(selected.effort ?? "") ? selected.effort ?? "" : chosen.default_effort ?? "");
  }, [selected, models, preferencesOwner]);
  useEffect(() => {
    if (preferences) setLanguage(preferences.language);
  }, [preferences?.language]);
  useEffect(() => {
    if (!preferences || selectedRef.current) return;
    setDraftComputerEnabled(preferences.computer_default);
    const chosen = preferredChatModel(models, preferences.preferred_model_id);
    if (!chosen || chosen.id === modelId) return;
    setModelId(chosen.id);
    setEffort(chosen.default_effort ?? "");
    setBudget(chosen.reasoning_budget_default);
    setReasoningEnabled(true);
  }, [preferences?.preferred_model_id, preferences?.computer_default, models, modelId]);
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
        if (!cancelled) signIn(current);
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
    railGeneration.current += 1;
    let cancelled = false;
    setBootstrapLoading(true);
    Promise.all([
      api.sessionsPage(),
      api.models(),
      api.projects(),
      preferencesOwner.load(),
    ])
      .then(([list, available, allProjects]) => {
        if (cancelled) return;
        const preferences = preferencesOwner.getSnapshot().preferences;
        if (!preferences) return;
        modelsRef.current = available ?? [];
        setModels(available ?? []);
        setProjects(allProjects ?? []);
        replaceSessions(list, true);
        setDraftComputerEnabled(preferences.computer_default);
        const defaultModel = preferredChatModel(available ?? [], preferences.preferred_model_id);
        if (defaultModel && !selectedRef.current) {
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
    };
  }, [user, selectSession, navigate, replaceSessions, preferencesOwner]);
  const changeLanguage = useCallback(async (next: LanguagePreference) => {
    const owner = preferencesOwnerRef.current;
    try { await owner.update({ language: next }); }
    catch (reason) {
      if (preferencesOwnerRef.current === owner) throw reason;
    }
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
      const chosen = preferredChatModel(modelsRef.current, preferencesOwner.getSnapshot().preferences?.preferred_model_id ?? "");
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
    preferencesOwner,
  ]);
  useEffect(() => {
    const keys = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "k") { event.preventDefault(); setSearchOpen(true); }
      else if (key === "b") { event.preventDefault(); toggleSidebar(); }
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  });
  useEffect(() => {
    if (!drawerOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [drawerOpen]);

  function toggleSidebar() {
    if (compact) setDrawerOpen((value) => !value);
    else setCollapsed((value) => !value);
  }
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
    const chosen = preferredChatModel(modelsRef.current, preferencesOwner.getSnapshot().preferences?.preferred_model_id ?? "");
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
    preferencesOwner,
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
      const owner = preferencesOwnerRef.current;
      if (!next || !userRef.current) return;
      const nextEffort = next.efforts?.includes(effort)
        ? effort
        : (next.default_effort ?? "");
      const selectedAtChange = selectedRef.current;
      const sessionID = route.kind === "chat" && !isActiveStatus(snapshotRef.current?.status) ? selectedAtChange : null;
      const revision = ++modelSelectionRevision.current;
      setModelId(id);
      setBudget(next.reasoning_budget_default);
      setReasoningEnabled(true);
      setEffort(nextEffort);
      try {
        const saved = await owner.update({ preferred_model_id: id });
        if (!saved || preferencesOwnerRef.current !== owner) return;
        if (sessionID && selectedRef.current === sessionID && modelSelectionRevision.current === revision)
          await controller.updateSession({ model_id: id, effort: nextEffort });
      } catch (reason) {
        if (preferencesOwnerRef.current !== owner) return;
        if (modelSelectionRevision.current === revision && selectedRef.current === selectedAtChange) {
          const session = controller.getSnapshot().session;
          const fallback = selectedAtChange ? modelsRef.current.find((model) => model.id === session?.model_id) : undefined;
          const restored = fallback ?? preferredChatModel(modelsRef.current, owner.getSnapshot().preferences?.preferred_model_id ?? "");
          setModelId(restored?.id ?? "");
          setEffort(selectedAtChange && session?.effort ? session.effort : restored?.default_effort ?? "");
          setBudget(selectedAtChange && session?.effort?.startsWith("budget:") ? Number(session.effort.slice(7)) : restored?.reasoning_budget_default);
          setReasoningEnabled(!selectedAtChange || session?.effort !== "off");
        }
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
      const owner = preferencesOwnerRef.current;
      const token = selectionGeneration.current;
      setComputerUpdating(true);
      setError("");
      try {
        if (id) {
          const updated = await controller.updateSession({ computer_enabled: enabled, remember_computer_default: false });
          if (!updated || userRef.current?.id !== actor || token !== selectionGeneration.current) return;
          if (!updated.project_id && !computerOnce) await owner.update({ computer_default: enabled });
        } else {
          await owner.update({ computer_default: enabled });
        }
      } catch (reason) {
        if (userRef.current?.id === actor && preferencesOwnerRef.current === owner)
          setError(errorText(reason, t("error.save")));
      } finally {
        if (preferencesOwnerRef.current === owner) setComputerUpdating(false);
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
        const chosen = preferredChatModel(available ?? [], preferencesOwner.getSnapshot().preferences?.preferred_model_id ?? "");
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
        <LoadingDots label={t("status.loading")} />
      </div>
    );
  if (!user)
    return (
      <LoginScreen
        onLogin={(current) => {
          setError("");
          signIn(current);
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
            <LoadingDots label={t("status.loading")} />
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
  const expanded = compact ? drawerOpen : !collapsed;
  const searchCommands: PaletteCommand[] = [
    { id: "new", icon: <SquarePen className="ic" />, label: t("chat.newConversation"), run: newConversation },
    { id: "settings", icon: <Settings className="ic" />, label: t("settings.title"), run: () => setSettingsOpen(true) },
    { id: "sidebar", icon: <PanelLeft className="ic" />, label: expanded ? t("sidebar.collapse") : t("sidebar.expand"), hint: `${modKey}B`, run: toggleSidebar },
    ...(user.role === "admin" ? [{ id: "admin", icon: <Check className="ic" />, label: t("sidebar.admin"), run: () => navigate("/admin/providers") }] : []),
  ];
  const selectedPinned = Boolean(selectedId && pins.pinned.includes(selectedId));
  async function exportSelected() {
    if (!selectedId) return;
    try { await exportTranscript(selectedId, selected?.title || t("chat.newConversation")); toast(t("sidebar.exported"), { icon: "check" }); }
    catch (reason) { toast(reason instanceof Error ? reason.message : t("sidebar.exportFailed"), { icon: "info" }); }
  }
  const crumbProject = selected?.project_id ? projects.find((item) => item.id === selected.project_id) : undefined;
  return (
    <div className="app-shell" data-sb={expanded} data-rail={!compact && collapsed} data-compact={compact}>
      <Sidebar
        sessions={sessions}
        moreAvailable={Boolean(sessionCursor)}
        moreLoading={sessionsLoadingMore}
        onLoadMore={() => void loadMoreSessions()}
        selectedId={route.kind === "chat" ? selectedId : null}
        user={user}
        expanded={expanded}
        compact={compact}
        disabled={posting}
        pinned={pins.pinned}
        onToggle={toggleSidebar}
        onPin={pins.toggle}
        onCreate={newConversation}
        onSelect={(id) => {
          if (!posting) void selectSession(id);
        }}
        onRename={renameSession}
        onDelete={async (id) => { await deleteSession(id); pins.forget(id); }}
        onLogout={logout}
        onSettings={() => setSettingsOpen(true)}
        onComputer={() => { if (computerOpen) { setComputerOpen(false); return; } closeArtifact(); setComputerOpen(true); setDrawerOpen(false); }}
        computerActive={computerOpen}
        newActive={route.kind === "chat" && !selectedId}
        onAdmin={() => navigate("/admin/providers")}
        projectsActive={route.kind === "projects"}
        tasksActive={route.kind === "tasks"}
        onProjects={() => { navigate("/projects"); setComputerOpen(false); setDrawerOpen(false); }}
        onSchedules={() => { navigate("/tasks"); setComputerOpen(false); setDrawerOpen(false); }}
        searchOpen={searchOpen}
        onSearchOpenChange={setSearchOpen}
        searchCommands={searchCommands}
      />
      {compact && <div className="sb-scrim" data-open={drawerOpen} onClick={() => setDrawerOpen(false)} />}
      {route.kind === "projects" ? (
        <Suspense
          fallback={
            <div className="panel-loading"><SkelRows count={5} /></div>
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
            <div className="panel-loading"><SkelRows count={5} /></div>
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
        <main className="app-main">
          <section className="view-chat" data-empty={empty}>
            <header className="topbar">
              <MobileMenuButton onClick={() => setDrawerOpen(true)} />
              {crumbProject && (
                <>
                  <button className="top-crumb" onClick={() => navigate(`/projects/${crumbProject.id}`)}>
                    <Folder className="ic" /><span>{crumbProject.name}</span>
                  </button>
                  <ChevronRight className="top-crumb-sep" />
                </>
              )}
              {!empty && (selectedId ? (
                <ActionMenu className="title-btn" align="start" label={t("chat.manage", { name: selected?.title || t("chat.newConversation") })}
                  trigger={<><h1><span>{selected?.title || t("chat.newConversation")}</span></h1><ChevronDown className="ic" /></>}>
                  <MenuAction onClick={() => { pins.toggle(selectedId); toast(selectedPinned ? t("sidebar.unpinned") : t("sidebar.pinnedToast")); }}>
                    {selectedPinned ? <PinOff className="ic" /> : <Pin className="ic" />}{selectedPinned ? t("sidebar.unpin") : t("sidebar.pin")}
                  </MenuAction>
                  <MenuAction onClick={() => void exportSelected()}><Download className="ic" />{t("sidebar.export")}</MenuAction>
                </ActionMenu>
              ) : <h1 className="title-btn"><span>{t("chat.newConversation")}</span></h1>)}
              <span className="grow" />
              <span className="top-status" data-tone={snapshot?.status === "failed" ? "danger" : undefined} role="status" aria-live="polite">
                {snapshot?.status === "completed" && <Check className="ic" />}
                {statusText}
              </span>
              <button className="icon-btn mobile-new-chat" aria-label={t("chat.newConversation")} onClick={newConversation}>
                <SquarePen className="ic" />
              </button>
            </header>
            {loading ? (
              <div className="chat-loading" role="status" aria-label={t("status.loading")}>
                <div className="chat-skel" aria-hidden="true">
                  <span className="skel block chat-skel-user" />
                  <span className="skel line" style={{ width: "92%" }} />
                  <span className="skel line" style={{ width: "78%" }} />
                  <span className="skel line" style={{ width: "54%" }} />
                </div>
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
            {empty && <EmptyHero name={user.display_name || user.username} />}
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
          <div className="composer-wrap"><div className="composer-in">
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
          </div></div>
          </section>
        </main>
      )}
      <ArtifactDock />
      {computerOpen && <ComputerPanel onClose={() => setComputerOpen(false)} />}
      <ToastHost key={user.id} />
      {settingsOpen && (
        <Suspense fallback={null}>
          <PreferencesProvider value={preferencesOwner}>
            <UserSettings
              user={user}
              onLogout={logout}
              onLanguage={changeLanguage}
              projects={projects}
              onNavigate={navigate}
              onClose={() => setSettingsOpen(false)}
            />
          </PreferencesProvider>
        </Suspense>
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
                className={`primary-button${posting ? " btn-progress" : ""}`}
                onClick={() => void revise()}
                disabled={
                  posting || (revision.kind === "edit" && !revisionText.trim())
                }
              >
                {t("chat.rerun")}
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
