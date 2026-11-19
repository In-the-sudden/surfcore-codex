import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SURFCORE_DATA_DIR = await mkdtemp(join(tmpdir(), 'surfcore-memory-auto-'));
const store = await import('../plugin/src/store.mjs');
const { autoExtractMemory } = await import('../plugin/src/memory-extraction.mjs');

test('ten pending records trigger immediately and each scope retains its own pending items', async () => {
  await store.createCharacter('automatic', '# Automatic');
  for (let index = 0; index < 10; index++) await store.addMemory('automatic', 'qq-10002', { incoming: '消息' + index, reply: '收到' });
  await store.addMemory('automatic', 'qq-10003', { incoming: '另一会话', reply: '收到' });
  let calls = 0;
  const result = await autoExtractMemory('automatic', 'qq-10002', { owner: '10001', generate: async ({ message }) => {
    calls++;
    const input = JSON.parse(message);
    assert.equal(input.maxChars, 100);
    assert.equal(input.records.length, 10);
    return JSON.stringify({ candidates: [{ sourceIds: [input.records[0].sourceId], who: '', event: '记住一件事', feeling: '', importance: 2 }] });
  } });
  assert.equal(result.processed, 10);
  assert.equal(calls, 1);
  assert.equal((await store.extractionStatus('automatic', 'qq-10003')).pending, 1);
});

test('under ten waits two hours and oversize summaries stay pending', async () => {
  await store.createCharacter('automatic-wait', '# Automatic wait');
  await store.addMemory('automatic-wait', 'qq-10004', { incoming: '一条', reply: '回复' });
  const now = Date.now();
  assert.equal((await autoExtractMemory('automatic-wait', 'qq-10004', { owner: '10001', now })).reason, 'waiting');
  const future = now + 2 * 60 * 60 * 1000;
  const result = await autoExtractMemory('automatic-wait', 'qq-10004', { owner: '10001', now: future, generate: async ({ message }) => {
    const input = JSON.parse(message);
    return JSON.stringify({ candidates: [{ sourceIds: [input.records[0].sourceId], who: '', event: '长'.repeat(101), feeling: '', importance: 1 }] });
  } });
  assert.match(result.error, /额度|日期/);
  assert.equal((await store.extractionStatus('automatic-wait', 'qq-10004')).pending, 1);
});

test('a full daily allowance recompresses previous summaries and new records within the same limit', async () => {
  await store.createCharacter('automatic-limit', '# Automatic limit');
  const now = Date.now();
  for (let index = 0; index < 10; index++) await store.addMemory('automatic-limit', 'qq-10005', { incoming: '一条' + index, reply: '回复' });
  const first = await autoExtractMemory('automatic-limit', 'qq-10005', { owner: '10001', now, generate: async ({ message }) => {
    const input = JSON.parse(message);
    return JSON.stringify({ candidates: [{ sourceIds: [input.records[0].sourceId], who: '', event: '字'.repeat(100), feeling: '', importance: 1 }] });
  } });
  assert.equal(first.processed, 10);
  for (let index = 0; index < 10; index++) await store.addMemory('automatic-limit', 'qq-10005', { incoming: '下一条' + index, reply: '回复' });
  const second = await autoExtractMemory('automatic-limit', 'qq-10005', { owner: '10001', now, generate: async ({ message }) => {
    const input = JSON.parse(message);
    assert.equal(input.maxChars, 100);
    assert.equal(input.records.length, 10);
    assert.equal(input.previousCandidates[0].event, '字'.repeat(100));
    return JSON.stringify({ candidates: [{ sourceIds: [input.records[0].sourceId], previousCandidateIds: [input.previousCandidates[0].id],
      who: '', event: '合'.repeat(100), feeling: '', importance: 1 }] });
  } });
  assert.equal(second.processed, 10);
  assert.equal(second.merged, true);
  assert.equal(second.remaining, 0);
  const status = await store.extractionStatus('automatic-limit', 'qq-10005');
  assert.equal(status.pending, 0);
  assert.equal(status.todayChars, 100);
  assert.equal(status.candidates.length, 2);
  assert.equal(status.candidates[0].superseded, true);
  assert.equal(status.todayCandidates.length, 1);
  assert.equal(status.todayCandidates[0].sourceIds.length, 2);
});

test('bridge resumes pending extraction after pause without requiring a new message', async () => {
  const { createMessageHandler } = await import('../plugin/src/bridge.mjs');
  const scope = 'qq-10001';
  await store.addMemory('lin', scope, { incoming: '待压缩的记录' });
  const timers = new Set();
  let paused = false, generation = 0, calls = 0;
  const handle = createMessageHandler({ owner: '10001', selfId: '10002',
    shouldContinue: () => !paused, generationToken: () => generation,
    autoExtract: async (characterId, pendingScope) => {
      assert.equal(characterId, 'lin');
      assert.equal(pendingScope, scope);
      calls++;
      return { triggered: true, pending: 0 };
    },
    scheduleTimer: (callback) => { timers.add(callback); return callback; },
    cancelTimer: (timer) => timers.delete(timer),
  });
  const fire = () => {
    const [callback] = timers;
    if (callback) { timers.delete(callback); callback(); }
  };
  try {
    await handle.resumeExtractions();
    paused = true; generation++;
    fire();
    assert.equal(calls, 0);
    paused = false;
    fire();
    await Promise.resolve();
    assert.equal(calls, 1);
  } finally { await handle.close(); }
});

test('consent does not schedule group extraction when group participation is disabled', async () => {
  const { createMessageHandler, sampleEvent } = await import('../plugin/src/bridge.mjs');
  const timers = new Set();
  const handle = createMessageHandler({ owner: '10002', selfId: '10001', groups: ['10003'],
    social: { enabled: false }, deliver: async () => {}, autoExtract: async () => {},
    scheduleTimer: (callback) => { timers.add(callback); return callback; },
    cancelTimer: (callback) => timers.delete(callback),
  });
  try {
    assert.equal((await handle(sampleEvent('同意群聊'))).effective, false);
    assert.equal(timers.size, 0);
  } finally { await handle.close(); }
});

test('status reports when automatic model compression is in progress and when it will retry', async () => {
  const { memoryExtractionStatus } = await import('../plugin/src/memory-extraction.mjs');
  await store.createCharacter('automatic-status', '# Status');
  const scope = 'qq-group-10004', owner = '10001';
  for (let index = 0; index < 10; index++) await store.addMemory('automatic-status', scope, { incoming: '待处理' + index });
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const returned = new Promise((resolve) => { release = resolve; });
  const attempt = autoExtractMemory('automatic-status', scope, { owner, generate: async () => { entered(); return returned; } });
  try {
    await started;
    const status = await memoryExtractionStatus('automatic-status', scope, { owner });
    assert.equal(status.automatic.state, 'running');
    assert.equal(status.pending, 10);
  } finally {
    release('invalid JSON');
    await attempt;
  }
  const retry = await memoryExtractionStatus('automatic-status', scope, { owner });
  assert.equal(retry.automatic.state, 'retry');
  assert.ok(Date.parse(retry.automatic.dueAt) > Date.parse(retry.automatic.lastFailureAt));
  assert.equal(retry.pending, 10);
});
