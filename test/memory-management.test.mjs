import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = await mkdtemp(join(tmpdir(), 'surfcore-memory-'));
process.env.SURFCORE_DATA_DIR = data;
const store = await import('../plugin/src/store.mjs');

test('importance slows decay, extends recall, and protects higher weight during cleanup', async () => {
  await store.createCharacter('clarity-test', '# Clarity test');
  const file = join(data, 'characters/clarity-test/qq-10002.jsonl');
  const at = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const raw = [1, 2, 3].map((n) => JSON.stringify({ id: String(n).repeat(24), at, incoming: 'memory ' + n, reply: 'ok' })).join('\n') + '\n';
  await writeFile(file, raw);
  await store.updateMemoryCard('clarity-test', 'qq-10002', '2'.repeat(24), { importance: 2 });
  await store.updateMemoryCard('clarity-test', 'qq-10002', '3'.repeat(24), { importance: 3 });
  await store.updateMemoryCard('clarity-test', 'qq-10002', '3'.repeat(24), { who: 'A' });
  const items = (await store.listMemoryPage('clarity-test', { scope: 'qq-10002' })).items;
  const rows = Object.fromEntries(items.map((row) => [row.id[0], row]));
  assert.equal(rows[1].importance, 1);
  assert.ok(rows[1].weight < rows[2].weight && rows[2].weight < rows[3].weight);
  assert.equal(rows[1].clarity, '印象');
  assert.equal(rows[3].clarity, '较清楚');
  assert.deepEqual((await store.readMemory('clarity-test', 'qq-10002')).map((row) => row.id[0]), ['2', '3']);
  await assert.rejects(store.updateMemoryCard('clarity-test', 'qq-10002', '1'.repeat(24), { importance: 4 }), /重要程度/);
  await store.compactMemory('clarity-test', { maxRecords: 2, targetRecords: 2 });
  const after = (await store.listMemoryPage('clarity-test', { scope: 'qq-10002' })).items;
  assert.deepEqual(after.filter((row) => row.archived).map((row) => row.id[0]), ['1']);
  assert.equal(await readFile(file, 'utf8'), raw);
});

test('structured cards preserve legacy records, support edits and stay with their source scope', async () => {
  await store.createCharacter('card-test', '# Card test');
  const file = join(data, 'characters/card-test/qq-10002.jsonl');
  const original = JSON.stringify({ at: new Date().toISOString(), incoming: 'hello', reply: 'hi' }) + '\n';
  await writeFile(file, original);
  const item = (await store.listMemoryPage('card-test', { scope: 'qq-10002' })).items[0];
  await store.updateMemoryCard('card-test', item.scope, item.id, { who: 'A', event: 'visited', feeling: 'happy' });
  await store.updateMemoryCard('card-test', item.scope, item.id, { who: 'A', event: 'returned', feeling: 'calm' });
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal((await store.listMemoryPage('card-test', { search: 'returned' })).items[0].id, item.id);
  assert.deepEqual((await store.readMemory('card-test', item.scope))[0].card, { who: 'A', event: 'returned', feeling: 'calm' });
  assert.deepEqual(await store.readMemory('card-test', 'qq-10003'), []);
  await assert.rejects(store.updateMemoryCard('card-test', 'qq-10003', item.id, {}), /找不到/);
  await assert.rejects(store.updateMemoryCard('card-test', item.scope, item.id, { feeling: 'x'.repeat(501) }), /500/);
});

test('memory search and paging include older entries and preserve scopes', async () => {
  await store.listCharacters();
  const lines = Array.from({ length: 215 }, (_, index) => JSON.stringify({
    at: new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString(),
    incoming: index === 0 ? 'Old unique message' : 'message ' + index,
    reply: 'ok',
  }));
  await writeFile(join(data, 'characters/lin/qq-10002.jsonl'), lines.join('\n') + '\n');
  await store.addMemory('lin', 'qq-group-10003', { incoming: 'group message', reply: 'ok' });
  await store.addMemory('ming', 'qq-10002', { incoming: 'other role message', reply: 'ok' });

  const first = await store.listMemoryPage('lin', { scope: 'qq-10002', limit: 50 });
  assert.equal(first.total, 215);
  assert.equal(first.scopeCounts['qq-group-10003'], 1);
  assert.equal(first.items.length, 50);
  assert.ok(first.items.every((item) => item.scope === 'qq-10002'));
  const last = await store.listMemoryPage('lin', { scope: 'qq-10002', offset: 200, limit: 50 });
  assert.equal(last.items.length, 15);
  assert.equal(last.items.at(-1).incoming, 'Old unique message');
  const found = await store.listMemoryPage('lin', { search: 'OLD UNIQUE' });
  assert.equal(found.total, 1);
  assert.equal(found.items[0].scope, 'qq-10002');
  assert.equal((await store.listMemoryPage('ming', { search: 'unique' })).total, 0);
  await assert.rejects(store.listMemoryPage('lin', { scope: '../outside' }), /范围/);
  await assert.rejects(store.listMemoryPage('lin', { offset: -1 }), /分页/);
});

