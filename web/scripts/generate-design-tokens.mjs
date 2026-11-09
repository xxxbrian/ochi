import { readFileSync, writeFileSync } from 'node:fs';

// tokens.json is shared with native clients. The Web adapter emits the Design Lab token model:
// continuous inputs (neutral/accent hue+chroma, radius, density, font scale, speed, shadow, hairline, blur)
// from which every colour, radius, shadow and duration is derived with oklch()/calc() in CSS.
const source = new URL('../src/design/tokens.json', import.meta.url);
const output = new URL('../src/design/tokens.css', import.meta.url);
const tokens = JSON.parse(readFileSync(source, 'utf8'));
const { lab } = tokens;
const CJK = '"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei"';
const MONO = `${JSON.stringify(tokens.typography.monoFamily)}, ui-monospace, "SF Mono", ${JSON.stringify(tokens.typography.codeFamily)}, Menlo, Consolas, "Liberation Mono", monospace`;
const SANS = `${JSON.stringify(tokens.typography.family)}, ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", ${CJK}, system-ui, sans-serif`;
const px = (name) => (/^(radius|blur|thread-w|sidebar-w|rail-w|dock-w)$/.test(name) ? 'px' : '');
const decls = (values) => Object.entries(values).map(([name, value]) => `    --${name}: ${value};`).join('\n');
const inputs = (values) => decls(Object.fromEntries(Object.entries(values).map(([name, value]) => [name, `${value}${px(name)}`])));
const fs = lab.fontScale;
const message = (u) => ({
  'user-pad-x': `${u.padX}px`, 'user-pad-y': `${u.padY}px`, 'user-radius': `${u.radius}px`, 'user-weight': u.weight,
  'user-max-width': `${u.maxWidth}%`, 'user-margin-start': u.align === 'start' ? '0' : 'auto',
  'user-fill': u.fill === 'none' ? 'transparent' : `var(--${u.fill})`, 'user-ink': u.fill === 'accent' ? 'var(--accent-ink)' : 'var(--ink)',
  'user-ring': u.ring ? 'inset 0 0 0 1px var(--line)' : u.fill === 'accent' ? 'inset 0 1px 0 oklch(1 0 0 / 0.2)' : 'none',
  'user-text-boost': `${u.textBoost}px`, 'user-tail-radius': `${Math.min(u.tail, u.radius)}px`,
});

const root = `:root {
${inputs(lab.inputs)}
${decls({
  'font-sans': SANS,
  'font-serif': '"Newsreader", "Iowan Old Style", "Songti SC", "Noto Serif SC", Georgia, serif',
  'font-mono': MONO,
  'font-ui': 'var(--font-sans)',
  'font-prose': 'var(--font-sans)',
  'fs-ui': `calc(${fs.ui}px * var(--font-scale))`,
  'fs-sm': `calc(${fs.sm}px * var(--font-scale))`,
  'fs-xs': `calc(${fs.xs}px * var(--font-scale))`,
  'fs-prose': `calc(${fs.prose}px * var(--font-scale))`,
  'lh-prose': lab.prose.lineHeight,
  'r-xs': 'calc(var(--radius) * 0.4)',
  'r-sm': 'calc(var(--radius) * 0.7)',
  'r-md': 'var(--radius)',
  'r-lg': 'calc(var(--radius) * 1.4)',
  'r-xl': 'calc(var(--radius) * 2)',
  'r-pill': '999px',
  'r-composer': 'calc(var(--radius) * 2)',
  'row-h': 'calc(32px * var(--density))',
  'row-h-lg': 'calc(38px * var(--density))',
  'pad-1': 'calc(4px * var(--density))',
  'pad-2': 'calc(8px * var(--density))',
  'pad-3': 'calc(12px * var(--density))',
  'pad-4': 'calc(16px * var(--density))',
  'pad-5': 'calc(24px * var(--density))',
  'msg-gap': 'calc(28px * var(--density))',
  'dur-1': `calc(${tokens.motion.fast}ms / var(--speed))`,
  'dur-2': `calc(${tokens.motion.base}ms / var(--speed))`,
  'dur-3': `calc(${tokens.motion.slow}ms / var(--speed))`,
  'dur-4': `calc(${tokens.motion.slower}ms / var(--speed))`,
  'ease-out': lab.ease.out,
  'ease-io': lab.ease.inOut,
  'ease-spring': tokens.motion.easeSpring,
  ease: 'var(--ease-out)',
  ...message(tokens.userMessage),
  'sidebar-fill': 'var(--sidebar)',
})}
}
@media (prefers-reduced-motion: reduce) { :root { --speed: 100; } }
:root[data-reduce="true"] { --speed: 100; }
`;

