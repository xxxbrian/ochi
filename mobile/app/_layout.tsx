import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Stack, useRootNavigationState, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useFonts } from 'expo-font';
import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular';
import { Geist_500Medium } from '@expo-google-fonts/geist/500Medium';
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold';
import { AppProvider, useApp } from '../src/providers/AppProvider';

void SplashScreen.preventAutoHideAsync();

function Navigation() {
  const { user, authReady, dark, colors } = useApp();
  const router = useRouter();
  const segments = useSegments();
  const navigationState = useRootNavigationState();
  useEffect(() => {
    if (!authReady || !navigationState?.key) return;
    const isLogin = segments[0] === 'login';
    if (!user && !isLogin) router.replace('/login');
    else if (user && isLogin) router.replace('/');
  }, [authReady, user, segments, router, navigationState?.key]);
  useEffect(() => { if (authReady) void SplashScreen.hideAsync(); }, [authReady]);

  if (!authReady) return <View style={[styles.root, styles.loading, { backgroundColor: colors.canvas }]}><ActivityIndicator color={colors.text} /></View>;

  return (
    <View style={[styles.root, { backgroundColor: colors.canvas }]}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas }, animation: 'slide_from_right', gestureEnabled: true }}>
        <Stack.Screen name="index" options={{ animation: 'none' }} />
        <Stack.Screen name="login" options={{ animation: 'fade' }} />
        <Stack.Screen name="c/[sessionId]" options={{ animation: 'none', gestureEnabled: false }} />
        <Stack.Screen name="settings" options={{ presentation: 'card', animation: 'slide_from_right' }} />
      </Stack>
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({ Geist_400Regular, Geist_500Medium, Geist_600SemiBold });
  if (!fontsLoaded && !fontError) return null;
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
          <AppProvider><Navigation /></AppProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
const styles = StyleSheet.create({ root: { flex: 1 }, loading: { alignItems: 'center', justifyContent: 'center' } });