test('recall preview uses live selection rules and does not mix roles or scopes', async () => {
  await store.addMemory('lin', 'shared', { note: 'private shared note' });
  await store.addMemory('lin', 'qq-10004', { incoming: 'private message', reply: 'private response' });
  await store.addMemory('lin', 'qq-group-10004', { incoming: 'group message', reply: 'group response' });
  const group = await store.memoryRecallPreview('lin', 'qq-group-10004');
  assert.deepEqual(group.shared, []);
  assert.equal(group.recent.length, 1);
  assert.equal(group.recent[0].incoming, 'group message');
  const owner = await store.memoryRecallPreview('lin', 'qq-10004', { includeShared: true });
  assert.equal(owner.shared[0].note, 'private shared note');
  assert.equal(owner.recent[0].incoming, 'private message');
  assert.deepEqual((await store.memoryRecallPreview('ming', 'qq-10004', { includeShared: true })).shared, []);
  await assert.rejects(store.memoryRecallPreview('lin', 'shared'), /对话范围/);
  await assert.rejects(store.memoryRecallPreview('lin', '../outside'), /范围/);
});

test('memory weights decay, boost, and pin independently within one role and scope', async () => {
  await writeFile(join(data, 'characters/lin/qq-10005.jsonl'), JSON.stringify({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', at: '2026-08-01T00:00:00Z', incoming: 'old but useful', reply: 'ok',
  }) + '\n');
  const [row] = (await store.listMemoryPage('lin', { scope: 'qq-10005' })).items;
  assert.equal(row.weight, 0);
  await store.updateMemoryWeight('lin', row.scope, row.id, 'boost');
  assert.equal((await store.listMemoryPage('lin', { scope: 'qq-10005' })).items[0].weight, 100);
  await store.updateMemoryWeight('lin', row.scope, row.id, 'pin', true);
  await store.updateMemoryWeight('lin', row.scope, row.id, 'boost', false);
  const [pinned] = (await store.listMemoryPage('lin', { scope: 'qq-10005' })).items;
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.weight, 100);
  assert.equal((await store.readMemory('lin', 'qq-10005')).length, 1);
  await store.updateMemoryWeight('lin', row.scope, row.id, 'pin', false);
  assert.equal((await store.listMemoryPage('lin', { scope: 'qq-10005' })).items[0].pinned, false);
  assert.equal((await store.readMemory('lin', 'qq-10005')).length, 1);
});

test('archiving preserves legacy records and isolates roles and scopes; restoring resumes recall', async () => {
  const legacy = JSON.stringify({ at: new Date().toISOString(), incoming: 'legacy memory', reply: 'ok' }) + '\n';
  const path = join(data, 'characters/lin/qq-10006.jsonl');
  await writeFile(path, legacy);
  await writeFile(join(data, 'characters/lin/qq-10007.jsonl'), legacy);
  await writeFile(join(data, 'characters/ming/qq-10006.jsonl'), legacy);
  const [item] = (await store.listMemoryPage('lin', { scope: 'qq-10006' })).items;
  assert.equal(item.archived, false);
  assert.equal((await store.readMemory('lin', item.scope)).length, 1);

  await store.updateMemoryArchive('lin', item.scope, item.id, true);
  assert.equal(await readFile(path, 'utf8'), legacy);
  assert.equal((await store.listMemoryPage('lin', { scope: item.scope })).items[0].archived, true);
  assert.deepEqual(await store.readMemory('lin', item.scope), []);
  assert.deepEqual((await store.memoryRecallPreview('lin', item.scope)).recent, []);
  assert.equal((await store.readMemory('lin', 'qq-10007')).length, 1);
  assert.equal((await store.readMemory('ming', item.scope)).length, 1);

  await store.updateMemoryArchive('lin', item.scope, item.id, false);
  assert.equal((await store.listMemoryPage('lin', { scope: item.scope })).items[0].archived, false);
  assert.equal((await store.memoryRecallPreview('lin', item.scope)).recent[0].incoming, 'legacy memory');
  assert.equal(await readFile(path, 'utf8'), legacy);
});

