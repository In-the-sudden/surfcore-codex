import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const data = await mkdtemp(join(tmpdir(), 'surfcore-launcher-test-'));
process.env.SURFCORE_DATA_DIR = data;
const { createPanelLauncher, requestPanelOpen, servePanelLauncher } = await import('../plugin/src/panel-launcher.mjs');
after(() => rm(data, { recursive: true, force: true }));

test('one-click launch uses an authenticated local panel and reuses it', { skip: process.platform !== 'win32' }, async (t) => {
  const visited = [];
  const launcher = createPanelLauncher({ openBrowser: async (address) => {
    const url = new URL(address);
    assert.equal(url.hostname, '127.0.0.1');
    const key = new URLSearchParams(url.hash.slice(1)).get('access');
    assert.ok(key);
    const endpoint = new URL('/api/qq', url);
    assert.equal((await fetch(endpoint)).status, 401);
    const response = await fetch(endpoint, { headers: { 'x-surfcore-key': key } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'stopped');
    visited.push(url.origin);
  } });
  t.after(() => launcher.close());

  assert.deepEqual(await Promise.all([launcher.open(), launcher.open()]), [{ opened: true }, { opened: true }]);
  assert.equal(visited.length, 1);
  assert.deepEqual(await launcher.open(), { opened: true });
  assert.deepEqual(visited, [visited[0], visited[0]]);
});

test('separate launch requests use one panel and keep styles, scripts and role data available', { skip: process.platform !== 'win32' }, async (t) => {
  const pipe = '\\\\.\\pipe\\surfcore-test-' + randomUUID();
  const opened = [];
  const close = await servePanelLauncher(pipe, async (url) => { opened.push(new URL(url)); });
  t.after(close);

  assert.equal(await requestPanelOpen(pipe), true);
  assert.equal(await requestPanelOpen(pipe), true);
  assert.equal(opened.length, 2);
  assert.equal(opened[0].href, opened[1].href);
  const url = opened[0];
  for (const [path, contentType] of [['/panel.css', 'text/css'], ['/panel.js', 'text/javascript'], ['/qq.js', 'text/javascript']]) {
    const response = await fetch(new URL(path, url));
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(contentType));
    await response.arrayBuffer();
  }
  const access = new URLSearchParams(url.hash.slice(1)).get('access');
  const response = await fetch(new URL('/api/overview', url), { headers: { 'x-surfcore-key': access } });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).characters.length > 0);
});
