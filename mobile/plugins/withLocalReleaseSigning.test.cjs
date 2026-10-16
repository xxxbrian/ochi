const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const signing = require('./withLocalReleaseSigning.cjs');

test('generated Gradle apply block is idempotent and follows the Expo template', () => {
  const template = 'android { buildTypes { debug { signingConfig signingConfigs.debug }; release { signingConfig signingConfigs.debug } } }\n';
  const once = signing.applyLocalReleaseSigning(template);
  assert.equal(signing.applyLocalReleaseSigning(once), once);
  assert.equal((once.match(/apply from: "\.\/ochi-release-signing\.gradle"/g) || []).length, 1);
  assert.ok(once.startsWith(template.trimEnd()));
});

test('a stale or incomplete generated block cannot silently fall back to the template', () => {
  assert.throws(() => signing.applyLocalReleaseSigning('// @generated begin ochi-local-release-signing\n'), /incomplete/);
  assert.throws(() => signing.applyLocalReleaseSigning('// @generated end ochi-local-release-signing\n'), /incomplete/);
});

test('regeneration writes identical static signing bytes, never credential values', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ochi-signing-plugin-'));
  try {
    await signing.writeSigningScript(root);
    const first = await fs.readFile(path.join(root, 'app/ochi-release-signing.gradle'), 'utf8');
    await signing.writeSigningScript(root);
    assert.equal(await fs.readFile(path.join(root, 'app/ochi-release-signing.gradle'), 'utf8'), first);
    assert.equal(first, signing.releaseSigningGradle);
    assert.doesNotMatch(first, /signingConfigs\.debug|credentials\.json|readFile|load\(/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('release graph guard has four required inputs and rejects debug or in-checkout identities', () => {
  const script = signing.releaseSigningGradle;
  for (const input of ['KEYSTORE_PATH', 'KEY_ALIAS', 'KEYSTORE_PASSWORD', 'KEY_PASSWORD']) {
    assert.match(script, new RegExp(`OCHI_ANDROID_${input}`));
  }
  assert.match(script, /gradle\.taskGraph\.whenReady/);
  assert.match(script, /task\.project == ochiAppProject/);
  assert.match(script, /assemble\|bundle\|package\|validateSigning/);
  assert.match(script, /missing\.isEmpty\(\)/);
  assert.match(script, /\.canonicalFile/);
  assert.match(script, /startsWith\(ochiCheckoutRoot\.toPath\(\)\)/);
  assert.match(script, /equalsIgnoreCase\('androiddebugkey'\)/);
  assert.match(script, /signingConfig = signingConfigs\.ochiRelease/);
  assert.match(script, /another Gradle script replaced/);
});

test('the output guard covers release/flavored distribution but not compile or lint tasks', () => {
  const requiresSigning = (name) => /^(assemble|bundle|package|validateSigning).*release$/i.test(name)
    || /^(sign|package).*releaseBundle$/i.test(name);
  for (const task of ['assembleRelease', 'bundleRelease', 'packageRelease', 'validateSigningRelease', 'signReleaseBundle', 'packageReleaseBundle', 'assembleProductionRelease']) {
    assert.equal(requiresSigning(task), true, task);
  }
  for (const task of ['assembleDebug', 'compileReleaseKotlin', 'lintVitalRelease', 'bundleReleaseClassesToCompileJar', 'tasks', 'help']) {
    assert.equal(requiresSigning(task), false, task);
  }
});

test('Release output cannot reuse a cached task graph that skips the signing guard', () => {
  const script = signing.releaseSigningGradle;
  assert.match(script, /@javax\.inject\.Inject/);
  assert.match(script, /org\.gradle\.api\.configuration\.BuildFeatures/);
  assert.match(script, /configurationCache\.active\.get\(\)/);
  assert.match(script, /if \(ochiConfigurationCacheActive\)/);
  assert.match(script, /use --no-configuration-cache/);
  assert.ok(script.indexOf('if (ochiConfigurationCacheActive)') < script.indexOf('def missing ='));
  assert.doesNotMatch(script, /startParameter\.configurationCacheRequested/);
});
