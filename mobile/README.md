# Ochi Native Client

Expo SDK 57 and React Native 0.86, built locally for iOS and Android. The client
shares domain types and design tokens with `../web`, not its DOM or CSS. Chat,
Markdown, math, navigation and interactions are native; isolated HTML artifacts,
Computer and administrator pages use WebView.

## Development

Install Node 22+, pnpm, and the native toolchain for your platform: Xcode on
macOS for iOS, or JDK 21 and Android SDK 36 for Android.

```sh
pnpm install --frozen-lockfile
pnpm ios
# Or, with a booted Android emulator or connected device:
pnpm android
```

These commands build the development client. Subsequent JS/TypeScript changes
use Fast Refresh with `pnpm start`; native dependency changes require a rebuild.
Expo Go does not contain the required native Markdown and UI modules.

Configure the service root on the sign-in screen. Development simulator defaults
are `http://127.0.0.1:8090` on iOS and `http://10.0.2.2:8090` on Android. A physical
device needs a reachable address. An optional `EXPO_PUBLIC_API_URL` is compiled
into the app; it must never contain credentials. Release builds require HTTPS.
Login tokens stay in SecureStore; provider keys stay on the server.

## Native Projects

`ios/` and `android/` are versioned native source, including the `Ochi` Xcode
scheme and the `co.bojin.ochi` application identity. Build caches, Pods, local SDK
paths and signing keys are not source. Do not regenerate or clean-prebuild these
projects as a routine fix. When intentionally applying Expo configuration,
review the native diff and keep durable plugin behavior in `plugins/`.

The checked-in Android `app/debug.keystore` is the public template debug key,
only for development installs. It must never sign a distributed Release build;
the release-signing plugin enforces a separate external identity.

`react-native-enriched-markdown` installs pinned, hash-verified RaTeX and
tree-sitter assets during its approved postinstall. Missing math or code assets
must be fixed, not silently disabled.

## Checks

```sh
pnpm typecheck
pnpm test
pnpm exec expo install --check
pnpm export:ios
pnpm export:android
```

Tests exercise state, rendering and interaction contracts. Exports and type
checking do not replace native QA: verify light/dark, both landscape directions,
keyboard/focus retention, menus, image gestures and accessibility on the built
clients. Emulator timing is not a claim about physical-device performance.

## Local Distribution

No EAS Build or Submit account is required. See [releasing](../docs/releasing.md)
for signing, export/upload and distribution prerequisites.

```sh
# Copy once, then set your team in the ignored local file.
cp release/Signing.example.xcconfig release/Signing.local.xcconfig
# Alternatively export OCHI_APPLE_TEAM_ID for local archive and Expo prebuild.
bash scripts/ios-release.sh archive
bash scripts/ios-release.sh export
bash scripts/ios-release.sh upload

# Validates external Android signing configuration without packaging.
bash scripts/build-android-release.sh check
bash scripts/build-android-release.sh apk
bash scripts/build-android-release.sh aab
```

iOS outputs default to the ignored `build/release/ochi-<version>-<build>/`.
Override `OCHI_RELEASE_DIR`, `OCHI_RELEASE_LOG_DIR` or `OCHI_IOS_DERIVED_DATA` as
needed. Android outputs remain under `android/app/build/outputs/`. Configure
`JAVA_HOME` and `ANDROID_HOME` for your machine, and keep all signing credentials
outside the checkout. Release packaging fails without the owner's signing inputs.
`OCHI_IOS_SIGNING_CONFIG` selects a different private xcconfig; an explicit
`OCHI_APPLE_TEAM_ID` takes precedence over the local file.

See [architecture](../docs/architecture.md), [design](../docs/design.md) and
[development](../docs/development.md) for current cross-platform decisions.
