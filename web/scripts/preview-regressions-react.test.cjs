const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.invalid/' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLIFrameElement: dom.window.HTMLIFrameElement,
  Element: dom.window.Element,
  MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: () => ({ transitionDuration: '0.32s', transitionDelay: '0s' }),
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
});
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

const React = require('react');
const { render, act, cleanup, fireEvent } = require('@testing-library/react');
const { createLoader } = require('../../shared/conversation/test-loader.cjs');
const i18n = require('./i18n-harness.cjs').createI18nHarness('en');
const root = path.resolve(__dirname, '../..');
const source = (relative) => path.join(root, 'web/src', relative);
const file = (id, extra = {}) => ({
  id, name: `${id}.html`, mime_type: 'text/html', size: 1,
  url: `/api/files/${id}`, path: id, source_path: 'index.html',
  created_at: '2026-01-01T00:00:00Z', ...extra,
});

function setup(text = '<h1>Example</h1>', loading = false) {
  const content = loading ? { status: 'loading' } : { status: 'ready', text, truncated: false, bytes: null };
  const wrapper = ({ children }) => React.createElement(React.Fragment, null, children);
  const load = createLoader(require('typescript'), require, {
    [source('lib/i18n.ts')]: i18n.web,
    [source('hooks/useFileContent.ts')]: { useFileContent: () => ({ content, retry() {} }) },
    [source('components/CodeView.tsx')]: { CodeView: () => null },
    [source('components/FileTile.tsx')]: { FileTile: () => null },
    [source('components/ui/Toast.tsx')]: { toast() {} },
    '@base-ui/react/dialog': { Dialog: {
      Root: wrapper, Portal: wrapper, Backdrop: () => null,
      Popup: ({ children }) => React.createElement('section', null, children),
      Title: ({ children }) => React.createElement('b', null, children),
      Close: ({ children, ...props }) => React.createElement('button', props, children),
    } },
  });
  return {
    ...load(source('lib/artifactDock.ts')),
    ...load(source('components/ArtifactDock.tsx')),
    ...load(source('components/FilePreview.tsx')),
  };
}

test.afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});

test('artifact metadata and open files belong to the active account only', () => {
  const store = setup();
  let state;
  function Snapshot() {
    state = store.useArtifactDock();
    return null;
  }
  render(React.createElement(Snapshot));
  const a1 = file('a1', { version: 1 });
  const a2 = file('a2', { version: 2 });
  const b = file('b', { version: 1 });
  let unregister;
  act(() => {
    unregister = store.registerDockHost();
    store.setArtifactOwner('account-a');
    store.rememberArtifacts([a1, a2], 'account-a');
    store.openArtifact(a2, 'account-a');
  });
  assert.equal(store.hasDockHost(), true);
  assert.equal(state.file.id, 'a2');
  assert.deepEqual(store.artifactVersions(a1, 'account-a').map((item) => item.id), ['a2', 'a1']);
  act(() => store.setArtifactOwner(null));
  assert.equal(state.file, null);
  assert.equal(store.hasDockHost(), false);
  act(() => {
    store.setArtifactOwner('account-b');
    store.rememberArtifacts([b], 'account-b');
    store.rememberArtifacts([a1, a2], 'account-a');
    store.openArtifact(a1, 'account-a');
  });
  assert.equal(state.file, null, 'an earlier account callback cannot reopen its file');
  assert.deepEqual(store.artifactVersions(b, 'account-b').map((item) => item.id), ['b']);
  act(() => store.openArtifact(b, 'account-b'));
  assert.equal(state.file.id, 'b');
  act(() => unregister());
});

test('the retained closing dock cannot display the previous account preview', () => {
  const store = setup('', true);
  act(() => store.setArtifactOwner('account-a'));
  const view = render(React.createElement(store.ArtifactDock));
  act(() => store.openArtifact(file('private-a'), 'account-a'));
  assert.ok(view.container.querySelector('aside'));
  assert.equal(view.container.querySelector('.dock-title').textContent, 'private-a.html');
  act(() => store.setArtifactOwner('account-b'));
  assert.equal(view.container.querySelector('aside'), null, 'owner isolation is immediate, before the close timer retires retained state');
  act(() => store.openArtifact(file('private-b'), 'account-b'));
  assert.equal(view.container.querySelector('.dock-title').textContent, 'private-b.html');
  assert.equal(view.container.textContent.includes('private-a'), false);
});

function frameTimers() {
  const originalSet = window.setTimeout;
  const originalClear = window.clearTimeout;
  const pending = new Map();
  let next = 0;
  window.setTimeout = (callback, delay) => {
    const id = ++next;
    pending.set(id, { callback, delay, cleared: false });
    return id;
  };
  window.clearTimeout = (id) => {
    if (pending.has(id)) pending.get(id).cleared = true;
  };
  return {
    pending,
    restore() { window.setTimeout = originalSet; window.clearTimeout = originalClear; },
  };
}

