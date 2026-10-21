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
  ios: {
    bundleIdentifier: 'co.bojin.ochi',
    buildNumber: '10',
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
      NSLocalNetworkUsageDescription: `连接你的 ${brand.displayName} 服务。`,
      NSCameraUsageDescription: '拍摄照片并添加到对话。',
      NSPhotoLibraryUsageDescription: '选择照片并添加到对话。',
    },
  },
  android: {
    package: 'co.bojin.ochi',
    versionCode: 10,
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
    ['expo-image-picker', { cameraPermission: '拍摄照片并添加到对话。', photosPermission: '选择照片并添加到对话。', microphonePermission: false }],
    ['expo-build-properties', { ios: { enableSceneSupport: true }, android: { usesCleartextTraffic: true } }],
    './plugins/withLocalReleaseSigning.cjs',
  ],
  experiments: { typedRoutes: true },
};

export default config;