const light = `:root, :root[data-theme="light"] {
    color-scheme: light;
    --n-h: var(--neutral-hue);
    --n-c: var(--neutral-chroma);
    --backdrop: oklch(0.955 var(--n-c) var(--n-h));
    --canvas: oklch(0.999 calc(var(--n-c) * 0.3) var(--n-h));
    --sidebar: oklch(0.972 var(--n-c) var(--n-h));
    --sunken: oklch(0.962 var(--n-c) var(--n-h));
    --raised: oklch(1 0 0);
    --hover: oklch(0.2 var(--n-c) var(--n-h) / 0.05);
    --active: oklch(0.2 var(--n-c) var(--n-h) / 0.085);
    --ink: oklch(0.2 var(--n-c) var(--n-h));
    --ink-2: oklch(0.38 var(--n-c) var(--n-h));
    --muted: oklch(0.54 var(--n-c) var(--n-h));
    --subtle: oklch(0.7 var(--n-c) var(--n-h));
    --line: oklch(0.2 var(--n-c) var(--n-h) / calc(0.085 * var(--line-a)));
    --line-strong: oklch(0.2 var(--n-c) var(--n-h) / calc(0.17 * var(--line-a)));
    --accent: oklch(0.56 var(--accent-c) var(--accent-h));
    --accent-ink: oklch(0.99 0 0);
    --success: oklch(0.6 0.15 155);
    --warn: oklch(0.7 0.15 72);
    --danger: oklch(0.58 0.21 25);
    --danger-ink: oklch(0.99 0 0);
    --shadow-rgb: 20 24 40;
    --hl: oklch(1 0 0 / 0);
    --scrim: oklch(0.2 0.02 var(--n-h) / 0.32);
    --code-bg: oklch(0.968 var(--n-c) var(--n-h));
    --tk-k: oklch(0.55 0.2 300); --tk-s: oklch(0.52 0.14 155); --tk-n: oklch(0.58 0.17 50); --tk-c: oklch(0.68 0.02 var(--n-h)); --tk-f: oklch(0.52 0.16 250);
    --toast-bg: oklch(0.22 var(--n-c) var(--n-h)); --toast-ink: oklch(0.98 0 0);
    --mono-filter: none;
}
`;
const dark = `:root[data-theme="dark"] {
    color-scheme: dark;
    --backdrop: oklch(0.12 var(--n-c) var(--n-h));
    --canvas: oklch(0.178 var(--n-c) var(--n-h));
    --sidebar: oklch(0.15 var(--n-c) var(--n-h));
    --sunken: oklch(0.15 var(--n-c) var(--n-h));
    --raised: oklch(0.22 var(--n-c) var(--n-h));
    --hover: oklch(1 0 0 / 0.055);
    --active: oklch(1 0 0 / 0.095);
    --ink: oklch(0.965 calc(var(--n-c) * 0.5) var(--n-h));
    --ink-2: oklch(0.82 calc(var(--n-c) * 0.6) var(--n-h));
    --muted: oklch(0.68 calc(var(--n-c) * 0.7) var(--n-h));
    --subtle: oklch(0.52 calc(var(--n-c) * 0.7) var(--n-h));
    --line: oklch(1 0 0 / calc(0.08 * var(--line-a)));
    --line-strong: oklch(1 0 0 / calc(0.16 * var(--line-a)));
    --accent: oklch(0.72 var(--accent-c) var(--accent-h));
    --accent-ink: oklch(0.16 0.02 var(--accent-h));
    --success: oklch(0.74 0.16 155);
    --warn: oklch(0.8 0.14 78);
    --danger: oklch(0.7 0.19 25);
    --danger-ink: oklch(0.15 0.03 25);
    --shadow-rgb: 0 0 0;
    --hl: oklch(1 0 0 / 0.06);
    --scrim: oklch(0 0 0 / 0.55);
    --code-bg: oklch(0.145 var(--n-c) var(--n-h));
    --tk-k: oklch(0.76 0.14 300); --tk-s: oklch(0.78 0.13 155); --tk-n: oklch(0.78 0.13 55); --tk-c: oklch(0.55 0.02 var(--n-h)); --tk-f: oklch(0.78 0.12 250);
    --toast-bg: oklch(0.96 var(--n-c) var(--n-h)); --toast-ink: oklch(0.18 0 0);
    --mono-filter: invert(1);
}
`;

