import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import {
  router,
  useIsFocused,
  useNavigation,
  type NativeStackNavigationProp,
} from "expo-router";

export function useDrawerNavigation(open: boolean, sessionId?: string) {
  const navigation =
    useNavigation<
      NativeStackNavigationProp<
        { "c/[sessionId]": { sessionId: string } },
        "c/[sessionId]"
      >
    >();
  const focused = useIsFocused();
  const [, refresh] = useState(0);
  const currentNavigation = useRef(navigation);
  currentNavigation.current = navigation;
  const lifecycle = useRef({
    mounted: true,
    open,
    sessionId,
    focused,
    epoch: 0,
    pending: null as "destination" | "session" | null,
    transitioning: false,
    appeared: true,
  });
  const state = lifecycle.current;
  if (state.open !== open || state.sessionId !== sessionId) {
    state.open = open;
    state.sessionId = sessionId;
    state.epoch += 1;
    if (!open && state.pending === "session") state.pending = null;
  }

  useLayoutEffect(() => {
    const state = lifecycle.current;
    state.mounted = true;
    let disposed = false;
    function changed() {
      state.epoch += 1;
      if (state.mounted) refresh((value) => value + 1);
    }
    function release() {
      // Native appearance and router focus can arrive in either order.
      if (state.focused && state.appeared && !state.transitioning)
        state.pending = null;
    }
    const listeners = [
      navigation.addListener("blur", () => {
        if (disposed) return;
        state.focused = false;
        state.appeared = false;
        changed();
      }),
      navigation.addListener("focus", () => {
        if (disposed) return;
        state.focused = true;
        if (Platform.OS === "web") {
          state.appeared = true;
          state.transitioning = false;
        }
        release();
        changed();
      }),
      navigation.addListener("transitionStart", () => {
        if (disposed) return;
        state.transitioning = true;
        state.appeared = false;
        changed();
      }),
      navigation.addListener("transitionEnd", (event) => {
        if (disposed) return;
        state.transitioning = false;
        state.appeared = !event.data.closing;
        release();
        changed();
      }),
      navigation.addListener("gestureCancel", () => {
        if (disposed) return;
        state.transitioning = false;
        state.appeared = navigation.isFocused();
        release();
        changed();
      }),
    ];
    refresh((value) => value + 1);
    return () => {
      disposed = true;
      state.mounted = false;
      state.epoch += 1;
      listeners.forEach((remove) => remove());
    };
  }, [navigation]);

  const canHandleInput = useCallback(() => {
    const state = lifecycle.current;
    return (
      state.mounted &&
      state.focused &&
      currentNavigation.current.isFocused() &&
      state.appeared &&
      !state.transitioning &&
      !state.pending
    );
  }, []);
  const owner = state.epoch;
  const canAct = useCallback(
    () =>
      lifecycle.current.epoch === owner &&
      lifecycle.current.open &&
      canHandleInput(),
    [owner, canHandleInput],
  );
  const pushDestination = useCallback(
    (path: string) => {
      if (!canAct()) return false;
      lifecycle.current.pending = "destination";
      try {
        // Keep the same mounted, scrolled drawer beneath every native card push.
        router.push(path as never);
        return true;
      } catch (reason) {
        lifecycle.current.pending = null;
        throw reason;
      }
    },
    [canAct],
  );
  const selectSession = useCallback(
    (id: string) => {
      if (!canAct()) return false;
      lifecycle.current.pending = "session";
      try {
        navigation.setParams({ sessionId: id });
        return true;
      } catch (reason) {
        lifecycle.current.pending = null;
        throw reason;
      }
    },
    [canAct, navigation],
  );
  return { canHandleInput, canAct, pushDestination, selectSession };
}
