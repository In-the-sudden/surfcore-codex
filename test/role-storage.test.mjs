import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const data = await mkdtemp(join(tmpdir(), 'surfcore-role-store-'));
process.env.SURFCORE_DATA_DIR = data;
const store = await import('../plugin/src/store.mjs');
const storage = await import('../plugin/src/role-storage.mjs');

test('moving role storage copies existing data without overwriting, and active processes follow the new directory', async () => {
  await store.listCharacters();
  await store.addMemory('lin', 'shared', { note: 'before move' });
  const destination = await mkdtemp(join(tmpdir(), 'surfcore-destination-'));
  const [result] = await Promise.all([
    storage.moveRoleStorage(destination),
    ...Array.from({ length: 8 }, (_, index) => store.addMemory('lin', 'shared', { note: 'concurrent ' + index })),
  ]);
  assert.equal(result.directory, destination);
  assert.equal((await store.listMemoryPage('lin')).total, 9);
  assert.match(await readFile(join(data, 'characters/lin/shared.jsonl'), 'utf8'), /before move/);
  assert.match(await readFile(join(destination, 'characters/lin/persona.md'), 'utf8'), /林/);
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `import { listMemoryPage } from ${JSON.stringify(new URL('../plugin/src/store.mjs', import.meta.url).href)}; console.log((await listMemoryPage('lin')).total);`],
  { env: { ...process.env, SURFCORE_DATA_DIR: data } });
  assert.equal(child.stdout.trim(), '9');
  await assert.rejects(storage.moveRoleStorage(data), /互相包含|空目录/);
  const occupied = await mkdtemp(join(tmpdir(), 'surfcore-occupied-'));
  await writeFile(join(occupied, 'existing.txt'), 'keep');
  await assert.rejects(storage.moveRoleStorage(occupied), /空目录/);
  assert.equal(await readFile(join(occupied, 'existing.txt'), 'utf8'), 'keep');
  assert.equal((await storage.getRoleStorage()).directory, destination);
  const secondDestination = await mkdtemp(join(tmpdir(), 'surfcore-destination-again-'));
  await storage.moveRoleStorage(secondDestination);
  assert.equal((await storage.getRoleStorage()).directory, secondDestination);
  assert.equal((await store.listMemoryPage('lin')).total, 9);
  assert.match(await readFile(join(destination, 'characters/lin/shared.jsonl'), 'utf8'), /before move/);
  const unavailable = secondDestination + '-unavailable';
  await rename(secondDestination, unavailable);
  try { await assert.rejects(store.listCharacters(), /存储目录不可用/); }
  finally { await rename(unavailable, secondDestination); }
  assert.equal((await store.listMemoryPage('lin')).total, 9);
});
