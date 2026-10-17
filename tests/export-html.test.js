import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportHtml } from '../scripts/export-html.mjs';

async function fixture(t, { html, javascript = '', css = '' }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'thought-canvas-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'assets'));
  await writeFile(path.join(directory, 'index.html'), html);
  await writeFile(path.join(directory, 'assets/app.js'), javascript);
  await writeFile(path.join(directory, 'assets/app.css'), css);
  return directory;
}

test('standalone export embeds scripts and styles and preserves the original build', async (t) => {
  const html = '<html><head><script type="module" crossorigin src="/assets/app.js"></script><link rel="modulepreload" href="/assets/extra.js"><link rel="stylesheet" href="/assets/app.css"></head><body><main>Полотно</main></body></html>';
  const directory = await fixture(t, { html, javascript: 'document.body.dataset.ready = "yes";', css: 'body { background: white; }' });
  const output = await exportHtml(directory);
  const result = await readFile(output, 'utf8');
  assert.equal(path.basename(output), 'Polotno.html');
  assert.match(result, /<script type="module">\s*document.body.dataset.ready/);
  assert.match(result, /<style>\s*body \{ background: white; \}/);
  assert.doesNotMatch(result, /\b(?:src|href)\s*=/);
  assert.equal(await readFile(path.join(directory, 'index.html'), 'utf8'), html);
});

test('embedded code cannot prematurely close its script or style element', async (t) => {
  const directory = await fixture(t, {
    html: '<script src="assets/app.js"></script><link href="assets/app.css" rel="stylesheet">',
    javascript: 'const text = "</script><p>not markup</p>";',
    css: 'body::before { content: "</style>"; }',
  });
  const result = await readFile(await exportHtml(directory), 'utf8');
  assert.match(result, /"<\\\/script><p>not markup<\/p>"/);
  assert.match(result, /"<\\\/style>"/);
  assert.equal((result.match(/<\/script>/g) || []).length, 1);
  assert.equal((result.match(/<\/style>/g) || []).length, 1);
});

test('export rejects external and out-of-directory assets', async (t) => {
  const external = await fixture(t, { html: '<script src="https://example.com/app.js"></script>' });
  await assert.rejects(exportHtml(external), /external asset/);
  const traversal = await fixture(t, { html: '<script src="../app.js"></script>' });
  await assert.rejects(exportHtml(traversal), /outside the build directory/);
});

test('export refuses to leave JavaScript imports or CSS resources unresolved', async (t) => {
  const javascript = await fixture(t, { html: '<script src="assets/app.js"></script>', javascript: 'import("./chunk.js");' });
  await assert.rejects(exportHtml(javascript), /imports another file/);
  const css = await fixture(t, { html: '<link rel="stylesheet" href="assets/app.css">', css: 'body { background: url("./image.png"); }' });
  await assert.rejects(exportHtml(css), /loads another asset/);
});

test('self-contained CSS data URLs remain embedded', async (t) => {
  const css = 'body { background: url(  "data:image/png;base64,aGVsbG8="  ); }';
  const directory = await fixture(t, { html: '<link rel="stylesheet" href="assets/app.css">', css });
  assert.ok((await readFile(await exportHtml(directory), 'utf8')).includes(css));
});
