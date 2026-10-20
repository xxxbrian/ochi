# Local Native Releases

Ochi uses `co.bojin.ochi` for both the iOS Bundle ID and Android application ID.
Native source is versioned. EAS Build/Submit/Update is not required; use local
Xcode and Gradle tooling. Keep credentials and signed packages outside Git.

## iOS

Use a compatible Xcode and CocoaPods installation. The native workspace and
scheme are `mobile/ios/Ochi.xcworkspace` and `Ochi`. Sign in to the owning Apple
Developer account in Xcode, select the intended team and verify the Bundle ID.
For App Store Connect/TestFlight, create a matching App ID and app record first.

Increment the release build number and keep app config/native metadata aligned.
The default server is `https://ochi.bojin.co`; no build-time environment override
is needed. `EXPO_PUBLIC_API_URL` can explicitly select another default, and users
can enter their own HTTP or HTTPS origin through **使用自部署后端** on the login
page. No provider key or bearer token belongs in a client build.

iOS allows arbitrary loads and Android allows cleartext traffic because users
supply self-hosted origins at runtime, which cannot be enumerated at build time.
Keep the native projects and Expo config aligned. Do not add
`NSAllowsLocalNetworking` alongside `NSAllowsArbitraryLoads`: on current iOS it
overrides the latter and would break non-local HTTP servers. Explain the
user-supplied server requirement if App Review asks for an ATS justification.
HTTPS remains the default; the login page warns when an HTTP address is entered.

```sh
bash mobile/scripts/ios-release.sh archive
bash mobile/scripts/ios-release.sh export
# Explicit distribution action, not part of an ordinary build:
bash mobile/scripts/ios-release.sh upload
```

The script archives for a physical device. Export creates a distribution IPA;
upload sends the archive to App Store Connect, not directly to the public App
Store. TestFlight processing, tester groups and any required beta review follow
in App Store Connect. Export-compliance, privacy and review declarations must
describe the actual app and data processing, not a generic template.

Set `OCHI_APPLE_TEAM_ID`, or copy `mobile/release/Signing.example.xcconfig` to
the ignored `Signing.local.xcconfig` and set the team there.
`OCHI_IOS_SIGNING_CONFIG` selects another private xcconfig; the explicit team
environment variable takes precedence. An archive fails if neither is supplied.
Export otherwise derives the signing team from the archive. `OCHI_RELEASE_DIR`,
`OCHI_RELEASE_LOG_DIR` and `OCHI_IOS_DERIVED_DATA` override local output paths;
the default output is under ignored `mobile/build/release/`.

## Android

Use a compatible JDK and Android SDK; set `JAVA_HOME` and `ANDROID_HOME` when
automatic local discovery is unsuitable. Keep a stable owner-controlled release
keystore outside the checkout and privately back it up. APK updates require the
same identity; do not regenerate it for each release.

| Environment variable | User Gradle property |
| --- | --- |
| `OCHI_ANDROID_KEYSTORE_PATH` | `ochi.android.keystorePath` |
| `OCHI_ANDROID_KEY_ALIAS` | `ochi.android.keyAlias` |
| `OCHI_ANDROID_KEYSTORE_PASSWORD` | `ochi.android.keystorePassword` |
| `OCHI_ANDROID_KEY_PASSWORD` | `ochi.android.keyPassword` |

User Gradle properties take precedence. Never put passwords in command-line
arguments. Missing signing inputs stop Release packaging rather than silently
using a debug key. The versioned `mobile/android/app/debug.keystore` is only
the standard public development key and must never sign a distributable Release.

```sh
bash mobile/scripts/build-android-release.sh check
bash mobile/scripts/build-android-release.sh apk
bash mobile/scripts/build-android-release.sh aab
```

`check` is a task-graph dry run, not compilation or a signing test. Default ABIs
are `arm64-v8a,armeabi-v7a`; `OCHI_ANDROID_ARCHITECTURES` is an explicit override.
The script disables implicit dotenv loading and configuration caching for
fail-closed signing validation.

APK output is `mobile/android/app/build/outputs/apk/release/app-release.apk`;
AAB output is `mobile/android/app/build/outputs/bundle/release/app-release.aab`.
APK supports direct installation without a Play publisher account. Publishing
an AAB to Google Play requires the separate publisher setup.

## Acceptance And Recordkeeping

Archive accepted packages outside the checkout with checksums, app ID/version,
signer certificate digest and a source revision. Verify APK signatures with
`apksigner` and AAB signatures with `jarsigner`. Preserve original signing keys.
Run browser/native interaction checks against the actual candidate build; a
passing export or simulator test does not certify a physical-device release.

Do not commit archives, provisioning profiles, private keys, account credentials
or historical TestFlight status as public source documentation.
