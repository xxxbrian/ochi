import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  BackHandler,
  Keyboard,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import {
  Menu,
  MoreHorizontal,
  Pencil,
  SquarePen,
  Trash2,
  X,
  Clock3,
  SkipForward,
  type LucideIcon,
} from "lucide-react-native";
import {
  router,
  useIsFocused,
  useNavigation,
  type NativeStackNavigationProp,
} from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  KeyboardAvoidingView,
  useKeyboardContext,
  useKeyboardState,
} from "react-native-keyboard-controller";
import Reanimated, { useAnimatedStyle, useReducedMotion } from "react-native-reanimated";
import { api, isActiveStatus } from "../lib/api";
import { useApp } from "../providers/AppProvider";
import { useSessionChat } from "../hooks/useSessionChat";
import { useRunInstructions } from "../hooks/useRunInstructions";
import { useDrawerNavigation } from "../hooks/useDrawerNavigation";
import { BlurScene, GlassSurface } from "../ui/GlassSurface";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { Sheet } from "../ui/Sheet";
import { SessionTitleDialog } from "../ui/SessionTitleDialog";
import { anchorGeometryKey } from "../ui/overlayGeometry";
import {
  ActionIcon,
  AppText,
  Button,
  ErrorNotice,
  Field,
  LoadingState,
} from "../components/ScreenChrome";
import { Composer, type ComposerSubmission } from "../components/Composer";
import { RunInstructionStatus } from "../components/RunInstructionStatus";
import { ChatMessages } from "../components/ChatMessages";
import { SessionDrawer } from "../components/SessionDrawer";
import { brand } from "../../brand.config";
import type { Message, PendingRun } from "../lib/types";

const KeyboardArea = Platform.OS === "android" ? Reanimated.View : KeyboardAvoidingView;