const derived = `:root {
    --accent-soft: color-mix(in oklab, var(--accent) 10%, transparent);
    --accent-soft-2: color-mix(in oklab, var(--accent) 16%, transparent);
    --accent-line: color-mix(in oklab, var(--accent) 32%, transparent);
    --accent-ring: color-mix(in oklab, var(--accent) 38%, transparent);
    --success-soft: color-mix(in oklab, var(--success) 13%, transparent);
    --warn-soft: color-mix(in oklab, var(--warn) 16%, transparent);
    --danger-soft: color-mix(in oklab, var(--danger) 11%, transparent);
    --danger-line: color-mix(in oklab, var(--danger) 36%, transparent);
    --sh-1: 0 1px 2px rgb(var(--shadow-rgb) / calc(0.06 * var(--shadow-k)));
    --sh-2: 0 0 0 1px var(--line), 0 1px 2px rgb(var(--shadow-rgb) / calc(0.05 * var(--shadow-k))), 0 4px 12px -2px rgb(var(--shadow-rgb) / calc(0.07 * var(--shadow-k)));
    --sh-pop: 0 0 0 1px var(--line-strong), 0 1px 1px rgb(var(--shadow-rgb) / calc(0.04 * var(--shadow-k))), 0 6px 12px -4px rgb(var(--shadow-rgb) / calc(0.08 * var(--shadow-k))), 0 18px 36px -10px rgb(var(--shadow-rgb) / calc(0.14 * var(--shadow-k))), 0 36px 72px -24px rgb(var(--shadow-rgb) / calc(0.18 * var(--shadow-k)));
    --sh-modal: 0 0 0 1px var(--line-strong), 0 2px 4px rgb(var(--shadow-rgb) / calc(0.05 * var(--shadow-k))), 0 24px 48px -12px rgb(var(--shadow-rgb) / calc(0.22 * var(--shadow-k))), 0 64px 120px -32px rgb(var(--shadow-rgb) / calc(0.3 * var(--shadow-k)));
    --sh-sheet: 0 0 0 1px var(--line), 0 12px 40px -8px rgb(var(--shadow-rgb) / calc(0.12 * var(--shadow-k)));
}
:root[data-theme="dark"] {
    --sh-1: 0 1px 2px rgb(0 0 0 / calc(0.4 * var(--shadow-k)));
    --sh-2: 0 0 0 1px var(--line), inset 0 1px 0 var(--hl), 0 4px 12px -2px rgb(0 0 0 / calc(0.4 * var(--shadow-k)));
    --sh-pop: 0 0 0 1px var(--line-strong), inset 0 1px 0 var(--hl), 0 8px 16px -4px rgb(0 0 0 / calc(0.4 * var(--shadow-k))), 0 24px 56px -12px rgb(0 0 0 / calc(0.6 * var(--shadow-k)));
    --sh-modal: 0 0 0 1px var(--line-strong), inset 0 1px 0 var(--hl), 0 32px 80px -16px rgb(0 0 0 / calc(0.7 * var(--shadow-k)));
    --sh-sheet: 0 0 0 1px var(--line), inset 0 1px 0 var(--hl), 0 16px 48px -8px rgb(0 0 0 / calc(0.5 * var(--shadow-k)));
}
`;

