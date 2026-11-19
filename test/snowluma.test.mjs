import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createSnowLumaManager } from '../plugin/src/snowluma-manager.mjs';

test('SnowLuma launcher prevents duplicate launches and requires local manual QQ loading', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surfcore-snow-'));
  await mkdir(join(directory, 'config'));
  await writeFile(join(directory, 'node.exe'), ''); await writeFile(join(directory, 'index.mjs'), '');
  const configFile = join(directory, 'config', 'runtime.json');
  const config = { hookAutoLoad: false, webuiHost: '127.0.0.1', webuiPort: 5099, webuiTls: { enabled: false } };
  await writeFile(configFile, JSON.stringify(config));
  let running = false, calls = 0, options;
  const manager = createSnowLumaManager({ directory, probe: async () => running, identify: async () => true, launch: (executable, args, opts) => {
    calls++; options = opts;
    const child = new EventEmitter(); child.exitCode = null; child.killed = false; child.unref = () => {};
    queueMicrotask(() => child.emit('spawn')); return child;
  } });
  assert.equal((await manager.status()).listening, false);
  await manager.start(); assert.equal(calls, 1);
  assert.equal(options.cwd, directory);
  assert.equal(Object.keys(options.env).some((key) => /^(SURFCORE_|SNOWLUMA_)/i.test(key)), false);
  await assert.rejects(manager.start(), /已发出/);
  running = true; await assert.rejects(manager.start(), /占用/);
  assert.equal((await manager.status()).ready, true);
  const otherService = createSnowLumaManager({ directory, probe: async () => true, identify: async () => false });
  assert.equal((await otherService.status()).ready, false);
  await writeFile(configFile, JSON.stringify({ ...config, hookAutoLoad: true }));
  assert.equal((await manager.status()).installed, false);
  await assert.rejects(manager.start(), /自动加载/);
  await writeFile(configFile, JSON.stringify({ ...config, webuiHost: '0.0.0.0' }));
  await assert.rejects(manager.start(), /本机/);
  assert.equal(calls, 1);
});