export function ChatScreen({
  sessionId,
  projectId,
}: {
  sessionId?: string;
  projectId?: string;
}) {
  const navigation =
    useNavigation<
      NativeStackNavigationProp<
        { "c/[sessionId]": { sessionId: string } },
        "c/[sessionId]"
      >
    >();
  const { colors, dark, models, preferredModel, selectPreferredModel, preferences, refreshPreferences, invalidateLists } =
    useApp();
  const focused = useIsFocused();
  const chat = useSessionChat(sessionId, focused);
  const insets = useSafeAreaInsets();
  const viewport = useWindowDimensions();
  const shortViewport = viewport.width > viewport.height && viewport.height < 600;
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const { reanimated: keyboard } = useKeyboardContext();
  // Android's edge-to-edge root stays full height; use live IME insets, not a cached view frame.
  const androidKeyboardPadding = useAnimatedStyle(() => ({
    paddingBottom: Math.max(0, -keyboard.height.value),
  }));
  const reducedMotion = useReducedMotion();
  const drawerWidth = Math.min(320 + insets.left, viewport.width * 0.84);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerDisplayed, setDrawerDisplayed] = useState(false);
  const drawerNavigation = useDrawerNavigation(drawerOpen, sessionId);
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("");
  const [computerDraft, setComputerDraft] = useState(Boolean(projectId));
  const [computerOperation, setComputerOperation] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0, width: 44, height: 44 });
  const [renaming, setRenaming] = useState(false);
  const [editingQueue, setEditingQueue] = useState<PendingRun | null>(null);
  const [queueText, setQueueText] = useState("");
  const [queueOperation, setQueueOperation] = useState<number | null>(null);
  const [refreshOperation, setRefreshOperation] = useState<number | null>(null);
  const refreshOwner = useRef<number | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [composerGeneration, setComposerGeneration] = useState(0);
  const instructions = useRunInstructions(`${sessionId ?? "new"}:${composerGeneration}`, sessionId, chat.run, focused);
  const [composerHeight, setComposerHeight] = useState(146);
  const [bodyHeight, setBodyHeight] = useState(0);
  const composerScroll = useRef<ScrollView>(null);
  const composerScrollSize = useRef({ viewport: 0, content: 0 });
  const revealComposerEnd = useCallback(() => {
    const size = composerScrollSize.current;
    if (shortViewport && size.viewport > 0 && size.content > size.viewport) {
      composerScroll.current?.scrollToEnd({ animated: false });
    }
  }, [shortViewport]);
  const geometry = anchorGeometryKey(viewport.width, insets);
  const menuGeometry = useRef(geometry);
  menuGeometry.current = geometry;
  useEffect(() => { setMenu(false); }, [geometry]);
  const shift = useRef(new Animated.Value(0)).current;
  const menuRef = useRef<View>(null);
  const mountedSession = useRef("");
  const actionEpoch = useRef(0);
  const actionSession = useRef(sessionId);
  if (actionSession.current !== sessionId) {
    actionSession.current = sessionId;
    actionEpoch.current += 1;
  }
  const computerBusy = computerOperation === actionEpoch.current;
  const queueBusy = queueOperation === actionEpoch.current;
  const refreshEpoch = actionEpoch.current;
  const refreshChat = useCallback(() => {
    if (!sessionId || actionSession.current !== sessionId || actionEpoch.current !== refreshEpoch) return;
    const owner = refreshEpoch;
    if (refreshOwner.current === owner) return;
    refreshOwner.current = owner;
    setError("");
    setRefreshOperation(owner);
    void chat.refresh().catch((reason) => {
      if (actionEpoch.current === owner) setError(reason instanceof Error ? reason.message : "刷新失败");
    }).finally(() => {
      if (refreshOwner.current === owner) refreshOwner.current = null;
      setRefreshOperation((current) => current === owner ? null : current);
    });
  }, [chat.refresh, sessionId, refreshEpoch]);
  const drawerState = useRef(drawerOpen);
  drawerState.current = drawerOpen;
  const mainSurface = useMemo(() => {
    const range = { inputRange: [0, drawerWidth], extrapolate: "clamp" as const };
    return {
      background: shift.interpolate({
        ...range,
        outputRange: dark ? ["#000000", "#151515"] : ["#ffffff", "#ffffff"],
      }),
      radius: shift.interpolate({ ...range, outputRange: [0, 40] }),
      border: shift.interpolate({
        ...range,
        outputRange: dark ? ["#ffffff00", "#ffffff12"] : ["#00000000", "#0000000c"],
      }),
      shadow: shift.interpolate({ ...range, outputRange: [0, dark ? 0.28 : 0.14] }),
      elevation: shift.interpolate({ ...range, outputRange: [0, 8] }),
    };
  }, [dark, drawerWidth, shift]);
  function openDrawer() {
    if (!drawerNavigation.canHandleInput()) return;
    setDrawerDisplayed(true);
    setDrawerOpen(true);
  }
  function newChat() {
    actionEpoch.current += 1;
    setComposerGeneration((current) => current + 1);
    setMenu(false);
    setDrawerOpen(false);
    setEditingMessage(null);
    setEditingQueue(null);
    setRenaming(false);
    setError("");
    setComputerOperation(null);
    setQueueOperation(null);
    setQueueText("");
    mountedSession.current = "";
    const selected = preferredModel;
    setModelId(selected?.id ?? "");
    setEffort(selected?.default_effort ?? "");
    navigation.setParams({ sessionId: "new" });
  }
  function requestNewChat() {
    if (drawerNavigation.canHandleInput()) newChat();
  }
  const active = isActiveStatus(chat.run?.status);
  const model = models.find((item) => item.id === modelId);
  useEffect(() => setEditingMessage(null), [sessionId]);
  useEffect(() => {
    if (
      sessionId &&
      chat.session?.id === sessionId &&
      mountedSession.current !== chat.session.id
    ) {
      mountedSession.current = chat.session.id;
      const selected =
        models.find((item) => item.id === chat.session?.model_id) ??
        preferredModel;
      setModelId(selected?.id ?? "");
      setEffort(chat.session.effort ?? selected?.default_effort ?? "");
    } else if (!sessionId && preferredModel && !models.some((item) => item.id === modelId)) {
      setModelId(preferredModel.id);
      setEffort(preferredModel.default_effort ?? "");
    }
  }, [chat.session, models, preferredModel, sessionId, modelId]);
  useEffect(() => {
    if (!sessionId)
      setComputerDraft(
        projectId ? true : (preferences?.computer_default ?? false),
      );
  }, [preferences?.computer_default, projectId, sessionId]);
  useEffect(() => {
    const animation = Animated.timing(shift, {
      toValue: drawerOpen ? drawerWidth : 0,
      duration: reducedMotion ? 0 : 220,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !drawerState.current) setDrawerDisplayed(false);
    });
    return () => animation.stop();
  }, [drawerOpen, drawerWidth, reducedMotion, shift]);
  useEffect(() => {
    if (!drawerOpen || !focused) return;
    Keyboard.dismiss();
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!navigation.isFocused()) return false;
      if (drawerNavigation.canHandleInput()) setDrawerOpen(false);
      return true;
    });
    return () => back.remove();
  }, [drawerOpen, focused, navigation, drawerNavigation.canHandleInput]);
  const gesture = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (event, value) =>
        drawerNavigation.canHandleInput() &&
        Math.abs(value.dx) > 25 &&
        Math.abs(value.dy) < 20 &&
        (drawerState.current
          ? value.dx < -35
          : value.dx > 25 && event.nativeEvent.pageX - value.dx < 22),
      onPanResponderRelease: (_, value) => {
        if (!drawerNavigation.canHandleInput()) return;
        if (value.dx > 55) openDrawer();
        else if (drawerState.current && value.dx < -45) setDrawerOpen(false);
      },
    }),
  ).current;
  const submit = useCallback(
    async ({ text, files, options }: ComposerSubmission) => {
      const owner = actionEpoch.current;
      let acceptedCreated = false;
      setError("");
      try {
        if (sessionId) {
          await chat.send(text, {
            ...options,
            attachments: files,
            ...(editingMessage ? { edit_message_id: editingMessage.id } : {}),
          });
          if (owner !== actionEpoch.current) return false;
          setEditingMessage((current) =>
            current?.id === editingMessage?.id ? null : current,
          );
          return true;
        } else {
          const session = await api.createSession(
            modelId,
            effort,
            projectId,
            computerDraft,
          );
          if (owner !== actionEpoch.current) return false;
          try {
            const snapshot = await api.startRun(session.id, text, options);
            if (
              owner === actionEpoch.current &&
              chat.acceptCreated(session, snapshot, {
                content: text,
                attachments: files,
              })
            ) {
              acceptedCreated = true;
              navigation.setParams({ sessionId: session.id });
              invalidateLists();
              return true;
            }
            return false;
          } catch (reason) {
            if (
              owner === actionEpoch.current &&
              chat.acceptCreated(session, null, {
                content: text,
                attachments: files,
              })
            ) {
              acceptedCreated = true;
              setError(reason instanceof Error ? reason.message : "发送失败");
              navigation.setParams({ sessionId: session.id });
            }
            throw reason;
          }
        }
      } catch (reason) {
        if (acceptedCreated || owner === actionEpoch.current) throw reason;
        return false;
      }
    },
    [
      sessionId,
      chat.send,
      chat.acceptCreated,
      modelId,
      effort,
      projectId,
      computerDraft,
      invalidateLists,
      navigation,
      editingMessage,
    ],
  );
  async function setComputer(enabled: boolean) {
    if (computerBusy) return;
    const owner = actionEpoch.current;
    setComputerOperation(owner);
    setError("");
    try {
      if (sessionId)
        await chat.updateSession({
          computer_enabled: enabled,
          remember_computer_default:
            !chat.session?.project_id &&
            !(
              !chat.session?.computer_enabled &&
              active &&
              chat.run?.computer_granted
            ),
        });
      else {
        setComputerDraft(enabled);
        if (!projectId) {
          await api.updatePreferences({ computer_default: enabled });
          await refreshPreferences();
        }
      }
    } catch (reason) {
      if (owner === actionEpoch.current)
        setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      if (owner === actionEpoch.current) setComputerOperation(null);
    }
  }
  async function retry(message: Message) {
    const source =
      chat.messages.find(
        (item) => item.role === "user" && item.run_id === message.run_id,
      ) ?? [...chat.messages].reverse().find((item) => item.role === "user");
    if (!source) throw new Error("找不到原始消息");
    await chat.send(source.content, {
      model_id: modelId,
      effort,
      retry_run_id: message.run_id,
    });
  }
  function deleteChat() {
    const owner = actionEpoch.current;
    setMenu(false);
    Alert.alert("删除对话？", chat.session?.title, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: () => {
          if (sessionId)
            void api
              .deleteSession(sessionId)
              .then(() => {
                invalidateLists();
                if (owner === actionEpoch.current) router.replace("/");
              })
              .catch((reason) => {
                if (owner === actionEpoch.current)
                  setError(reason instanceof Error ? reason.message : "删除失败");
              });
        },
      },
    ]);
  }
  const computerOn = sessionId
    ? Boolean(
        chat.session?.computer_enabled ||
          (active && chat.run?.computer_granted),
      )
    : computerDraft;
  const composer = (
    <View
      onLayout={(event) => {
        const height = Math.ceil(event.nativeEvent.layout.height);
        setComposerHeight((current) => current === height ? current : height);
      }}
      style={[
        styles.composerArea,
        { maxHeight: bodyHeight || undefined },
      ]}
    >
      <ScrollView
        ref={composerScroll}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ paddingBottom: keyboardVisible ? 6 : Math.max(insets.bottom, 8) }}
        keyboardShouldPersistTaps="always"
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        onLayout={(event) => {
          const height = Math.round(event.nativeEvent.layout.height);
          if (composerScrollSize.current.viewport === height) return;
          composerScrollSize.current.viewport = height;
          revealComposerEnd();
        }}
        onContentSizeChange={(_width, height) => {
          const content = Math.ceil(height);
          if (composerScrollSize.current.content === content) return;
          composerScrollSize.current.content = content;
          revealComposerEnd();
        }}
      >
      {chat.reconnecting && (
        <AppText
          muted
          size={12}
          style={{ textAlign: "center", paddingVertical: 4 }}
        >
          重新连接中
        </AppText>
      )}
      {chat.pending.length > 0 && (
        <ScrollView
          horizontal
          style={styles.queue}
          showsHorizontalScrollIndicator={false}
        >
          {chat.pending.map((item, index) => (
            <View
              key={item.run_id}
              style={[
                styles.queueItem,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ]}
            >
              <Clock3 size={14} color={colors.muted} />
              <Pressable
                style={{ maxWidth: 190 }}
                onPress={() => {
                  setEditingQueue(item);
                  setQueueText(item.message);
                }}
              >
                <AppText size={12} numberOfLines={1}>
                  {index + 1}. {item.message}
                </AppText>
              </Pressable>
              <ActionIcon
                icon={X}
                size={14}
                label="取消排队消息"
                style={{ width: 28, height: 30 }}
                onPress={() =>
                  void chat
                    .cancelQueued(item.run_id)
                    .catch((reason) =>
                      setError(
                        reason instanceof Error ? reason.message : "操作失败",
                      ),
                    )
                }
              />
            </View>
          ))}
        </ScrollView>
      )}
      <RunInstructionStatus items={instructions.items} error={instructions.error} syncError={instructions.syncError}
        retryPending={instructions.retryPending} submitting={instructions.submitting} onRetry={instructions.retry} onRefresh={instructions.refresh} />
      <Composer
        key={composerGeneration}
        freshDraft={composerGeneration > 0}
        draftKey={sessionId ?? `new-${projectId ?? "chat"}`}
        models={models}
        modelId={modelId}
        effort={effort}
        onModel={(id) => {
          setModelId(id);
          setEffort(
            models.find((item) => item.id === id)?.default_effort ?? "",
          );
          void selectPreferredModel(id).catch((reason) =>
            setError(reason instanceof Error ? reason.message : "记住模型失败"),
          );
        }}
        onEffort={setEffort}
        computerEnabled={computerOn}
        computerBusy={computerBusy}
        onComputer={(enabled) => void setComputer(enabled)}
        running={active}
        stopping={chat.run?.status === "cancelling"}
        unavailable={chat.loading || chat.posting}
        onStop={() =>
          void chat
            .stop()
            .catch((reason) =>
              setError(reason instanceof Error ? reason.message : "停止失败"),
            )
        }
        onSubmit={submit}
        onSupplement={instructions.canSend && !editingMessage ? instructions.send : undefined}
        supplementBusy={instructions.submitting}
        supplementAccepted={instructions.accepted}
        editingMessage={editingMessage}
        onCancelEdit={() => setEditingMessage(null)}
        availableHeight={bodyHeight ? Math.max(0, bodyHeight - 20 - (chat.pending.length ? 40 : 0) - (instructions.items.length || instructions.error || instructions.syncError ? 36 : 0)) : undefined}
      />
      </ScrollView>
    </View>
  );
  return (
    <View
      style={[styles.root, { backgroundColor: dark ? "#000000" : "#fafafa" }]}
      {...gesture.panHandlers}
    >
      <View
        collapsable={false}
        style={[styles.drawer, { width: drawerWidth }]}
        pointerEvents={drawerOpen ? "auto" : "none"}
        accessibilityElementsHidden={!drawerOpen}
        importantForAccessibility={drawerOpen ? "auto" : "no-hide-descendants"}
      >
        {drawerDisplayed && (
          <SessionDrawer
            open={drawerOpen}
            canAct={drawerNavigation.canAct}
            onNavigate={drawerNavigation.pushDestination}
            onSelectSession={(id) => {
              if (drawerNavigation.selectSession(id)) setDrawerOpen(false);
            }}
            onNewChat={() => {
              if (drawerNavigation.canAct()) newChat();
            }}
            onDeletedSession={(id) => {
              if (actionSession.current === id) newChat();
            }}
            activeId={sessionId}
          />
        )}
      </View>
      <View
        collapsable={false}
        pointerEvents="box-none"
        accessibilityElementsHidden={drawerOpen}
        importantForAccessibility={drawerOpen ? "no-hide-descendants" : "auto"}
        style={{ flex: 1 }}
      >
        <Animated.View
          collapsable={false}
          style={[
            styles.mainFrame,
            {
              backgroundColor: mainSurface.background,
              transform: [{ translateX: shift }],
              borderRadius: mainSurface.radius,
              shadowOpacity: mainSurface.shadow,
              elevation: mainSurface.elevation,
            },
          ]}
        >
          <Animated.View
            style={[
              styles.main,
              {
                backgroundColor: mainSurface.background,
                borderRadius: mainSurface.radius,
                borderColor: mainSurface.border,
              },
            ]}
          >
            <View style={[styles.header, { paddingTop: insets.top + 3, paddingLeft: insets.left + 12, paddingRight: insets.right + 12 }, shortViewport && { paddingBottom: 4 }]}>
              <HeaderGlassAction
                icon={Menu}
                label="打开侧栏"
                color={colors.text}
                onPress={openDrawer}
              />
              <AppText
                weight="medium"
                size={sessionId ? 15 : 23}
                numberOfLines={1}
                style={styles.title}
              >
                {sessionId ? (chat.session?.title ?? "") : brand.displayName}
              </AppText>
              {sessionId ? (
                <GlassSurface interactive style={styles.headerActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="新对话"
                    onPress={requestNewChat}
                    style={styles.headerAction}
                  >
                    <SquarePen size={21} color={colors.text} strokeWidth={1.8} />
                  </Pressable>
                  <View ref={menuRef} collapsable={false}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="对话选项"
                      onPress={() => {
                        const measuredGeometry = menuGeometry.current;
                        menuRef.current?.measureInWindow((x, y, width, height) => {
                          if (measuredGeometry !== menuGeometry.current) return;
                          setAnchor({ x, y, width, height });
                          setMenu(true);
                        });
                      }}
                      style={styles.headerAction}
                    >
                      <MoreHorizontal size={21} color={colors.text} strokeWidth={1.8} />
                    </Pressable>
                  </View>
                </GlassSurface>
              ) : (
                <HeaderGlassAction
                  icon={SquarePen}
                  label="新对话"
                  color={colors.text}
                  onPress={requestNewChat}
                />
              )}
            </View>
            <ErrorNotice
              error={error || chat.error}
              retry={
                sessionId
                  ? () => void chat.refresh().catch(() => undefined)
                  : undefined
              }
            />
            <KeyboardArea
              {...(Platform.OS === "android" ? {} : { behavior: "padding" as const, automaticOffset: true })}
              style={[{ flex: 1 }, Platform.OS === "android" && androidKeyboardPadding]}
            >
              <View style={{ flex: 1, minHeight: 0, paddingLeft: insets.left, paddingRight: insets.right }} onLayout={(event) => {
                const height = Math.round(event.nativeEvent.layout.height);
                setBodyHeight((current) => current === height ? current : height);
              }}>
              <BlurScene overlay={composer}>
                {chat.loading ? (
                  <LoadingState />
                ) : sessionId ? (
                  <ChatMessages
                    messages={chat.messages}
                    run={chat.run}
                    hasOlder={chat.hasOlder}
                    loadingOlder={chat.loadingOlder}
                    loadOlder={chat.loadOlder}
                    refreshing={refreshOperation === actionEpoch.current}
                    onRefresh={refreshChat}
                    resume={chat.resume}
                    onRetry={retry}
                    onEdit={setEditingMessage}
                    bottomInset={composerHeight + 20}
                  />
                ) : (
                  <View style={[styles.home, { paddingBottom: composerHeight }]}>
                    <AppText
                      size={48}
                      weight="medium"
                      style={{ color: colors.hover, letterSpacing: -2 }}
                    >
                      {brand.displayName}
                    </AppText>
                  </View>
                )}
              </BlurScene>
              </View>
            </KeyboardArea>
            {!keyboardVisible && insets.bottom > 0 && (
              <Animated.View
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: insets.bottom,
                  backgroundColor: mainSurface.background,
                }}
              />
            )}
            {drawerOpen && (
              <Pressable
                style={StyleSheet.absoluteFill}
                accessibilityLabel="关闭侧栏"
                onPress={() => {
                  if (drawerNavigation.canHandleInput()) setDrawerOpen(false);
                }}
              />
            )}
          </Animated.View>
        </Animated.View>
      </View>
      <AnchoredMenu
        visible={menu}
        onClose={() => setMenu(false)}
        anchor={anchor}
        items={[
          {
            key: "rename",
            title: "重命名",
            icon: Pencil,
            onPress: () => setRenaming(true),
          },
          {
            key: "delete",
            title: "删除",
            icon: Trash2,
            danger: true,
            separatorBefore: true,
            onPress: deleteChat,
          },
        ]}
        width={210}
      />
      <SessionTitleDialog
        visible={renaming}
        title={chat.session?.title ?? ""}
        onClose={() => setRenaming(false)}
        onSave={async (title: string) => {
          await chat.updateSession({ title });
        }}
      />
      <Sheet
        visible={Boolean(editingQueue)}
        title="编辑排队消息"
        onClose={() => setEditingQueue(null)}
        height={350}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 18 }}>
          <Field
            label="消息"
            value={queueText}
            onChangeText={setQueueText}
            multiline
          />
          <Button
            busy={queueBusy}
            disabled={!queueText.trim()}
            onPress={() => {
              if (!editingQueue) return;
              const owner = actionEpoch.current;
              setQueueOperation(owner);
              void chat
                .updateQueued(editingQueue.run_id, queueText)
                .then(() => {
                  if (owner === actionEpoch.current) setEditingQueue(null);
                })
                .catch((reason) => {
                  if (owner === actionEpoch.current) setError(
                    reason instanceof Error ? reason.message : "保存失败",
                  );
                })
                .finally(() => {
                  if (owner === actionEpoch.current) setQueueOperation(null);
                });
            }}
          >
            保存
          </Button>
        </ScrollView>
      </Sheet>
    </View>
  );
}

// Use UIKit glass here: SwiftUI Button AX frames can retain the drawer offset after Settings returns.
function HeaderGlassAction({
  icon: Icon,
  label,
  color,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <GlassSurface interactive style={styles.headerSingleAction}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={styles.headerAction}
      >
        <Icon size={22} color={color} strokeWidth={1.8} />
      </Pressable>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: "hidden" },
  drawer: { position: "absolute", left: 0, top: 0, bottom: 0 },
  mainFrame: {
    flex: 1,
    shadowColor: "#000000",
    shadowOffset: { width: -4, height: 0 },
    shadowRadius: 14,
  },
  main: { flex: 1, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 10,
  },
  title: { flex: 1 },
  headerSingleAction: { width: 44, height: 44, borderRadius: 22 },
  headerActions: { flexDirection: "row", height: 44, borderRadius: 22 },
  headerAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  home: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingBottom: 75,
  },
  composerArea: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingTop: 6,
  },
  queue: { maxHeight: 40, marginHorizontal: 12, marginBottom: 4 },
  queueItem: {
    flexDirection: "row",
    gap: 7,
    alignItems: "center",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 10,
    marginRight: 8,
  },
});
