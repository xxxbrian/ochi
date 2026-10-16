#!/usr/bin/env bash
set -euo pipefail

mobile="$(cd "$(dirname "$0")/.." && pwd)"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$mobile/ios/Ochi/Info.plist")"
build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$mobile/ios/Ochi/Info.plist")"
output="${OCHI_RELEASE_DIR:-$mobile/build/release/ochi-$version-$build}"
logs="${OCHI_RELEASE_LOG_DIR:-$output/logs}"
archive="$output/Ochi-$version-$build.xcarchive"
action="${1:-archive}"
mkdir -p "$output" "$logs"

# Do not embed unrelated local dotenv settings in the shipped JS bundle.
export EXPO_NO_DOTENV=1 NODE_ENV=production
signing=()
if [[ -n "${OCHI_APPLE_TEAM_ID:-}" ]]; then
  signing+=("DEVELOPMENT_TEAM=$OCHI_APPLE_TEAM_ID")
elif [[ -f "${OCHI_IOS_SIGNING_CONFIG:-$mobile/release/Signing.local.xcconfig}" ]]; then
  signing+=(-xcconfig "${OCHI_IOS_SIGNING_CONFIG:-$mobile/release/Signing.local.xcconfig}")
fi

case "$action" in
  archive)
    if [[ ${#signing[@]} -eq 0 ]]; then
      echo "Set OCHI_APPLE_TEAM_ID or prepare release/Signing.local.xcconfig (OCHI_IOS_SIGNING_CONFIG overrides its path)." >&2
      exit 1
    fi
    if [[ -e "$archive" ]]; then
      echo "Archive already exists; preserve it and increment the release build before rebuilding." >&2
      exit 1
    fi
    pnpm --dir "$mobile" typecheck
    xcodebuild archive \
      -workspace "$mobile/ios/Ochi.xcworkspace" -scheme Ochi \
      -configuration Release -destination 'generic/platform=iOS' \
      -archivePath "$archive" -derivedDataPath "${OCHI_IOS_DERIVED_DATA:-$logs/DerivedData-iphoneos}" \
      -allowProvisioningUpdates CODE_SIGN_STYLE=Automatic "${signing[@]}"
    ;;
  export|upload)
    if [[ ! -d "$archive" ]]; then
      echo "Create the signed iOS device archive first." >&2
      exit 1
    fi
    options="$logs/ExportOptions-$action.plist"
    python3 - "$mobile/release/ExportOptions.plist" "$options" "$action" <<'PY'
import os, plistlib, sys
with open(sys.argv[1], 'rb') as source:
    options = plistlib.load(source)
options['destination'] = 'upload' if sys.argv[3] == 'upload' else 'export'
if os.environ.get('OCHI_APPLE_TEAM_ID'):
    options['teamID'] = os.environ['OCHI_APPLE_TEAM_ID']
with open(sys.argv[2], 'wb') as output:
    plistlib.dump(options, output)
PY
    xcodebuild -exportArchive -archivePath "$archive" \
      -exportOptionsPlist "$options" -exportPath "$output/$action" \
      -allowProvisioningUpdates
    ;;
  *)
    echo "Usage: $0 [archive|export|upload]" >&2
    exit 2
    ;;
esac
