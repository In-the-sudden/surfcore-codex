import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('SnowLuma button opens a waiting tab and navigates once the service is ready', async () => {
  const source = await readFile(new URL('../plugin/panel/qq.js', import.meta.url), 'utf8');
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', disabled: false, hidden: false });
    return elements.get(id);
  };
  let started = false, opened = false, destination = '';
  const popup = { document: { body: {} }, location: { replace: (url) => { destination = url; } }, close: () => {} };
  const api = async (path, method) => {
    if (path === 'qq') return { state: 'stopped', config: { owner: '', selfId: '', admins: [], groups: [], wsUrl: '', httpUrl: '' }, log: [] };
    if (path === 'snowluma/start' && method === 'POST') { assert.equal(opened, true); started = true; return {}; }
    if (path === 'snowluma') return { installed: true, listening: started, ready: started, url: 'http://127.0.0.1:5099/' };
    throw new Error('Unexpected API: ' + path);
  };
  runInNewContext(source, { $: element, api, status: () => {}, window: { open: () => { opened = true; return popup; } }, setInterval: () => {}, setTimeout, Date, Promise });
  await element('snow-start').onclick();
  assert.equal(destination, 'http://127.0.0.1:5099/');
  assert.equal(element('snow-open').hidden, false);
});
