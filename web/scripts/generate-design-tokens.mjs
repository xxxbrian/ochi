import { readFileSync, writeFileSync } from 'node:fs';

// Numeric tokens stay platform-neutral; only this adapter adds CSS units.
const source = new URL('../src/design/tokens.json', import.meta.url);
const output = new URL('../src/design/tokens.css', import.meta.url);
const tokens = JSON.parse(readFileSync(source, 'utf8'));
const common = {
  'font-ui': `${JSON.stringify(tokens.typography.family)}, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`,
  'font-code': `${JSON.stringify(tokens.typography.codeFamily)}, Consolas, "Liberation Mono", monospace`,
  'radius-control': 'var(--radius-field)',
  'radius-popover': 'var(--radius-dialog)',
  radius: 'var(--radius-panel)',
  'control-height': 'var(--control-normal)',
  'form-gap': 'var(--space-3)',
  accent: 'var(--ink)',
  'accent-soft': 'var(--hover)',
  paper: 'var(--sidebar)',
  surface: 'var(--canvas)',
  'surface-raised': 'var(--raised)',
  'color-muted-foreground': 'var(--muted)',
  'color-background': 'var(--canvas)',
  'color-foreground': 'var(--ink)',
  shadow: 'var(--shadow-dialog)',
  'motion-duration': `${tokens.motion.duration}ms`,
  'motion-ease': tokens.motion.ease,
};
for (const [prefix, values, unit] of [
  ['font-size', tokens.typography.size, 'px'],
  ['weight', tokens.typography.weight, ''],
  ['space', tokens.space, 'px'],
  ['radius', tokens.radius, 'px'],
  ['control', tokens.control, 'px'],
]) {
  for (const [name, value] of Object.entries(values)) {
    common[`${prefix}-${name}`] = `${value}${unit}`;
  }
}
const block = (selector, values, theme) => `${selector} {\n    color-scheme: ${theme};\n${Object.entries(values).map(([name, value]) => `    --${name}: ${value};`).join('\n')}\n}\n`;
const shadows = (theme) => Object.fromEntries(
  Object.entries(tokens.webShadow[theme]).map(([name, value]) => [`shadow-${name}`, value]),
);
const css = '/* Generated from tokens.json. Edit the source, not this file. */\n'
  + block(':root', { ...common, ...tokens.theme.light, ...shadows('light') }, 'light')
  + block(':root[data-theme="dark"]', { ...tokens.theme.dark, ...shadows('dark') }, 'dark');
// Avoid unnecessary Vite reloads when starting or checking a build.
let current;
try { current = readFileSync(output, 'utf8'); } catch { /* First generation. */ }
if (current !== css) writeFileSync(output, css);
