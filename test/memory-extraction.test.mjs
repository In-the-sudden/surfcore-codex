import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = await mkdtemp(join(tmpdir(), 'surfcore-extraction-'));
process.env.SURFCORE_DATA_DIR = data;
process.env.SURFCORE_QQ_OWNER = '10001';
const store = await import('../plugin/src/store.mjs');
const { extractMemoryBatch } = await import('../plugin/src/memory-extraction.mjs');

test('batch preserves provenance and scope, and successful processing is idempotent', async () => {
  await store.createCharacter('extract', '# Extract');
  await store.addMemory('extract', 'qq-group-10001', { incoming: '我今天很开心', reply: '太好了', messages: [{ senderId: '10002', messageId: '5', text: '我今天很开心' }] });
  await store.addMemory('extract', 'qq-10002', { incoming: 'private secret' });
  const file = join(data, 'characters/extract/qq-group-10001.jsonl');
  const original = await readFile(file, 'utf8');
  let calls = 0;
  const generate = async ({ message, extractionMode }) => {
    calls++;
    assert.equal(extractionMode, true);
    assert.equal(message.includes('private secret'), false);
    const { records } = JSON.parse(message);
    assert.equal(records[0].messages[0].senderId, '10002');
    return JSON.stringify({ candidates: [{ sourceIds: [records[0].sourceId], who: '10002', event: '今天开心', feeling: '开心', importance: 2 }] });
  };
  const result = await extractMemoryBatch('extract', 'qq-group-10001', { generate });
  assert.equal(result.processed, 1);
  assert.equal(result.candidates[0].feeling, '开心');
  assert.equal((await extractMemoryBatch('extract', 'qq-group-10001', { generate })).processed, 0);
  assert.equal(calls, 1);
  assert.equal((await store.extractionStatus('extract', 'qq-10002')).pending, 1);
  assert.equal((await store.extractionStatus('extract', 'qq-10002')).candidates.length, 0);
  assert.equal(await readFile(file, 'utf8'), original);
  const preview = await store.memoryRecallPreview('extract', 'qq-10002');
  assert.deepEqual(preview.sharedConcepts.map(({ text }) => text), ['今天开心']);
  assert.equal(JSON.stringify(preview.narrative).includes('今天开心'), false);
  assert.equal(JSON.stringify(preview).includes('我今天很开心'), false);
});

test('failed model, malformed output and invented sources stay pending for retry', async () => {
  await store.createCharacter('retry', '# Retry');
  await store.addMemory('retry', 'qq-10002', { incoming: '旧记录没有说话者元数据' });
  const failure = async () => { throw new Error('额度不足'); };
  await assert.rejects(extractMemoryBatch('retry', 'qq-10002', { generate: failure }), /额度不足/);
  await assert.rejects(extractMemoryBatch('retry', 'qq-10002', { generate: async () => 'not JSON' }), /JSON/);
  await assert.rejects(extractMemoryBatch('retry', 'qq-10002', { generate: async () => JSON.stringify({ candidates: [{ sourceIds: ['other'], who: '', event: '事件', feeling: '', importance: 1 }] }) }), /来源/);
  assert.equal((await store.extractionStatus('retry', 'qq-10002')).pending, 1);
  await extractMemoryBatch('retry', 'qq-10002', { generate: async ({ message }) => {
    const { records } = JSON.parse(message);
    assert.equal(records[0].messages, undefined);
    return JSON.stringify({ candidates: [{ sourceIds: [records[0].sourceId], who: '', event: '旧记录', feeling: '', importance: 1 }] });
  } });
  assert.equal((await store.extractionStatus('retry', 'qq-10002')).pending, 0);
});

test('overlapping work and changed sources cannot commit duplicate or stale results', async () => {
  await store.createCharacter('conflict', '# Conflict');
  await store.addMemory('conflict', 'qq-10002', { incoming: 'original' });
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const first = extractMemoryBatch('conflict', 'qq-10002', { generate: async () => { entered(); await waiting; return '{"candidates":[]}'; } });
  await enteredPromise;
  await assert.rejects(extractMemoryBatch('conflict', 'qq-10002', { generate: async () => '{}' }), /正在提炼/);
  release();
  await first;
  assert.equal((await store.extractionStatus('conflict', 'qq-10002')).processed, 1);
  await assert.rejects(store.extractionStatus('conflict', 'shared'), /共享/);
});

