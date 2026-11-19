import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = await mkdtemp(join(tmpdir(), 'surfcore-narrative-'));
process.env.SURFCORE_DATA_DIR = data;
const store = await import('../plugin/src/store.mjs');
const { conversationInput } = await import('../plugin/src/codex.mjs');
const day = 86_400_000;

test('time levels, protection, pin and boost preserve source and scope', async () => {
  await store.createCharacter('narrative', '# Narrative');
  const now = Date.now(), file = join(data, 'characters/narrative/qq-10002.jsonl');
  const records = [0, 15, 30, 45, 70].map((days, i) => JSON.stringify({ id: String(i + 1).repeat(24), at: new Date(now - days * day).toISOString(), incoming: '事件'.repeat(200) }));
  const original = records.join('\n') + '\n';
  await writeFile(file, original);
  const states = await store.narrativeInventory('narrative', now);
  assert.deepEqual(states.map(({ clarityLevel }) => clarityLevel), [0, 1, 2, 3, 4]);
  assert.equal(states[0].protectedRecent, true);
  assert.deepEqual(states.map(({ chars }) => chars), [403, 240, 120, 50, 0]);
  assert.ok(states.every(({ characterId, scope, memoryId }) => characterId === 'narrative' && scope === 'qq-10002' && memoryId.length === 24));
  await store.updateMemoryWeight('narrative', 'qq-10002', '4'.repeat(24), 'pin', true);
  assert.equal((await store.narrativeInventory('narrative', now)).find(({ memoryId }) => memoryId[0] === '4').clarityLevel, 0);
  await store.updateMemoryWeight('narrative', 'qq-10002', '3'.repeat(24), 'boost');
  assert.equal((await store.narrativeInventory('narrative')).find(({ memoryId }) => memoryId[0] === '3').clarityLevel, 0);
  assert.deepEqual(await store.narrativeInventory('ming'), []);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('character count preview is stale-safe, persists, protects pins and can restore', async () => {
  await store.createCharacter('narrative-compact', '# Narrative compact');
  const now = Date.now(), file = join(data, 'characters/narrative-compact/qq-10003.jsonl');
  const raw = ['a', 'b'].map((c, i) => JSON.stringify({ id: c.repeat(24), at: new Date(now - (8 + i) * day).toISOString(), incoming: '🟩'.repeat(400) })).join('\n') + '\n';
  await writeFile(file, raw);
  await store.updateMemoryWeight('narrative-compact', 'qq-10003', 'a'.repeat(24), 'pin', true);
  const opts = { maxChars: 500, warnChars: 60000, targetChars: 100 };
  const before = await store.narrativeCapacity('narrative-compact', opts);
  assert.equal(before.full, true);
  const preview = await store.previewNarrativeCompression('narrative-compact', opts);
  assert.equal(preview.reached, false);
  assert.ok(preview.blockedChars > 0);
  assert.deepEqual(preview.changes.map(({ memoryId }) => memoryId), ['b'.repeat(24)]);
  await assert.rejects(store.applyNarrativeCompression('narrative-compact', { ...opts, revision: '0'.repeat(64) }), /重新预览/);
  await store.applyNarrativeCompression('narrative-compact', { ...opts, revision: preview.revision });
  const states = await store.narrativeInventory('narrative-compact');
  assert.equal(states.find(({ memoryId }) => memoryId[0] === 'b').clarityLevel, 4);
  assert.equal(states.find(({ memoryId }) => memoryId[0] === 'a').clarityLevel, 0);
  assert.equal(await readFile(file, 'utf8'), raw);
  await appendFile(join(data, 'characters/narrative-compact/memory-compression.jsonl'), '{bad');
  await store.restoreNarrative('narrative-compact', 'qq-10003', 'b'.repeat(24));
  assert.equal((await store.narrativeInventory('narrative-compact')).find(({ memoryId }) => memoryId[0] === 'b').clarityLevel, 0);
  assert.equal((await store.narrativeCapacity('narrative-compact', { maxChars: 0, warnChars: 50 })).full, false);
});

test('configured automatic compression runs on writes, preserves protected records and survives reread', async () => {
  await store.createCharacter('narrative-auto', '# Auto');
  const file = join(data, 'characters/narrative-auto/qq-10004.jsonl');
  const raw = JSON.stringify({ id: 'c'.repeat(24), at: new Date(Date.now() - 8 * day).toISOString(), incoming: 'x'.repeat(400) }) + '\n';
  await writeFile(file, raw);
  const configured = await store.setNarrativePolicy('narrative-auto', { maxChars: 100, warnChars: 80, auto: false });
  assert.equal(configured.maintenance.applied, false);
  assert.deepEqual(await store.narrativePolicy('narrative-auto'), { maxChars: 100, warnChars: 80, auto: false });
  const enabled = await store.setNarrativePolicy('narrative-auto', { maxChars: 100, warnChars: 80, auto: true });
  assert.equal(enabled.maintenance.applied, true);
  assert.ok(enabled.maintenance.capacity.chars <= 90);
  assert.equal(await readFile(file, 'utf8'), raw);
  await store.addMemory('narrative-auto', 'qq-10004', { incoming: 'n'.repeat(200) });
  const state = await store.narrativeCapacity('narrative-auto', await store.narrativePolicy('narrative-auto'));
  assert.equal(state.full, true);
  assert.ok((await store.narrativeInventory('narrative-auto')).some((row) => row.protectedRecent && row.chars > 100));
  await store.setNarrativePolicy('narrative-auto', { maxChars: 0, warnChars: 1, auto: true });
  assert.equal((await store.narrativeCapacity('narrative-auto', await store.narrativePolicy('narrative-auto'))).full, false);
});

test('narrative preview uses only the selected conversation and permitted notes', async () => {
  await store.createCharacter('narrative-scope', '# Scope');
  await store.addMemory('narrative-scope', 'qq-10002', { incoming: 'private A' });
  await store.addMemory('narrative-scope', 'qq-10003', { incoming: 'private B' });
  await store.addMemory('narrative-scope', 'shared', { note: 'owner only' });
  const preview = await store.memoryRecallPreview('narrative-scope', 'qq-10003');
  assert.deepEqual(preview.narrative.map((row) => row.text), ['来信：private B']);
  const input = conversationInput({ ...preview, recent: [{ incoming: 'secret raw' }] }, 'hello');
  assert.equal(input.includes('secret raw'), false);
  assert.equal(input.includes('private A'), false);
  assert.equal(input.includes('owner only'), false);
  assert.equal(input.includes('private B'), true);
  const owner = await store.memoryRecallPreview('narrative-scope', 'qq-10002', { includeShared: true });
  assert.deepEqual(new Set(owner.narrative.map((row) => row.text)), new Set(['来信：private A', 'owner only']));
});

test('failed maintenance reports the error without losing a saved message', async () => {
  await store.createCharacter('narrative-error', '# Error');
  await writeFile(join(data, 'characters/narrative-error/memory-policy.jsonl'), '{invalid\n');
  const result = await store.addMemory('narrative-error', 'qq-10002', { incoming: 'saved' });
  assert.match(result.maintenanceError, /记忆已保存/);
  assert.equal((await store.readMemory('narrative-error', 'qq-10002'))[0].incoming, 'saved');
});