test('permanently pinned memories cannot be archived until unpinned', async () => {
  await store.addMemory('lin', 'qq-10008', { incoming: 'important', reply: 'ok' });
  const [item] = (await store.listMemoryPage('lin', { scope: 'qq-10008' })).items;
  await store.updateMemoryWeight('lin', item.scope, item.id, 'pin', true);
  await assert.rejects(store.updateMemoryArchive('lin', item.scope, item.id, true), /取消永久固定/);
  assert.equal((await store.listMemoryPage('lin', { scope: item.scope })).items[0].archived, false);
  assert.equal((await store.readMemory('lin', item.scope)).length, 1);
  await store.updateMemoryWeight('lin', item.scope, item.id, 'pin', false);
  await store.updateMemoryArchive('lin', item.scope, item.id, true);
  assert.deepEqual(await store.readMemory('lin', item.scope), []);
  await assert.rejects(store.updateMemoryWeight('lin', item.scope, item.id, 'pin', true), /恢复记忆/);
  await assert.rejects(store.updateMemoryArchive('lin', item.scope, item.id, 'true'), /归档状态/);
});

test('capacity compaction archives low-weight records, protects pins and preserves source lines', async () => {
  const role = 'capacity';
  await store.createCharacter(role, '# 容量测试角色');
  const path = join(data, 'characters', role, 'qq-group-10009.jsonl');
  const now = Date.now();
  const lines = Array.from({ length: 205 }, (_, index) => JSON.stringify({
    id: index.toString(16).padStart(24, '0'),
    at: new Date(now - (205 - index) * 60_000).toISOString(),
    incoming: 'capacity record ' + index,
    reply: 'ok',
  }));
  const raw = lines.join('\n') + '\n';
  await writeFile(path, raw);
  await store.updateMemoryWeight(role, 'qq-group-10009', '000000000000000000000000', 'pin', true);

  const before = await store.memoryCapacity(role);
  assert.equal(before.active, 205);
  assert.equal(before.maxRecords, 200);
  assert.equal(before.targetRecords, 160);
  assert.equal(before.overCapacity, 5);
  assert.equal(before.pinned, 1);

  const result = await store.compactMemory(role);
  assert.equal(result.archived, 45);
  assert.equal(result.protectedPinned, 1);
  assert.equal(result.capacity.active, 160);
  assert.equal(await readFile(path, 'utf8'), raw);
  const recalled = await store.readMemory(role, 'qq-group-10009', { limit: 200, maxDays: Infinity });
  assert.equal(recalled.length, 160);
  assert.ok(recalled.some((row) => row.id === '000000000000000000000000'));

  const firstArchived = (await store.listMemoryPage(role, { scope: 'qq-group-10009', limit: 200 })).items.find((row) => row.archived);
  await store.updateMemoryArchive(role, firstArchived.scope, firstArchived.id, false);
  assert.equal((await store.memoryCapacity(role)).active, 161);
});

test('capacity compaction is a no-op below and at the active limit', async () => {
  for (const count of [199, 200]) {
    const role = count === 199 ? 'capacity-under' : 'capacity-at';
    await store.createCharacter(role, '# 容量无操作角色');
    const path = join(data, 'characters', role, 'qq-group-10010.jsonl');
    const lines = Array.from({ length: count }, (_, index) => JSON.stringify({
      id: (index + 1).toString(16).padStart(24, '0'),
      at: new Date(Date.now() - index * 60_000).toISOString(),
      incoming: 'within capacity ' + index,
      reply: 'ok',
    }));
    const raw = lines.join('\n') + '\n';
    await writeFile(path, raw);

    const before = await store.memoryCapacity(role);
    assert.equal(before.active, count);
    assert.equal(before.overCapacity, 0);
    const result = await store.compactMemory(role);
    assert.equal(result.archived, 0);
    assert.equal(result.capacity.active, count);
    assert.equal(await readFile(path, 'utf8'), raw);
    assert.equal((await store.readMemory(role, 'qq-group-10010', { limit: 200, maxDays: Infinity })).length, count);
  }
});