// A look is data only: it overrides inputs and a few semantic hooks. Components never branch on its name.
const looks = Object.entries(tokens.looks).map(([name, look]) => {
  const l = look.lab;
  if (!l) return '';
  const values = { ...Object.fromEntries(Object.entries(l.inputs ?? {}).map(([k, v]) => [k, `${v}${px(k)}`])) };
  if (l.ease) { values['ease-out'] = l.ease; }
  if (l.monoUi) values['font-ui'] = 'var(--font-mono)';
  if (l.sidebarFlat) values['sidebar-fill'] = 'var(--canvas)';
  if (look.userMessage) Object.assign(values, message({ ...tokens.userMessage, ...look.userMessage }));
  const accent = l.accentMono ? `:root[data-look="${name}"] {\n    --accent: var(--ink);\n    --accent-ink: var(--canvas);\n}\n` : '';
  return `:root[data-look="${name}"] {\n${decls(values)}\n}\n${accent}`;
}).join('');
// Derived accent-dependent tokens must follow a look's accent override; they resolve on :root.
const legacy = `/* Transitional aliases for surfaces that have not been rewritten onto the lab names yet. */
:root {
${decls({
  'font-size-base': 'var(--fs-ui)', 'font-size-ui': 'var(--fs-ui)', 'font-size-meta': 'var(--fs-sm)', 'font-size-caption': 'var(--fs-xs)', 'font-size-body': 'var(--fs-prose)',
  ...Object.fromEntries(Object.entries(tokens.typography.weight).map(([k, v]) => [`weight-${k}`, v])),
  ...Object.fromEntries(Object.entries(tokens.space).map(([k, v]) => [`space-${k}`, `calc(${v}px * var(--density))`])),
  'radius-field': 'var(--r-md)', 'radius-item': 'var(--r-md)', 'radius-panel': 'var(--r-lg)', 'radius-dialog': 'var(--r-xl)', 'radius-composer': 'var(--r-composer)',
  'radius-xs': 'var(--r-xs)', 'radius-sm': 'var(--r-sm)', 'radius-md': 'var(--r-md)', 'radius-lg': 'var(--r-lg)', 'radius-xl': 'var(--r-xl)', 'radius-pill': 'var(--r-pill)',
  'radius-control': 'var(--r-md)', 'radius-popover': 'var(--r-lg)',
  'control-compact': 'var(--row-h)', 'control-normal': 'var(--row-h-lg)', 'control-touch': '44px', 'control-height': 'var(--row-h-lg)', 'form-gap': 'var(--pad-3)',
  'motion-duration': 'var(--dur-2)', 'motion-ease': 'var(--ease)',
  'shadow-popover': 'var(--sh-pop)', 'shadow-dialog': 'var(--sh-modal)', 'shadow-sheet': 'var(--sh-sheet)', 'shadow-card': 'var(--sh-2)', 'shadow-hair': 'var(--sh-1)',
  'shadow-composer': 'var(--sh-composer)', 'shadow-composer-focus': 'var(--sh-composer-focus)',
  paper: 'var(--backdrop)', surface: 'var(--canvas)', 'surface-raised': 'var(--raised)', field: 'var(--raised)', 'font-code': 'var(--font-mono)',
  'tile-tint': '16%', 'sheet-gap': '8px',
})}
}
:root[data-theme="dark"] { --tile-tint: 24%; }
:root[data-look="mono"] { --tile-tint: 0%; }
`;
const composerShadows = `:root {
    --sh-composer: 0 0 0 1px var(--line-strong), 0 1px 2px rgb(var(--shadow-rgb) / calc(0.04 * var(--shadow-k))), 0 8px 28px -8px rgb(var(--shadow-rgb) / calc(0.1 * var(--shadow-k))), inset 0 1px 0 var(--hl);
    --sh-composer-focus: 0 0 0 1px var(--accent-line), 0 0 0 4px var(--accent-soft), 0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 12px 32px -8px rgb(var(--shadow-rgb) / calc(0.14 * var(--shadow-k))), inset 0 1px 0 var(--hl);
}
`;
const css = '/* Generated from tokens.json. Edit the source, not this file. */\n' + root + light + dark + derived + composerShadows + looks + legacy;
let current;
try { current = readFileSync(output, 'utf8'); } catch { /* First generation. */ }
if (current !== css) writeFileSync(output, css);
