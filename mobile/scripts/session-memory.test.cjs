const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { create, act } = require("react-test-renderer");
const { createLoader } = require("../../shared/conversation/test-loader.cjs");
const { testI18n } = require("./helpers/i18n.cjs");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = path.resolve(__dirname, "../..");
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const primitive = new Proxy({}, { get: (_target, key) => key });

function fixture(screen = "ChatScreen") {
  const calls = { creates: [], sends: [], preferences: [], params: [] };
  const model = { id: "model", default_effort: "high" };
  const app = {
    dark: false, colors: {}, models: [model], preferredModel: model,
    preferences: { memory_enabled: true }, invalidateLists() {}, refreshPreferences: async () => {},
    selectPreferredModel: async () => {},
  };
  const chat = {
    session: null, loading: false, posting: false, pending: [], messages: [],
    instructions: { items: [], canSend: false }, updateSession: async () => {},
    createAndSend: async (text, options) => {
      calls.creates.push({ text, options });
      const session = { id: "created", memory_enabled: options.memory_enabled, model_id: "model", effort: "high" };
      chat.session = session;
      return { session };
    },
    send: async (text, options) => calls.sends.push({ text, options }),
  };
  const navigation = { setParams: (value) => calls.params.push(value) };
  class Value { interpolate() { return 0; } }
  const native = {
    ...primitive,
    ...Object.fromEntries(["View", "Pressable", "ScrollView", "FlatList", "ActivityIndicator"].map((key) => [key, key])),
    Platform: { OS: "android" }, StyleSheet: { create: (value) => value, hairlineWidth: 0.5 },
    useWindowDimensions: () => ({ width: 393, height: 852 }),
    Animated: { Value, View: "AnimatedView", timing: () => ({ start() {}, stop() {} }) },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    BackHandler: { addEventListener: () => ({ remove() {} }) }, Keyboard: { dismiss() {} },
  };
  const api = {
    updatePreferences: async (value) => calls.preferences.push(value),
    project: async () => ({ id: "project", name: "Project" }), sessionsPage: async () => ({ items: [] }),
    createSession: async (...args) => { calls.creates.push(args); return { id: "created", memory_enabled: args[4] }; },
    startRun: async (...args) => calls.sends.push(args),
  };
  const load = createLoader(require("typescript"), require, {
    "react-native": native, "lucide-react-native": primitive,
    "expo-router": { router: { push() {} }, useNavigation: () => navigation, useIsFocused: () => true },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    "react-native-keyboard-controller": {
      KeyboardAwareScrollView: "KeyboardAwareScrollView", KeyboardAvoidingView: "KeyboardAvoidingView",
      useKeyboardState: (selector) => selector({ isVisible: true }),
      useKeyboardContext: () => ({ reanimated: { height: { value: 0 } } }),
    },
    "react-native-reanimated": { __esModule: true, default: { View: "ReanimatedView" }, useAnimatedStyle: () => ({}), useReducedMotion: () => true },
    [path.join(root, "mobile/src/lib/i18n.ts")]: testI18n.native,
    [path.join(root, "mobile/src/lib/errors.ts")]: { errorForDisplay: (value) => value, localizedError: (value) => new Error(value) },
    [path.join(root, "mobile/src/lib/api.ts")]: { api, isActiveStatus: () => false },
    [path.join(root, "mobile/src/providers/AppProvider.tsx")]: { useApp: () => app },
    [path.join(root, "mobile/src/hooks/useSessionChat.ts")]: { useSessionChat: () => chat },
    [path.join(root, "mobile/src/hooks/useDrawerNavigation.ts")]: { useDrawerNavigation: () => ({ canHandleInput: () => true, canAct: () => true }) },
    [path.join(root, "mobile/src/ui/GlassSurface.tsx")]: {
      GlassSurface: "GlassSurface",
      BlurScene: ({ children, overlay }) => React.createElement(React.Fragment, {}, children, overlay),
    },
    ...Object.fromEntries(["AnchoredMenu", "Sheet", "MenuTrigger", "SessionTitleDialog"].map((name) => [
      path.join(root, `mobile/src/ui/${name}.tsx`), { [name]: name },
    ])),
    [path.join(root, "mobile/src/components/ScreenChrome.tsx")]: {
      ...primitive, AppText: "AppText", ActionIcon: "ActionIcon", ErrorNotice: "ErrorNotice", LoadingState: "LoadingState",
      PageHeader: "PageHeader", EmptyState: "EmptyState", Field: "Field", Button: "Button",
      screenStyles: {}, usePageContentStyle: () => ({}),
    },
    ...Object.fromEntries(["Composer", "RunInstructionStatus", "ChatMessages", "SessionDrawer"].map((name) => [
      path.join(root, `mobile/src/components/${name}.tsx`), { [name]: name },
    ])),
    [path.join(root, "mobile/src/components/SessionSearch.tsx")]: { SessionSearch: "SessionSearch", sessionDate: () => "" },
  });
  const module = load(path.join(root, `mobile/src/screens/${screen === "ChatScreen" ? "ChatScreen" : "ProjectsScreen"}.tsx`));
  return { Screen: module[screen], app, chat, calls, api };
}

