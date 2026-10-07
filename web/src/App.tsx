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
import type {
  Artifact,
  Message,
  Model,
  PendingRun,
  Project,
  Session,
  SessionPage,
  Snapshot,
  User,
} from "./lib/types";
import { useRunStream } from "./hooks/useRunStream";
import { useRunInstructions } from "./hooks/useRunInstructions";
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
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string>();
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  const railPaged = useRef(false);
  const railGeneration = useRef(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("");
  const { route, navigate } = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [queue, setQueue] = useState<PendingRun[]>([]);
  const [budget, setBudget] = useState<number | undefined>();
  const [reasoningEnabled, setReasoningEnabled] = useState(true);
  const [computerDefault, setComputerDefault] = useState(false);
  const [draftComputerEnabled, setDraftComputerEnabled] = useState(false);
  const [projectComputerDrafts, setProjectComputerDrafts] = useState<Record<string, boolean>>({});
  const [computerUpdating, setComputerUpdating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [computerOpen, setComputerOpen] = useState(false);
  const [olderAvailable, setOlderAvailable] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [revision, setRevision] = useState<{
    message: Message;
    kind: "edit" | "retry";
  } | null>(null);
  const [revisionText, setRevisionText] = useState("");
  const [composerKey, setComposerKey] = useState(0);
  const userRef = useRef<User | null>(null);
  const selectedRef = useRef<string | null>(null);
  const selectedSessionRef = useRef<Session | null>(null);
  const modelsRef = useRef<Model[]>([]);
  const selectionGeneration = useRef(0);
  userRef.current = user;
  modelsRef.current = models;
  const updateSelectedSession = useCallback((next: Session | null) => {
    if (!next) {
      selectedSessionRef.current = null;
      setSelectedSession(null);
      return;
    }
    if (next.id !== selectedRef.current) return;
    const current = selectedSessionRef.current;
    if (current?.id === next.id && olderSession(next, current)) return;
    const updated = { ...current, ...next };
    selectedSessionRef.current = updated;
    setSelectedSession(updated);
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
      const current = list.find((item) => item.id === selectedRef.current);
      if (current) updateSelectedSession(current);
    },
    [updateSelectedSession],
  );
  useEffect(() => {
    if (user && user.role !== "admin" && route.kind === "admin")
      navigate("/", true);
  }, [user, route.kind, navigate]);

  const terminal = useCallback(
    async (result: Snapshot) => {
      const token = selectionGeneration.current;
      try {
        const [history, list] = await Promise.all([
          api.messages(result.session_id),
          api.sessionsPage(),
        ]);
        if (
          selectedRef.current !== result.session_id ||
          token !== selectionGeneration.current
        )
          return;
        setMessages((current) => {
          const incoming = new Set((history ?? []).map((message) => message.id));
          const older = current.filter(
            (message) =>
              !incoming.has(message.id) &&
              !message.id.startsWith("pending-") &&
              message.created_at < (history?.[0]?.created_at ?? ""),
          );
          return [...older, ...(history ?? [])];
        });
        replaceSessions(list);
        const [pending, session] = await Promise.all([
          api.queue(result.session_id),
          api.session(result.session_id),
        ]);
        if (
          selectedRef.current !== result.session_id ||
          token !== selectionGeneration.current
        )
          return;
        setQueue(pending ?? []);
        updateSelectedSession(session);
        if (session.latest_run && session.latest_run.run_id !== result.run_id)
          followRef.current(session.latest_run);
      } catch (reason) {
        if (token === selectionGeneration.current)
          setError(errorText(reason, "暂时无法加载"));
      }
    },
    [replaceSessions, updateSelectedSession],
  );
  const expired = useCallback(() => {
    selectionGeneration.current += 1;
    selectedRef.current = null;
    setSelectedId(null);
    updateSelectedSession(null);
    setUser(null);
    setSessions([]);
    railGeneration.current += 1;
    railPaged.current = false;
    setSessionCursor(undefined);
    setSessionsLoadingMore(false);
    setMessages([]);
    setPosting(false);
    setLoading(false);
    setComputerDefault(false);
    setDraftComputerEnabled(false);
    setComputerOpen(false);
    setRevision(null);
    setError("");
  }, [updateSelectedSession]);
  const { snapshot, reconnecting, follow, clear } = useRunStream(
    terminal,
    expired,
  );
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const instructions = useRunInstructions(`${user?.id ?? ""}:${selectedId ?? "new"}:${composerKey}`,
    selectedId ?? undefined, snapshot, Boolean(user && route.kind === "chat"));
  const followRef = useRef(follow);
  followRef.current = follow;
  const selected = selectedSession?.id === selectedId ? selectedSession : null;
  const computerEnabled = selectedId
    ? Boolean(selected?.computer_enabled)
    : draftComputerEnabled;
  const computerAvailable =
    computerEnabled ||
    (isActiveStatus(snapshot?.status) && Boolean(snapshot?.computer_granted));
  const computerOnce = !computerEnabled && computerAvailable;

  const selectSession = useCallback(
    async (id: string, restoring = false) => {
      const token = ++selectionGeneration.current;
      clear();
      selectedRef.current = id;
      if (userRef.current) storeSelection(userRef.current, id);
      setSelectedId(id);
      updateSelectedSession(null);
      setMessages([]);
      setQueue([]);
      setError("");
      setLoading(true);
      setRevision(null);
      setDrawerOpen(false);
      if (!restoring) navigate(`/c/${id}`);
      setComposerKey((value) => value + 1);
      try {
        const [session, loadedHistory, pending] = await Promise.all([
          api.session(id),
          api.messages(id),
          api.queue(id),
        ]);
        if (token === selectionGeneration.current) setQueue(pending ?? []);
        if (token !== selectionGeneration.current) return;
        let history = loadedHistory;
        if (session.latest_run && !isActiveStatus(session.latest_run.status)) {
          history = await api.messages(id);
          if (token !== selectionGeneration.current) return;
        }
        setMessages(history ?? []);
        setOlderAvailable((history?.length ?? 0) >= 100);
        const chosen =
          modelsRef.current.find((model) => model.id === session.model_id) ??
          modelsRef.current.find((model) => model.is_default) ??
          modelsRef.current[0];
        if (chosen) {
          setBudget(
            session.effort?.startsWith("budget:")
              ? Number(session.effort.slice(7))
              : chosen.reasoning_budget_default,
          );
          setReasoningEnabled(session.effort !== "off");
          setModelId(chosen.id);
          setEffort(
            chosen.efforts?.includes(session.effort ?? "")
              ? (session.effort ?? "")
              : (chosen.default_effort ?? ""),
          );
        }
        setSessions((current) =>
          current.some((item) => item.id === id)
            ? current.map((item) => (item.id === id ? session : item))
            : [session, ...current],
        );
        updateSelectedSession(session);
        if (session.latest_run) follow(session.latest_run);
      } catch (reason) {
        if (token === selectionGeneration.current)
          setError(errorText(reason, "加载失败"));
      } finally {
        if (token === selectionGeneration.current) setLoading(false);
      }
    },
    [clear, follow, navigate, updateSelectedSession],
  );

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
          setError("暂时无法连接");
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
    setLoading(true);
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
        setComputerDefault(preferences.computer_default);
        setDraftComputerEnabled(preferences.computer_default);
        const defaultModel =
          available?.find((model) => model.is_default) ?? available?.[0];
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
        } else setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(errorText(reason, "暂时无法加载"));
          setLoading(false);
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
  }, [user, selectSession, navigate, replaceSessions]);
  useEffect(() => {
    setDrawerOpen(false);
    if (!user || loading) return;
    if (route.kind === "chat" && route.id && route.id !== selectedRef.current)
      void selectSession(route.id, true);
    else if (route.kind === "chat" && !route.id && selectedRef.current) {
      selectionGeneration.current += 1;
      clear();
      selectedRef.current = null;
      setSelectedId(null);
      updateSelectedSession(null);
      setMessages([]);
      setQueue([]);
      setDraftComputerEnabled(computerDefault);
      setRevision(null);
      setComposerKey((value) => value + 1);
    }
  }, [
    route.kind,
    route.id,
    user,
    selectSession,
    loading,
    clear,
    computerDefault,
    updateSelectedSession,
  ]);
  useEffect(() => {
    if (
      !user ||
      !selectedId ||
      (!isActiveStatus(snapshot?.status) && !queue.length)
    )
      return;
    let disposed = false;
    const refresh = async () => {
      try {
        const [pending, session] = await Promise.all([
          api.queue(selectedId),
          api.session(selectedId),
        ]);
        if (disposed || selectedRef.current !== selectedId) return;
        setQueue(pending ?? []);
        updateSelectedSession(session);
        setSessions((current) =>
          current.map((item) => (item.id === selectedId ? session : item)),
        );
        if (
          session.latest_run &&
          session.latest_run.run_id !== snapshotRef.current?.run_id
        ) {
          const history = await api.messages(selectedId);
          if (disposed) return;
          setMessages(history ?? []);
          follow(session.latest_run);
        }
      } catch {
        /* Streaming reconnect remains independent from queue polling. */
      }
    };
    const interval = setInterval(() => void refresh(), 2000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [
    selectedId,
    user,
    snapshot?.status,
    queue.length,
    follow,
    updateSelectedSession,
  ]);

  useEffect(() => {
    if (!user || !selectedId || selectedSession?.title_source !== "pending" || !snapshot || isActiveStatus(snapshot.status)) return;
    let disposed = false;
    let attempts = 0;
    const interval = setInterval(() => {
      if (++attempts >= 10) clearInterval(interval);
      void api.session(selectedId).then((session) => {
        if (disposed || selectedRef.current !== selectedId) return;
        updateSelectedSession(session);
        setSessions((current) => current.map((item) => item.id === session.id ? session : item));
        if (session.title_source !== "pending") clearInterval(interval);
      }).catch(() => undefined);
    }, 2000);
    return () => { disposed = true; clearInterval(interval); };
  }, [user, selectedId, selectedSession?.title_source, snapshot?.status, updateSelectedSession]);

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
    clear();
    selectedRef.current = null;
    if (user) storeSelection(user, null);
    setSelectedId(null);
    updateSelectedSession(null);
    setMessages([]);
    setError("");
    setLoading(false);
    setDrawerOpen(false);
    setRevision(null);
    setDraftComputerEnabled(computerDefault);
    navigate("/");
    setOlderAvailable(false);
    setQueue([]);
    setComposerKey((value) => value + 1);
  }, [
    posting,
    clear,
    user,
    navigate,
    computerDefault,
    updateSelectedSession,
  ]);

  const sendMessage = useCallback(
    async (content: string, files: Artifact[] = [], now = false, projectId?: string) => {
      if (loading || posting || computerUpdating) return false;
      const token = ++selectionGeneration.current;
      const optimistic: Message = {
        id: `pending-${Date.now()}`,
        role: "user",
        content,
        attachments: files,
        created_at: new Date().toISOString(),
      };
      if (projectId) {
        clear();
        selectedRef.current = null;
        setSelectedId(null);
        updateSelectedSession(null);
        setQueue([]);
        setOlderAvailable(false);
      }
      setMessages((current) => projectId ? [optimistic] : [...current, optimistic]);
      setPosting(true);
      setError("");
      try {
        let id = selectedRef.current;
        if (!id) {
          const created = await api.createSession(
            modelId,
            effort,
            projectId,
            projectId ? (projectComputerDrafts[projectId] ?? true) : draftComputerEnabled,
          );
          if (token !== selectionGeneration.current) return true;
          id = created.id;
          selectedRef.current = id;
          if (user) storeSelection(user, id);
          setSelectedId(id);
          updateSelectedSession(created);
          navigate(`/c/${id}`);
          setSessions((current) => [created, ...current]);
        }
        const result = await api.startRun(id, content, {
          model_id: modelId,
          effort,
          attachment_ids: files.map((file) => file.id),
          stop_current: now,
          ...reasoningParameters(
            modelsRef.current.find((model) => model.id === modelId),
            budget,
            reasoningEnabled,
          ),
        });
        if (token !== selectionGeneration.current) return true;
        if (result.status === "queued") {
          setMessages((current) =>
            current.filter((item) => item.id !== optimistic.id),
          );
          const pending = await api.queue(id);
          if (token === selectionGeneration.current) setQueue(pending);
        } else follow(result);
        if (!isActiveStatus(result.status)) void terminal(result);
        void api
          .sessionsPage()
          .then((list) => {
            if (token === selectionGeneration.current)
              replaceSessions(list);
          })
          .catch(() => undefined);
        return true;
      } catch (reason) {
        if (token === selectionGeneration.current) {
          setMessages((current) =>
            current.filter((item) => item.id !== optimistic.id),
          );
          setError(errorText(reason, "发送失败"));
          // The Project composer unmounts on navigation. Keep its failed input
          // in the newly created conversation rather than silently losing it.
          if (projectId && selectedRef.current) {
            try {
              sessionStorage.setItem(`assistant.draft.v2.${user?.id}.${selectedRef.current}`, content);
            } catch { /* Storage is optional. */ }
            setComposerKey((value) => value + 1);
          }
        }
        return false;
      } finally {
        if (token === selectionGeneration.current) setPosting(false);
      }
    },
    [
      loading,
      posting,
      modelId,
      effort,
      user,
      follow,
      terminal,
      navigate,
      budget,
      reasoningEnabled,
      computerUpdating,
      draftComputerEnabled,
      projectComputerDrafts,
      clear,
      replaceSessions,
      updateSelectedSession,
    ],
  );
  const sendMessageNow = useCallback(
    (content: string, files: Artifact[]) => sendMessage(content, files, true),
    [sendMessage],
  );
  const stopRun = useCallback(async () => {
    const current = snapshotRef.current;
    if (!current || current.status === "cancelling") return;
    try {
      const result = await api.cancelRun(current.run_id);
      if (selectedRef.current === result.session_id) {
        follow(result);
        if (!isActiveStatus(result.status)) void terminal(result);
      }
    } catch (reason) {
      setError(errorText(reason, "停止失败"));
    }
  }, [follow, terminal]);
  const logout = useCallback(async () => {
    try {
      await api.logout();
      clear();
      expired();
      navigate("/", true);
    } catch (reason) {
      setError(errorText(reason, "退出失败"));
    }
  }, [clear, expired, navigate]);
  const changeModel = useCallback(
    async (id: string) => {
      const next = models.find((model) => model.id === id);
      if (!next) return;
      const nextEffort = next.efforts?.includes(effort)
        ? effort
        : (next.default_effort ?? "");
      try {
        if (route.kind === "chat" && selectedRef.current && !isActiveStatus(snapshotRef.current?.status))
          await api.updateSession(selectedRef.current, {
            model_id: id,
            effort: nextEffort,
          });
        setModelId(id);
        setBudget(next.reasoning_budget_default);
        setReasoningEnabled(true);
        setEffort(nextEffort);
      } catch (reason) {
        setError(errorText(reason, "切换失败"));
      }
    },
    [models, effort, route.kind],
  );
  const changeEffort = useCallback(async (value: string) => {
    try {
      if (route.kind === "chat" && selectedRef.current && !isActiveStatus(snapshotRef.current?.status))
        await api.updateSession(selectedRef.current, { effort: value });
      setEffort(value);
    } catch (reason) {
      setError(errorText(reason, "切换失败"));
    }
  }, [route.kind]);
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
          const updated = await api.updateSession(id, {
            computer_enabled: enabled,
            remember_computer_default: !computerOnce,
          });
          if (userRef.current?.id !== actor) return;
          updateSelectedSession(updated);
          setSessions((current) =>
            current.map((item) => (item.id === id ? updated : item)),
          );
          if (!updated.project_id && !computerOnce) {
            setComputerDefault(enabled);
            if (!selectedRef.current) setDraftComputerEnabled(enabled);
          }
          const currentRun = snapshotRef.current;
          if (
            selectedRef.current === id &&
            token === selectionGeneration.current &&
            currentRun?.session_id === id &&
            isActiveStatus(currentRun.status)
          ) {
            try {
              const latest = await api.run(currentRun.run_id);
              if (
                selectedRef.current === id &&
                token === selectionGeneration.current &&
                snapshotRef.current?.run_id === latest.run_id &&
                latest.seq >= snapshotRef.current.seq
              ) {
                follow(latest);
                if (!isActiveStatus(latest.status)) void terminal(latest);
              }
            } catch {
              /* SSE reconnect also restores a saved permission change. */
            }
          }
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
          setError(errorText(reason, "保存失败"));
      } finally {
        setComputerUpdating(false);
      }
    },
    [
      computerUpdating,
      computerOnce,
      loading,
      posting,
      follow,
      terminal,
      updateSelectedSession,
    ],
  );
  const resumeRun = useCallback(
    async (runId: string, answer: string) => {
      const token = selectionGeneration.current;
      const resumed = await api.resumeRun(runId, answer);
      if (
        selectedRef.current !== resumed.session_id ||
        token !== selectionGeneration.current
      )
        return;
      if (
        snapshotRef.current?.run_id === resumed.run_id &&
        resumed.seq >= snapshotRef.current.seq
      ) {
        follow(resumed);
        if (!isActiveStatus(resumed.status)) void terminal(resumed);
      }
      if (answer === "allow_session") {
        const session = await api.session(resumed.session_id);
        if (token !== selectionGeneration.current) return;
        updateSelectedSession(session);
        setSessions((current) =>
          current.map((item) => (item.id === session.id ? session : item)),
        );
      }
    },
    [follow, terminal, updateSelectedSession],
  );
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
      updateSelectedSession(next);
      setSessions((current) =>
        current.map((item) => (item.id === id ? next : item)),
      );
    } catch (reason) {
      setError(errorText(reason, "保存失败"));
    }
  }
  async function deleteSession(id: string) {
    try {
      await api.deleteSession(id);
      setSessions((current) => current.filter((item) => item.id !== id));
      if (selectedId === id) newConversation();
    } catch (reason) {
      setError(errorText(reason, "删除失败"));
    }
  }
  async function loadOlder() {
    if (!selectedId || olderLoading || !messages.length) return;
    const token = selectionGeneration.current;
    setOlderLoading(true);
    try {
      const older = await api.messages(selectedId, messages[0].id);
      if (token !== selectionGeneration.current) return;
      setMessages((current) => [...(older ?? []), ...current]);
      setOlderAvailable((older?.length ?? 0) >= 100);
    } catch (reason) {
      setError(errorText(reason, "加载失败"));
    } finally {
      setOlderLoading(false);
    }
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
      if (token === railGeneration.current) setError(errorText(reason, "加载失败"));
    } finally {
      if (token === railGeneration.current) setSessionsLoadingMore(false);
    }
  }
  async function refreshModels() {
    try {
      const available = await api.models();
      setModels(available ?? []);
      if (!available?.some((model) => model.id === modelId)) {
        const chosen =
          available?.find((model) => model.is_default) ?? available?.[0];
        setModelId(chosen?.id ?? "");
        setEffort(chosen?.default_effort ?? "");
      }
    } catch (reason) {
      setError(errorText(reason, "加载失败"));
    }
  }
  async function revise() {
    if (!revision || !selectedId || posting || busy || computerUpdating) return;
    const token = ++selectionGeneration.current;
    setPosting(true);
    setError("");
    try {
      const result = await api.startRun(
        selectedId,
        revision.kind === "edit" ? revisionText.trim() : "",
        {
          model_id: modelId,
          effort,
          ...reasoningParameters(
            modelsRef.current.find((model) => model.id === modelId),
            budget,
            reasoningEnabled,
          ),
          ...(revision.kind === "edit"
            ? { edit_message_id: revision.message.id }
            : { retry_run_id: revision.message.run_id }),
        },
      );
      if (token !== selectionGeneration.current) return;
      const history = await api.messages(selectedId);
      if (token !== selectionGeneration.current) return;
      setMessages(history ?? []);
      setRevision(null);
      follow(result);
      if (!isActiveStatus(result.status)) void terminal(result);
    } catch (reason) {
      setError(errorText(reason, "重新运行失败"));
    } finally {
      if (token === selectionGeneration.current) setPosting(false);
    }
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
          clear();
          setError("");
          setUser(current);
        }}
      />
    );
  async function refreshProjects() {
    try {
      setProjects(await api.projects());
    } catch (reason) {
      setError(errorText(reason, "加载失败"));
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
    ? "正在重连"
    : snapshot?.status === "waiting_user"
      ? snapshot.waiting_input?.kind === "computer_permission"
        ? "等待授权"
        : "等待回复"
      : snapshot?.status === "queued"
        ? "排队中"
        : snapshot?.status === "waiting_resource"
          ? "等待工作区"
          : snapshot?.status === "cancelling"
            ? "正在停止"
            : busy
              ? "正在处理"
              : snapshot?.status === "completed"
                ? "已完成"
                : snapshot?.status === "failed"
                  ? "未完成"
              : snapshot?.status === "cancelled"
                ? "已停止"
                : snapshot?.status === "interrupted"
                  ? "已中断"
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
              {!empty && <h1>{selected?.title || "新对话"}</h1>}
            </div>
            <div className="header-actions">
              <span className={`status-text ${snapshot?.status === "completed" ? "status-completed" : ""}`} role="status" aria-live="polite">
                {snapshot?.status === "completed" && <Check size={13} />}
                {statusText}
              </span>
              <button
                className="icon-button mobile-new-chat"
                aria-label="新对话"
                onClick={newConversation}
              >
                <SquarePen size={19} />
              </button>
            </div>
          </header>
          {loading ? (
            <div className="chat-loading">
              <LoaderCircle className="spin" size={21} aria-label="加载中" />
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
                aria-label="关闭"
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
                  await api.cancelQueuedRun(selectedId, id);
                  const pending = await api.queue(selectedId);
                  if (selectedRef.current === selectedId) setQueue(pending);
                } catch (reason) {
                  setError(errorText(reason, "取消失败"));
                }
              }}
              onEdit={async (id, message) => {
                if (!selectedId) return;
                await api.updateQueuedRun(selectedId, id, { message });
                const pending = await api.queue(selectedId);
                if (selectedRef.current === selectedId) setQueue(pending);
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
          title={revision.kind === "edit" ? "编辑消息" : "重新生成？"}
          onClose={() => setRevision(null)}
          size={revision.kind === "edit" ? "form" : "small"}
          footer={
            <>
              <button
                className="secondary-button"
                onClick={() => setRevision(null)}
                disabled={posting}
              >
                取消
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
                  "重新运行"
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
              aria-label="消息内容"
            />
          )}
          {messages.some(
            (message) =>
              message.run_id === revision.message.run_id &&
              (message.step_count ?? 0) > 0,
          ) && <p className="revision-warning">重新运行可能再次执行操作。</p>}
        </Modal>
      )}
    </div>
  );
}
