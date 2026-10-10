import branding from './brand.config.json';

// JSON also works in Expo's native-build Node config loader, without TS hooks.
export const brand = {
  displayName: branding.displayName,
} as const;
