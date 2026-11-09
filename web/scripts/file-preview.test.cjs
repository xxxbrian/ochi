const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const load = require('../../shared/conversation/test-loader.cjs').createLoader(require('typescript'), require);
const files = load(path.resolve(__dirname, '../src/lib/files.ts'));

const file = (name, mime = 'application/octet-stream', extra = {}) => ({ id: name, name, mime_type: mime, size: 1, url: `/api/files/${name}`, path: name, created_at: '2026-01-01T00:00:00Z', ...extra });

test('file kinds route SVG and HTML to the dock and keep raster images in the viewer', () => {
  const kind = (name, mime) => files.fileKind(file(name, mime));
  assert.equal(kind('a.svg', 'image/svg+xml'), 'svg');
  assert.equal(kind('a.png', 'image/png'), 'image');
  assert.equal(kind('page.html', 'text/html'), 'html');
  assert.equal(kind('notes.md', 'text/markdown'), 'markdown');
  assert.equal(kind('table.tsv', 'text/plain'), 'csv');
  assert.equal(kind('doc.pdf', 'application/pdf'), 'pdf');
  assert.equal(kind('main.go', 'application/octet-stream'), 'code');
  assert.equal(kind('blob.bin', 'application/octet-stream'), 'binary');
  assert.equal(files.opensInDock(file('a.svg', 'image/svg+xml')), true);
  assert.equal(files.opensInDock(file('a.png', 'image/png')), false);
  assert.equal(files.isRasterImage(file('a.svg', 'image/svg+xml')), false);
});

test('private bytes are fetched only from the app origin', () => {
  const base = 'https://ochi.example/chat';
  assert.equal(files.isSameOrigin('/api/files/1', base), true);
  assert.equal(files.isSameOrigin('https://ochi.example/api/files/1', base), true);
  assert.equal(files.isSameOrigin('https://evil.example/api/files/1', base), false);
  assert.equal(files.isSameOrigin('//evil.example/x', base), false);
  assert.equal(files.downloadUrl({ url: '/a?x=1' }), '/a?x=1&download=1');
});

test('delimited parsing keeps quotes, embedded newlines and BOMs; sorting is stable and numeric-aware', () => {
  const rows = files.parseDelimited('﻿name,qty\r\n"Smith, J",10\n"say ""hi""\nthere",9\n', ',');
  assert.deepEqual(rows, [['name', 'qty'], ['Smith, J', '10'], ['say "hi"\nthere', '9']]);
  const body = rows.slice(1);
  const numbers = files.numericColumns(body, 2);
  assert.deepEqual(numbers, [false, true]);
  assert.deepEqual(files.sortRows(body, { column: 1, direction: 1 }, numbers).map((row) => row[1]), ['9', '10']);
  assert.deepEqual(files.sortRows(body, { column: 1, direction: -1 }, numbers).map((row) => row[1]), ['10', '9']);
  assert.deepEqual(files.nextSort(null, 0), { column: 0, direction: 1 });
  assert.deepEqual(files.nextSort({ column: 0, direction: 1 }, 0), { column: 0, direction: -1 });
  assert.equal(files.nextSort({ column: 0, direction: -1 }, 0), null);
});

test('versions of the same source path are listed newest first and always include the opened file', () => {
  const a = file('1', 'text/html', { source_path: 'app.html', version: 1, created_at: '2026-01-01T00:00:00Z' });
  const b = file('2', 'text/html', { source_path: 'app.html', version: 2, created_at: '2026-01-02T00:00:00Z' });
  const other = file('3', 'text/html', { source_path: 'other.html', version: 5 });
  assert.deepEqual(files.versionsOf(a, [a, b, other]).map((item) => item.id), ['2', '1']);
  assert.deepEqual(files.versionsOf(other, []).map((item) => item.id), ['3']);
});

test('artifact HTML runs sandboxed without same-origin privilege and SVG is only ever an image', () => {
  const dock = fs.readFileSync(path.resolve(__dirname, '../src/components/ArtifactDock.tsx'), 'utf8');
  const cards = fs.readFileSync(path.resolve(__dirname, '../src/components/FileCards.tsx'), 'utf8');
  for (const source of [dock, cards]) {
    assert.doesNotMatch(source, /allow-same-origin/);
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  }
  assert.match(dock, /sandbox="allow-scripts"/);
  assert.match(cards, /sandbox="allow-scripts"/);
  const store = fs.readFileSync(path.resolve(__dirname, '../src/lib/artifactDock.ts'), 'utf8');
  assert.match(store, /type: "image\/svg\+xml"/);
  assert.doesNotMatch(store, /allow-same-origin/);
  assert.match(dock, /useSvgUrl/);
  assert.match(cards, /useSvgUrl/);
});