test('stale iframe load and already queued retirement cannot discard a newer reload', () => {
  const { HtmlFrames } = setup();
  const timers = frameTimers();
  let loaded = 0;
  const props = { id: 'page', text: '<h1>First</h1>', reload: 0, title: 'Preview', onLoaded: () => loaded++ };
  let view;
  try {
    view = render(React.createElement(HtmlFrames, props));
    const first = view.container.querySelector('iframe');
    fireEvent.load(first);
    assert.equal(first.dataset.on, 'true');
    const firstTimer = [...timers.pending.values()].at(-1);
    assert.equal(firstTimer.delay, 320, 'retirement follows the actual CSS transition');
    view.rerender(React.createElement(HtmlFrames, { ...props, reload: 1 }));
    const second = view.container.querySelectorAll('iframe')[1];
    assert.ok(second);
    act(() => firstTimer.callback());
    assert.equal(second.isConnected, true);
    fireEvent.load(first);
    assert.equal(loaded, 1, 'a stale load is ignored');
    view.rerender(React.createElement(HtmlFrames, { ...props, reload: 2 }));
    const frames = [...view.container.querySelectorAll('iframe')];
    assert.equal(frames.length, 2, 'only the visible frame and newest pending replacement remain');
    assert.equal(second.isConnected, false);
    const latest = frames[1];
    fireEvent.load(latest);
    assert.equal(loaded, 2);
    assert.equal(latest.dataset.on, 'true');
    act(() => [...timers.pending.values()].at(-1).callback());
    assert.deepEqual([...view.container.querySelectorAll('iframe')], [latest]);
    assert.equal(latest.getAttribute('sandbox'), 'allow-scripts');
    view.unmount();
    assert.equal([...timers.pending.values()].at(-1).cleared, true);
  } finally {
    view?.unmount();
    timers.restore();
  }
});

test('theme round trips create distinct iframe requests even when their HTML repeats', async () => {
  const { HtmlFrames } = setup();
  const timers = frameTimers();
  const props = { id: 'page', text: '<html><head></head><body>Example</body></html>', reload: 0, title: 'Preview', onLoaded() {} };
  let view;
  try {
    view = render(React.createElement(HtmlFrames, props));
    const firstLight = view.container.querySelector('iframe');
    fireEvent.load(firstLight);
    const oldRetirement = [...timers.pending.values()].at(-1).callback;
    await act(async () => {
      document.documentElement.dataset.theme = 'dark';
      await Promise.resolve();
    });
    const dark = [...view.container.querySelectorAll('iframe')].at(-1);
    assert.match(dark.srcdoc, /color-scheme:dark/);
    await act(async () => {
      document.documentElement.dataset.theme = 'light';
      await Promise.resolve();
    });
    const latestLight = [...view.container.querySelectorAll('iframe')].at(-1);
    assert.equal(latestLight.srcdoc, firstLight.srcdoc);
    assert.notEqual(latestLight, firstLight);
    act(() => oldRetirement());
    assert.equal(latestLight.isConnected, true, 'repeated document bytes do not revive an older request identity');
    fireEvent.load(latestLight);
    act(() => [...timers.pending.values()].at(-1).callback());
    assert.deepEqual([...view.container.querySelectorAll('iframe')], [latestLight]);
  } finally {
    view?.unmount();
    timers.restore();
  }
});

test('a valid large CSV renders its bounded table without spreading every row into a function call', () => {
  const text = `qty,label\n${'1,x\n'.repeat(150_000)}2,x,extra\n`;
  assert.ok(text.length < 1_000_000, 'the fixture is within the supported text preview size');
  const { FilePreview } = setup(text);
  const view = render(React.createElement(FilePreview, { file: file('table', { name: 'table.csv', mime_type: 'text/csv', source_path: '' }), onClose() {} }));
  assert.equal(view.container.querySelectorAll('tbody tr').length, 2000);
  assert.equal(view.container.querySelectorAll('thead th').length, 4, 'a wider row beyond the visible slice still contributes its column');
  assert.match(view.container.querySelector('.pv-tfoot').textContent, /150,001/);
  const qty = view.getByRole('button', { name: 'qty' });
  fireEvent.click(qty);
  assert.equal(qty.closest('th').getAttribute('aria-sort'), 'ascending');
  fireEvent.click(qty);
  assert.equal(qty.closest('th').getAttribute('aria-sort'), 'descending');
  assert.equal(view.container.querySelector('tbody tr td:nth-child(2)').textContent, '2');
  assert.equal(view.container.querySelectorAll('tbody tr').length, 2000);
});
