import type { ExpoConfig } from 'expo/config';
import brand from './brand.config.json';

const config: ExpoConfig = {
  name: brand.displayName,
  slug: 'ochi',
  version: '0.1.0',
  icon: './assets/icon.png',
  scheme: 'ochi',
  orientation: 'default',
  platforms: ['ios', 'android'],
  userInterfaceStyle: 'automatic',
  locales: {
    en: './locales/en.json',
    'zh-Hans': './locales/zh-Hans.json',
    'zh-Hant': './locales/zh-Hant.json',
  },
  ios: {
    bundleIdentifier: 'co.bojin.ochi',
    buildNumber: '13',
    appleTeamId: process.env.OCHI_APPLE_TEAM_ID,
    supportsTablet: true,
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyCollectedDataTypes: [
        'NSPrivacyCollectedDataTypeUserID',
        'NSPrivacyCollectedDataTypeOtherUserContent',
        'NSPrivacyCollectedDataTypePhotosorVideos',
      ].map((type) => ({
        NSPrivacyCollectedDataType: type,
        NSPrivacyCollectedDataTypeLinked: true,
        NSPrivacyCollectedDataTypeTracking: false,
        NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
      })),
    },
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      // Self-hosted server addresses are supplied at runtime, including HTTP origins.
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      NSLocalNetworkUsageDescription: `Connect to your ${brand.displayName} server.`,
      NSCameraUsageDescription: 'Take photos to add to a chat.',
      NSPhotoLibraryUsageDescription: 'Choose photos to add to a chat.',
    },
  },
  android: {
    package: 'co.bojin.ochi',
    versionCode: 13,
    softwareKeyboardLayoutMode: 'resize',
    permissions: ['CAMERA'],
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#313235' },
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-sharing',
    'expo-font',
    'expo-status-bar',
    'expo-splash-screen',
    ['expo-localization', {
      supportedLocales: ['en', 'zh-Hans', 'zh-Hant'],
      allowDynamicLocaleChangesAndroid: true,
    }],
    ['expo-image-picker', { cameraPermission: 'Take photos to add to a chat.', photosPermission: 'Choose photos to add to a chat.', microphonePermission: false }],
    ['expo-build-properties', { ios: { enableSceneSupport: true }, android: { usesCleartextTraffic: true } }],
    './plugins/withLocalReleaseSigning.cjs',
  ],
  experiments: { typedRoutes: true },
};

export default config;
