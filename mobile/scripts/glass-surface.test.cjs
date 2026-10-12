const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const tokens = require('../../web/src/design/tokens.json');

const jsx = (type, props) => ({ type, props: props ?? {} });
const flatten = (style) => typeof style === 'function' ? flatten(style()) : Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style ?? {};
const children = (tree) => [tree.props.children].flat().filter(Boolean);

// Exercise the production material branches, not a duplicate material policy.
async function surface({ platform = 'android', dark = true, target = true, reducedTransparency = false, nativeGlass = true, colorScheme } = {}) {
  const modules = new Map(), states = [], effects = [], cleanups = [];
  const child = jsx('Content');
  let cursor = 0, effectMounted = false, tree;
  const react = {
    createContext: () => ({}), useContext: () => target ? { current: {} } : undefined,
    useRef: (value) => ({ current: value }),
    useState(initial) {
      const index = cursor++;
      if (index === states.length) states.push(initial);
      return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
    useEffect(callback) { if (!effectMounted) effects.push(callback); },
  };
  function load(relative) {
    if (modules.has(relative)) return modules.get(relative);
    const filename = path.resolve(__dirname, '..', relative);
    const source = fs.readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(output, {
      module, exports: module.exports,
      require(name) {
        if (name === 'react') return react;
        if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
        if (name === 'react-native') return {
          Platform: { OS: platform }, View: 'View',
          StyleSheet: { create: (styles) => styles, absoluteFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }, hairlineWidth: 0.5 },
          AccessibilityInfo: { isReduceTransparencyEnabled: () => Promise.resolve(reducedTransparency), addEventListener: () => ({ remove() {} }) },
        };
        if (name === 'expo-blur') return { BlurView: 'BlurView', BlurTargetView: 'BlurTargetView' };
        if (name === 'expo-glass-effect') return { GlassView: 'GlassView', isLiquidGlassAvailable: () => nativeGlass };
        if (name === 'react-native-reanimated') return { __esModule: true, default: { View: 'Animated.View' }, useAnimatedStyle: (callback) => callback, useReducedMotion: () => false, useSharedValue: (value) => ({ value }), withSpring: (value) => value };
        if (name === '../providers/AppProvider') return { useTheme: () => ({ dark, colors: load('src/lib/theme.ts').themeColors(dark) }) };
        if (name === '../lib/theme') return load('src/lib/theme.ts');
        if (name === '../../../web/src/design/tokens.json') return tokens;
        throw new Error(`Unexpected import ${name}`);
      },
    }, { filename });
    modules.set(relative, module.exports);
    return module.exports;
  }
  const GlassSurface = load('src/ui/GlassSurface.tsx').GlassSurface;
  const render = () => { cursor = 0; tree = GlassSurface({ children: child, colorScheme }); };
  render(); effectMounted = true;
  for (const effect of effects) cleanups.push(effect());
  await Promise.resolve(); render();
  for (const cleanup of cleanups) cleanup?.();
  return { tree, child };
}

test('Android dark sampled glass places a noninteractive contrast veil after blur and before undimmed content', async () => {
  for (const options of [{}, { dark: false, colorScheme: 'dark' }]) {
    const { tree, child } = await surface(options);
    const layers = children(tree);
    const blur = layers.findIndex((node) => node.type === 'BlurView');
    const veil = layers.findIndex((node) => flatten(node.props.style).backgroundColor === '#181818e0');
    assert.equal(tree.type, 'Animated.View');
    assert.ok(blur >= 0 && veil > blur && veil < layers.indexOf(child));
    assert.equal(layers[veil].props.pointerEvents, 'none');
    assert.equal(flatten(layers[veil].props.style).position, 'absolute');
    assert.equal(flatten(tree.props.style).opacity, undefined, 'material does not dim its content ancestor');
  }
});

test('light materials and native or fallback iOS glass retain their existing branches without the Android veil', async () => {
  for (const options of [{ dark: false }, { colorScheme: 'light' }, { platform: 'ios' }, { platform: 'ios', nativeGlass: false }]) {
    const { tree } = await surface(options);
    assert.equal(children(tree).some((node) => flatten(node.props.style).backgroundColor === '#181818e0'), false);
    if (options.platform === 'ios' && options.nativeGlass !== false) assert.equal(tree.type, 'GlassView');
    else assert.ok(children(tree).some((node) => node.type === 'BlurView'));
    if (!options.platform) assert.ok(children(tree).some((node) => flatten(node.props.style).backgroundColor === '#ffffff33'));
  }
});

test('missing Android blur target or reduced transparency uses the opaque raised fallback without blur or veil', async () => {
  for (const options of [{ target: false }, { reducedTransparency: true }, { platform: 'ios', reducedTransparency: true }]) {
    const { tree } = await surface(options);
    assert.equal(tree.type, 'Animated.View');
    assert.equal(flatten(tree.props.style).backgroundColor, tokens.theme.dark.raised);
    assert.equal(children(tree).some((node) => node.type === 'BlurView' || flatten(node.props.style).backgroundColor === '#181818e0'), false);
  }
});

test('Android dark foreground veil keeps real normal-size text tokens readable even over a white blur sample', async () => {
  const { tree } = await surface();
  const color = children(tree).map((node) => flatten(node.props.style).backgroundColor).find((value) => value === '#181818e0');
  const rgb = (hex) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const alpha = Number.parseInt(color.slice(7), 16) / 255;
  const background = rgb(color).map((channel) => channel * alpha + 255 * (1 - alpha));
  const luminance = (channels) => channels.map((channel) => channel / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((value, channel, index) => value + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (foreground) => (luminance(rgb(foreground)) + 0.05) / (luminance(background) + 0.05);
  assert.ok(background.every((channel) => channel < 53));
  assert.ok(contrast(tokens.theme.dark.muted) >= 4.5, '13pt menu subtitle remains readable without assuming the native dark tint works');
  assert.ok(contrast(tokens.theme.dark.ink) >= 7, 'main text keeps strong contrast');
});
