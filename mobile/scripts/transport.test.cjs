const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('iOS accepts user-supplied HTTP origins in the owned native project', () => {
  const plist = read('ios/Ochi/Info.plist');
  assert.match(plist, /<key>NSAllowsArbitraryLoads<\/key>\s*<true\/>/);
  // Finer ATS exceptions override the arbitrary-loads setting, even when false.
  for (const key of ['NSAllowsLocalNetworking', 'NSAllowsArbitraryLoadsForMedia', 'NSAllowsArbitraryLoadsInWebContent']) {
    assert.doesNotMatch(plist, new RegExp(`<key>${key}</key>`));
  }
});

test('Android release and Expo config allow self-hosted cleartext traffic', () => {
  assert.match(read('android/app/src/main/AndroidManifest.xml'), /android:usesCleartextTraffic="true"/);
  const config = read('app.config.ts');
  assert.match(config, /NSAppTransportSecurity:\s*\{\s*NSAllowsArbitraryLoads:\s*true\s*\}/);
  assert.match(config, /usesCleartextTraffic:\s*true/);
});

test('release build numbers remain aligned across Expo and native sources', () => {
  const config = read('app.config.ts');
  const build = config.match(/buildNumber:\s*'(\d+)'/)[1];
  assert.equal(config.match(/versionCode:\s*(\d+)/)[1], build);
  assert.equal(read('ios/Ochi/Info.plist').match(/<key>CFBundleVersion<\/key>\s*<string>(\d+)<\/string>/)[1], build);
  const xcodeBuilds = [...read('ios/Ochi.xcodeproj/project.pbxproj').matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)];
  assert.equal(xcodeBuilds.length, 2);
  for (const match of xcodeBuilds) assert.equal(match[1], build);
  assert.equal(read('android/app/build.gradle').match(/versionCode (\d+)/)[1], build);
});