test('changed content fails the commit and an interrupted append remains retryable', async () => {
  await store.createCharacter('recovery', '# Recovery');
  await store.addMemory('recovery', 'qq-10002', { incoming: 'before' });
  const file = join(data, 'characters/recovery/qq-10002.jsonl');
  const original = await readFile(file, 'utf8');
  await assert.rejects(extractMemoryBatch('recovery', 'qq-10002', { generate: async () => {
    await writeFile(file, original.replace('before', 'after'));
    return '{"candidates":[]}';
  } }), /来源内容已更改/);
  assert.equal((await store.extractionStatus('recovery', 'qq-10002')).pending, 1);
  await appendFile(join(data, 'characters/recovery/memory-extractions.jsonl'), '{"version":1');
  await extractMemoryBatch('recovery', 'qq-10002', { generate: async () => '{"candidates":[]}' });
  assert.equal((await store.extractionStatus('recovery', 'qq-10002')).pending, 0);
});

test('model-filled fields reach memory cards and same-group recall without sharing the named actor', async () => {
  await store.createCharacter('model-memory', '# Memory');
  const scope = 'qq-group-10003', destination = 'qq-group-10004';
  await store.addMemory('model-memory', scope, {
    incoming: '我给社区合唱团报名了，本来考虑了好几周，今天终于报上了。', reply: '祝排练顺利。',
    messages: [{ senderId: '10005', messageId: '8', text: '我给社区合唱团报名了，本来考虑了好几周，今天终于报上了。' }],
  });
  const { candidates: [first] } = await extractMemoryBatch('model-memory', scope, { generate: async ({ message }) => {
    const { records } = JSON.parse(message);
    return JSON.stringify({ candidates: [{ sourceIds: [records[0].sourceId], who: '10005', event: '报名参加社区合唱团', feeling: '', importance: 2,
      share: { decision: 'share', summary: '有人开始参加合唱活动' } }] });
  } });
  const { items: [row] } = await store.listMemoryPage('model-memory', { scope });
  assert.deepEqual(row.modelCards.map(({ who, event }) => ({ who, event })), [{ who: '10005', event: '报名参加社区合唱团' }]);
  const current = await store.memoryRecallPreview('model-memory', scope);
  assert.deepEqual(current.narrative.map(({ text }) => text), ['人物：10005；事件：报名参加社区合唱团']);
  const modelInput = (await import('../plugin/src/codex.mjs')).conversationInput;
  const other = JSON.parse(modelInput(await store.memoryRecallPreview('model-memory', destination), '对方聊到合唱'));
  assert.deepEqual(other.sharedConcepts, [{ memoryId: first.id, text: '有人开始参加合唱活动' }]);
  assert.equal(JSON.stringify(other).includes('10005'), false);
  await store.updateMemoryCard('model-memory', scope, row.id, { who: '合唱团新成员', event: '已完成报名' });
  assert.deepEqual((await store.memoryRecallPreview('model-memory', scope)).narrative.map(({ text }) => text), ['人物：合唱团新成员；事件：已完成报名']);
});

test('revoked authorization prevents an in-flight model result from being committed', async () => {
  await store.createCharacter('revoked-model-memory', '# Memory');
  const scope = 'qq-group-10004';
  await store.addMemory('revoked-model-memory', scope, { incoming: '等待获准处理的记录' });
  let authorized = true;
  await assert.rejects(extractMemoryBatch('revoked-model-memory', scope, { canCommit: () => authorized,
    generate: async () => { authorized = false; return '{"candidates":[]}'; } }), /提炼已取消/);
  assert.equal((await store.extractionStatus('revoked-model-memory', scope)).pending, 1);
});

test('replies informed by cross-conversation recall stay local during subsequent extraction', async () => {
  const role = 'shared-reply-memory', source = 'qq-group-10004', destination = 'qq-10002';
  await store.createCharacter(role, '# Memory');
  await store.activateCharacter(role);
  await store.addMemory(role, source, { incoming: '我今天报名了一个社区音乐活动。' });
  const sharedText = '有人开始参加合唱活动';
  const { candidates: [candidate] } = await extractMemoryBatch(role, source, { generate: async ({ message }) => {
    const { records } = JSON.parse(message);
    return JSON.stringify({ candidates: [{ sourceIds: [records[0].sourceId], who: '', event: '报名合唱活动', feeling: '', importance: 2,
      share: { decision: 'share', summary: sharedText } }] });
  } });
  const { createMessageHandler, sampleEvent } = await import('../plugin/src/bridge.mjs');
  const handle = createMessageHandler({ owner: '10002', selfId: '10001', deliver: async () => {},
    generate: async ({ role: context }) => context.sharedConcepts[0].text });
  try {
    await handle(sampleEvent('最近有什么事？', 100));
    await store.revokeSharedMemoryConcept(role, candidate.id);
    await extractMemoryBatch(role, destination, { generate: async ({ message }) => {
      const { records } = JSON.parse(message);
      assert.equal(records[0].incoming, '最近有什么事？');
      assert.equal(records[0].reply, undefined);
      return '{"candidates":[]}';
    } });
    assert.equal((await store.readMemory(role, destination))[0].reply, sharedText);
  } finally { await handle.close(); }
});
