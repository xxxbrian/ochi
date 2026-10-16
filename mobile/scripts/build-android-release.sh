#!/usr/bin/env bash
set -euo pipefail

mobile_root="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-check}"
case "$mode" in
  check) task=":app:assembleRelease"; extra=(--dry-run) ;;
  apk) task=":app:assembleRelease"; extra=() ;;
  aab) task=":app:bundleRelease"; extra=() ;;
  *) echo "Usage: $0 [check|apk|aab]" >&2; exit 2 ;;
esac
if [[ $# -gt 1 ]]; then
  echo "Signing credentials belong in explicit environment variables or user Gradle properties, not command-line arguments." >&2
  exit 2
fi

if [[ -z "${JAVA_HOME:-}" ]]; then
  if [[ -x "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java" ]]; then
    export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  elif [[ -x /usr/libexec/java_home ]]; then
    export JAVA_HOME="$(/usr/libexec/java_home 2>/dev/null || true)"
  fi
fi
if [[ -z "${JAVA_HOME:-}" || ! -x "$JAVA_HOME/bin/java" ]]; then
  echo "Set JAVA_HOME to a working JDK (the Android Studio bundled JBR is supported)." >&2
  exit 1
fi
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [[ ! -d "$ANDROID_HOME/platforms" ]]; then
  echo "Set ANDROID_HOME to an installed Android SDK." >&2
  exit 1
fi

# Device distribution excludes emulator ABIs; QA-only builds pass an explicit override.
architectures="${OCHI_ANDROID_ARCHITECTURES:-arm64-v8a,armeabi-v7a}"
export EXPO_NO_DOTENV=1
cd "$mobile_root/android"
exec ./gradlew "$task" "-PreactNativeArchitectures=$architectures" --no-configuration-cache --console=plain "${extra[@]}"
