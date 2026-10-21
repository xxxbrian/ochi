import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PropsWithChildren } from 'react';
import { Appearance, AppState, useColorScheme } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as SystemUI from 'expo-system-ui';
import { api, clearCredentials, getAPIBaseURL, restoreCredentials, setAPIBaseURL, setUnauthorizedHandler } from '../lib/api';
import { createSessionListCache, type SessionListCache } from '../lib/sessionList';
import { fonts, themeColors, type Colors, type ThemePreference } from '../lib/theme';
import type { Model, User, UserPreferences } from '../lib/types';
import { preferredChatModel } from '../../../web/src/lib/modelSelection';

type AppContextValue = {
  user: User | null;
  authReady: boolean;
  loading: boolean;
  authError: string;
  theme: ThemePreference;
  dark: boolean;
  colors: Colors;
  fonts: typeof fonts;
  models: Model[];
  preferredModel: Model | undefined;
  selectPreferredModel: (id: string) => Promise<void>;
  preferences: UserPreferences | null;
  invalidateVersion: number;
  setTheme: (value: ThemePreference) => void;
  refreshCatalog: () => Promise<void>;
  refreshPreferences: () => Promise<void>;
  invalidateLists: () => void;
  signIn: (username: string, password: string, serverURL?: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const Context = createContext<AppContextValue | null>(null);
const ThemeContext = createContext<Pick<AppContextValue, 'colors' | 'fonts' | 'dark' | 'theme' | 'setTheme'> | null>(null);
const SessionListContext = createContext<SessionListCache | null>(null);
const THEME_KEY = 'ochi.theme.v1';

export function AppProvider({ children }: PropsWithChildren) {
  const systemTheme = useColorScheme();
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState('');
  const [loading, setLoading] = useState(false);
  const [theme, updateTheme] = useState<ThemePreference>('system');
  const [models, setModels] = useState<Model[]>([]);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const preferenceOwner = useRef<object | null>(null);
  const preferenceRevision = useRef(0);
  const preferenceWrites = useRef(Promise.resolve());
  const confirmedModel = useRef('');
  const [invalidateVersion, setVersion] = useState(0);
  const refreshedVersion = useRef(invalidateVersion);
  const dark = theme === 'system' ? systemTheme === 'dark' : theme === 'dark';
  const colors = useMemo(() => themeColors(dark), [dark]);
  const sessionOwner = user ? `${getAPIBaseURL()}\0${user.id}` : '';
  const sessionList = useMemo(() => createSessionListCache((signal) => api.sessionsPage({ limit: 40 }, signal)), [sessionOwner]);

  const refreshCatalog = useCallback(async () => {
    const owner = preferenceOwner.current;
    const available = await api.models();
    if (owner && preferenceOwner.current === owner) setModels(available);
  }, []);
  const refreshPreferences = useCallback(async () => {
    const owner = preferenceOwner.current;
    await preferenceWrites.current.catch(() => undefined);
    if (!owner || preferenceOwner.current !== owner) return;
    const revision = preferenceRevision.current;
    const value = await api.preferences();
    if (owner && preferenceOwner.current === owner && preferenceRevision.current === revision) {
      confirmedModel.current = value.preferred_model_id;
      setPreferences(value);
    }
  }, []);
  const preferredModel = preferences ? preferredChatModel(models, preferences.preferred_model_id) : undefined;
  const selectPreferredModel = useCallback(async (id: string) => {
    const owner = preferenceOwner.current;
    if (!owner || !models.some((model) => model.id === id)) throw new Error('请选择可用的模型');
    const revision = ++preferenceRevision.current;
    setPreferences((current) => current ? { ...current, preferred_model_id: id } : current);
    // Serialize rapid selections so the server cannot finish an older choice last.
    const write = preferenceWrites.current.catch(() => undefined).then(async () => {
      if (preferenceOwner.current !== owner) return;
      const value = await api.updatePreferences({ preferred_model_id: id });
      if (preferenceOwner.current !== owner) return;
      confirmedModel.current = value.preferred_model_id;
      if (preferenceRevision.current === revision) {
        setPreferences((current) => current ? { ...current, preferred_model_id: value.preferred_model_id } : current);
      }
    });
    preferenceWrites.current = write;
    try { await write; }
    catch (reason) {
      if (preferenceOwner.current === owner && preferenceRevision.current === revision) {
        setPreferences((current) => current ? { ...current, preferred_model_id: confirmedModel.current } : current);
      }
      throw reason;
    }
  }, [models]);
  const invalidateLists = useCallback(() => { setVersion((value) => value + 1); }, []);
  const setTheme = useCallback((value: ThemePreference) => {
    updateTheme(value);
    void SecureStore.setItemAsync(THEME_KEY, value).catch(() => undefined);
  }, []);

  useEffect(() => {
    let disposed = false;
    setUnauthorizedHandler(() => {
      if (disposed) return;
      preferenceOwner.current = null;
      setUser(null); setModels([]); setPreferences(null);
      void clearCredentials();
    });
    void (async () => {
      try {
        const savedTheme = await SecureStore.getItemAsync(THEME_KEY);
        if (!disposed && ['system', 'light', 'dark'].includes(savedTheme ?? '')) updateTheme(savedTheme as ThemePreference);
        if (await restoreCredentials()) {
          const current = await api.me();
          if (disposed) return;
          preferenceOwner.current = {};
          setUser(current);
          await Promise.all([refreshCatalog(), refreshPreferences()]);
        }
      } catch (reason) {
        if (!disposed && !(reason instanceof Error && 'status' in reason && reason.status === 401)) setAuthError(reason instanceof Error ? reason.message : '暂时无法连接');
      } finally {
        if (!disposed) setAuthReady(true);
      }
    })();
    return () => { disposed = true; setUnauthorizedHandler(undefined); };
  }, [refreshCatalog, refreshPreferences]);

  // System menus use the window's native traits, not only React theme tokens.
  useEffect(() => { Appearance.setColorScheme(theme === 'system' ? 'unspecified' : theme); }, [theme]);
  useEffect(() => { void SystemUI.setBackgroundColorAsync(colors.canvas); }, [colors.canvas]);
  useEffect(() => {
    if (!user) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        invalidateLists();
        void Promise.all([refreshCatalog(), refreshPreferences()]).catch(() => undefined);
      }
    });
    return () => sub.remove();
  }, [user, refreshCatalog, refreshPreferences, invalidateLists]);

  useEffect(() => {
    if (!sessionOwner) return;
    const foreground = () => AppState.currentState === 'active' || AppState.currentState === null;
    if (foreground()) void sessionList.refresh();
    const timer = setInterval(() => {
      if (foreground()) void sessionList.refresh();
    }, 5000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void sessionList.refresh();
      else sessionList.cancel();
    });
    return () => { clearInterval(timer); sub.remove(); sessionList.cancel(); };
  }, [sessionOwner, sessionList]);
  useEffect(() => {
    const changed = refreshedVersion.current !== invalidateVersion;
    refreshedVersion.current = invalidateVersion;
    if (changed && sessionOwner && (AppState.currentState === 'active' || AppState.currentState === null)) {
      // A command can invalidate an already in-flight list; don't reuse its pre-command response.
      sessionList.cancel();
      void sessionList.refresh();
    }
  }, [invalidateVersion, sessionOwner, sessionList]);

  const signIn = useCallback(async (username: string, password: string, serverURL?: string) => {
    setLoading(true); setAuthError('');
    preferenceOwner.current = null;
    setUser(null); setModels([]); setPreferences(null);
    try {
      if (serverURL) await setAPIBaseURL(serverURL);
      const current = await api.login(username, password);
      preferenceOwner.current = {};
      preferenceWrites.current = Promise.resolve();
      confirmedModel.current = '';
      setUser(current);
      await Promise.all([refreshCatalog(), refreshPreferences()]);
      invalidateLists();
    } finally { setLoading(false); }
  }, [refreshCatalog, refreshPreferences, invalidateLists]);

  const signOut = useCallback(async () => {
    preferenceOwner.current = null;
    try { await api.logout(); }
    finally {
      await clearCredentials();
      setUser(null); setModels([]); setPreferences(null); invalidateLists();
    }
  }, [invalidateLists]);

  const value = useMemo(() => ({ user, authReady, loading, authError, theme, dark, colors, fonts, models, preferredModel, selectPreferredModel, preferences,
    invalidateVersion, setTheme, refreshCatalog, refreshPreferences, invalidateLists, signIn, signOut,
  }), [user, authReady, loading, authError, theme, dark, colors, models, preferredModel, selectPreferredModel, preferences, invalidateVersion, setTheme, refreshCatalog, refreshPreferences, invalidateLists, signIn, signOut]);

  const themeValue = useMemo(() => ({ colors, fonts, dark, theme, setTheme }), [colors, dark, theme, setTheme]);
  return <Context.Provider value={value}><ThemeContext.Provider value={themeValue}><SessionListContext.Provider value={sessionList}>{children}</SessionListContext.Provider></ThemeContext.Provider></Context.Provider>;
}

export function useApp() {
  const value = useContext(Context);
  if (!value) throw new Error('AppProvider is missing');
  return value;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('AppProvider is missing');
  return value;
}

export function useSessionList() {
  const cache = useContext(SessionListContext);
  if (!cache) throw new Error('AppProvider is missing');
  const snapshot = useSyncExternalStore(cache.subscribe, cache.getSnapshot, cache.getSnapshot);
  return { ...snapshot, cache };
}