test("native draft memory defaults on, resets for each new chat/project, and never writes account preferences", async () => {
  const f = fixture(); let tree;
  await act(async () => { tree = create(React.createElement(f.Screen)); await flush(); });
  const composer = () => tree.root.findByType("Composer").props;
  try {
    assert.equal(composer().memoryEnabled, true);
    await act(async () => composer().onMemory(false));
    assert.equal(composer().memoryEnabled, false);
    f.app.preferences.memory_enabled = false;
    await act(async () => tree.update(React.createElement(f.Screen)));
    assert.equal(composer().memoryEnabled, false);
    assert.equal(composer().memoryGloballyEnabled, false);
    await act(async () => tree.update(React.createElement(f.Screen, { projectId: "other" })));
    assert.equal(composer().memoryEnabled, true);
    await act(async () => tree.update(React.createElement(f.Screen)));
    assert.equal(composer().memoryEnabled, true);
    await act(async () => composer().onMemory(false));
    await act(async () => tree.root.findAllByType("Pressable").find((node) =>
      node.props.accessibilityLabel === testI18n.native.t("chat.new")).props.onPress());
    assert.equal(composer().memoryEnabled, true);
    assert.deepEqual(f.calls.preferences, []);
  } finally { await act(async () => tree.unmount()); }
});

test("native creation fixes the chosen memory state through adoption, editing and later sends", async () => {
  const f = fixture(); let tree;
  await act(async () => { tree = create(React.createElement(f.Screen)); await flush(); });
  const composer = () => tree.root.findByType("Composer").props;
  const submission = { text: "synthetic fixture", files: [], options: { model_id: "model", effort: "high" } };
  try {
    await act(async () => composer().onMemory(false));
    await act(async () => { await composer().onSubmit(submission); await flush(); });
    await act(async () => tree.update(React.createElement(f.Screen)));
    assert.equal(f.calls.creates[0].options.memory_enabled, false);
    assert.equal(f.calls.creates[0].options.computer_enabled, false);
    assert.equal(composer().memoryEnabled, false);
    assert.equal(composer().memoryFixed, true);
    await act(async () => tree.update(React.createElement(f.Screen, { sessionId: "created" })));
    await act(async () => composer().onMemory(true));
    assert.equal(composer().memoryEnabled, false);
    await act(async () => composer().onSubmit(submission));
    assert.ok(!Object.hasOwn(f.calls.sends[0].options, "memory_enabled"));
    assert.equal(f.calls.creates.length, 1);
    assert.deepEqual(f.calls.preferences, []);
    f.chat.session = null;
    await act(async () => tree.update(React.createElement(f.Screen)));
    assert.equal(composer().memoryEnabled, true);
    assert.equal(composer().memoryFixed, false);
  } finally { await act(async () => tree.unmount()); }
});

test("native project entry sends its own draft choice as argument five and starts the next draft on", async () => {
  const f = fixture("ProjectScreen"); let tree;
  await act(async () => { tree = create(React.createElement(f.Screen, { projectId: "project" })); await flush(); });
  const composer = () => tree.root.findByType("FlatList").props.ListHeaderComponent.props.children.find((node) => node?.type === "Composer").props;
  try {
    assert.equal(composer().memoryEnabled, true);
    await act(async () => composer().onMemory(false));
    await act(async () => composer().onSubmit({ text: "fixture", options: { model_id: "model" }, files: [] }));
    assert.deepEqual(f.calls.creates, [["model", "high", "project", true, false]]);
    assert.equal(composer().memoryEnabled, true);
    assert.ok(!Object.hasOwn(f.calls.sends[0][2], "memory_enabled"));
    assert.deepEqual(f.calls.preferences, []);
  } finally { await act(async () => tree.unmount()); }
});
