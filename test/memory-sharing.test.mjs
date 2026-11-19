import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = await mkdtemp(join(tmpdir(), 'surfcore-sharing-'));
process.env.SURFCORE_DATA_DIR = data;
process.env.SURFCORE_QQ_OWNER = '10001';
const store = await import('../plugin/src/store.mjs');
const { extractMemoryBatch } = await import('../plugin/src/memory-extraction.mjs');
const { conversationInput } = await import('../plugin/src/codex.mjs');

async function extract(role, scope, summary, decision = 'share') {
  return extractMemoryBatch(role, scope, { generate: async ({ message }) => {
    const { records } = JSON.parse(message);
    return JSON.stringify({ candidates: [{ sourceIds: [records[0].sourceId], who: '一位朋友', event: '聊到练习乐器', feeling: '', importance: 2,
      share: { decision, summary } }] });
  } });
}

test('only a screened concept crosses sessions, with role and demo boundaries', async () => {
  await store.createCharacter('share-role', '# Share');
  await store.createCharacter('another-role', '# Another');
  const originalText = '最近我买了一把吉他想要学习';
  await store.addMemory('share-role', 'qq-10002', { incoming: originalText, reply: '祝你练习愉快' });
  await store.addMemory('share-role', 'shared', { note: '主人专用手记' });
  const result = await extract('share-role', 'qq-10002', '有人对练习乐器感兴趣');
  assert.equal(result.candidates[0].share.summary, '有人对练习乐器感兴趣');
  const group = await store.memoryRecallPreview('share-role', 'qq-group-10003');
  assert.deepEqual(group.sharedConcepts.map(({ text }) => text), ['有人对练习乐器感兴趣']);
  assert.equal(group.sharedConcepts[0].originScope, 'qq-10002');
  assert.deepEqual(group.shared, []);
  assert.equal(JSON.stringify(group).includes(originalText), false);
  assert.equal(JSON.stringify(group).includes('主人专用手记'), false);
  await store.activateCharacter('share-role');
  const actual = await store.characterContext('qq-group-10003', { includeShared: false });
  assert.equal(JSON.parse(conversationInput(actual, '你好')).sharedConcepts[0].text, '有人对练习乐器感兴趣');
  assert.deepEqual((await store.memoryRecallPreview('share-role', 'qq-10002')).sharedConcepts, []);
  assert.deepEqual((await store.memoryRecallPreview('share-role', 'demo-10003')).sharedConcepts, []);
  assert.deepEqual((await store.memoryRecallPreview('another-role', 'qq-group-10003')).sharedConcepts, []);
  const input = conversationInput({ narrative: group.narrative, sharedConcepts: group.sharedConcepts }, '你好');
  assert.equal(input.includes(originalText), false);
  assert.equal(JSON.parse(input).sharedConcepts[0].text, '有人对练习乐器感兴趣');
  await store.revokeSharedMemoryConcept('share-role', result.candidates[0].id);
  assert.deepEqual((await store.memoryRecallPreview('share-role', 'qq-group-10003')).sharedConcepts, []);
  assert.equal((await store.extractionStatus('share-role', 'qq-10002')).candidates[0].shareRevoked, true);
});

test('private, unsafe or copied proposals never enter cross-conversation recall', async () => {
  for (const [role, text, summary, decision] of [
    ['share-private', '别告诉其他人，我准备学习吉他', '有人对练习乐器感兴趣', 'share'],
    ['share-unknown', '最近我买了一把吉他想要学习', '有人对练习乐器感兴趣', 'private'],
    ['share-sensitive-summary', '最近我买了一把吉他想要学习', '某人住址在某路 10 号', 'share'],
    ['share-copied', '最近我买了一把吉他想要学习', '最近我买了一把吉他想要学习', 'share'],
  ]) {
    await store.createCharacter(role, '# Test');
    await store.addMemory(role, 'qq-10002', { incoming: text });
    await extract(role, 'qq-10002', summary, decision === undefined ? '' : decision);
    assert.deepEqual((await store.memoryRecallPreview(role, 'qq-10003')).sharedConcepts, [], role);
  }
});

test('screened ordinary summaries default to sharing without duplicating their character allowance', async () => {
  await store.createCharacter('share-default', '# Test');
  const scope = 'qq-10002', event = '开始练习乐器';
  const file = join(data, 'characters/share-default/' + scope + '.jsonl');
  await store.addMemory('share-default', scope, { incoming: '最近我买了一把吉他想要学习' });
  const original = await readFile(file, 'utf8');
  await extractMemoryBatch('share-default', scope, { generate: async ({ message }) => JSON.stringify({ candidates: [{
    sourceIds: [JSON.parse(message).records[0].sourceId], who: '', event, feeling: '', importance: 2,
  }] }) });
  const status = await store.extractionStatus('share-default', scope);
  assert.equal(status.todayCandidates[0].share.derived, true);
  assert.equal(status.todayChars, Array.from(event).length);
  const recall = await store.memoryRecallPreview('share-default', 'qq-group-10003');
  assert.deepEqual(recall.sharedConcepts.map(({ text }) => text), [event]);
  const input = JSON.parse(conversationInput(recall, '你好'));
  assert.equal(input.sharedConcepts[0].memoryId, status.candidates[0].id);
  assert.equal(JSON.stringify(input).includes('qq-10002'), false);
  assert.equal(JSON.stringify(input).includes('最近我买了一把吉他想要学习'), false);
  assert.deepEqual((await store.memoryRecallPreview('share-default', 'demo-10003')).sharedConcepts, []);
  assert.equal(await readFile(file, 'utf8'), original);
  await store.updateMemoryArchive('share-default', scope, status.candidates[0].sourceIds[0], true);
  assert.deepEqual((await store.memoryRecallPreview('share-default', 'qq-10003')).sharedConcepts, []);
  await store.updateMemoryArchive('share-default', scope, status.candidates[0].sourceIds[0], false);
  assert.equal((await store.memoryRecallPreview('share-default', 'qq-10003')).sharedConcepts.length, 1);
  await writeFile(file, original.replace('吉他', '笛子'));
  assert.deepEqual((await store.memoryRecallPreview('share-default', 'qq-10003')).sharedConcepts, []);
  assert.equal((await store.extractionStatus('share-default', scope)).todayChars, Array.from(event).length);
});

test('default sharing retains recompression associations and propagates explicit revocation', async () => {
  await store.createCharacter('share-default-lineage', '# Test');
  const scope = 'qq-10002';
  const generate = async ({ message }) => {
    const input = JSON.parse(message);
    return JSON.stringify({ candidates: [{ sourceIds: input.records.map(({ sourceId }) => sourceId),
      previousCandidateIds: (input.previousCandidates || []).map(({ id }) => id), who: '',
      event: input.previousCandidates?.length ? '持续练习乐器' : '开始练习乐器', feeling: '', importance: 2 }] });
  };
  await store.addMemory('share-default-lineage', scope, { incoming: '最近我买了一把吉他想要学习' });
  const first = await extractMemoryBatch('share-default-lineage', scope, { generate });
  await store.addMemory('share-default-lineage', scope, { incoming: '又练习了两首曲子' });
  await extractMemoryBatch('share-default-lineage', scope, { generate });
  const status = await store.extractionStatus('share-default-lineage', scope);
  assert.equal(status.candidates[0].superseded, true);
  assert.equal(status.todayCandidates[0].sourceIds.length, 2);
  const recall = await store.memoryRecallPreview('share-default-lineage', 'qq-10003');
  assert.deepEqual(recall.sharedConcepts.map(({ text }) => text), ['持续练习乐器']);
  assert.deepEqual(JSON.parse(conversationInput(recall, '你好')).sharedConcepts[0].relatedMemoryIds, [first.candidates[0].id]);
  await store.revokeSharedMemoryConcept('share-default-lineage', first.candidates[0].id);
  assert.deepEqual((await store.memoryRecallPreview('share-default-lineage', 'qq-10003')).sharedConcepts, []);
});

test('cross-conversation summaries may preserve a sourced QQ nickname', async () => {
  await store.createCharacter('known-nickname', '# Test');
  const text = '最近我买了一把吉他想要学习';
  await store.addMemory('known-nickname', 'qq-group-10002', { incoming: text,
    messages: [{ senderId: '1234567', senderNickname: '月亮猫', text }] });
  await extractMemoryBatch('known-nickname', 'qq-group-10002', { owner: '10003', generate: async ({ message }) =>
    JSON.stringify({ candidates: [{ sourceIds: [JSON.parse(message).records[0].sourceId], who: '月亮猫',
      event: '月亮猫开始练习乐器', feeling: '', importance: 2, share: { decision: 'share', summary: '月亮猫开始练习乐器' } }] }) });
  const recall = await store.memoryRecallPreview('known-nickname', 'qq-group-10004');
  assert.deepEqual(recall.sharedConcepts.map(({ text }) => text), ['月亮猫开始练习乐器']);
  assert.equal(JSON.parse(conversationInput(recall, '你好')).sharedConcepts[0].nickname, '月亮猫');
  assert.doesNotMatch(JSON.stringify(conversationInput(recall, '你好')), /1234567|qq-group-10002/);
});

test('default sharing anonymizes the explicit person while keeping internal association', async () => {
  await store.createCharacter('default-person', '# Test');
  await store.addMemory('default-person', 'qq-10002', { incoming: '最近我买了一把吉他想要学习' });
  await extractMemoryBatch('default-person', 'qq-10002', { generate: async ({ message }) => JSON.stringify({ candidates: [{
    sourceIds: [JSON.parse(message).records[0].sourceId], who: '小林', event: '小林开始练习乐器', feeling: '', importance: 2,
  }] }) });
  const recall = await store.memoryRecallPreview('default-person', 'qq-10003');
  assert.deepEqual(recall.sharedConcepts.map(({ text }) => text), ['一位对话者开始练习乐器']);
  assert.equal(JSON.stringify(conversationInput(recall, '你好')).includes('小林'), false);
  assert.equal((await store.extractionStatus('default-person', 'qq-10002')).todayChars, Array.from('小林小林开始练习乐器').length);
});

test('default sharing never bypasses sensitive sources or an explicit private decision', async () => {
  for (const [role, incoming, share] of [
    ['default-sensitive', '别告诉其他人，我准备学习吉他', undefined],
    ['default-denied', '这段别分享给其他人，我开始学钢琴', undefined],
    ['default-private', '准备学习吉他', { decision: 'private', summary: '' }],
    ['default-unknown', '准备学习吉他', { decision: 'unknown', summary: '' }],
    ['default-invalid', '准备学习吉他', null],
  ]) {
    await store.createCharacter(role, '# Test');
    await store.addMemory(role, 'qq-10002', { incoming });
    await extractMemoryBatch(role, 'qq-10002', { generate: async ({ message }) => JSON.stringify({ candidates: [{
      sourceIds: [JSON.parse(message).records[0].sourceId], who: '', event: '练习乐器', feeling: '', importance: 2, share,
    }] }) });
    assert.deepEqual((await store.memoryRecallPreview(role, 'qq-10003')).sharedConcepts, []);
    await store.addMemory(role, 'qq-10002', { incoming: '今天进展顺利' });
    await extractMemoryBatch(role, 'qq-10002', { generate: async ({ message }) => {
      const input = JSON.parse(message);
      return JSON.stringify({ candidates: [{ sourceIds: [input.records[0].sourceId], previousCandidateIds: [input.previousCandidates[0].id],
        who: '', event: '练习有所进展', feeling: '', importance: 2 }] });
    } });
    assert.deepEqual((await store.memoryRecallPreview(role, 'qq-10003')).sharedConcepts, []);
  }
});

test('source changes and source archive remove previously eligible concepts', async () => {
  await store.createCharacter('share-change', '# Test');
  await store.addMemory('share-change', 'qq-10002', { incoming: '最近我买了一把吉他想要学习' });
  const original = await readFile(join(data, 'characters/share-change/qq-10002.jsonl'), 'utf8');
  const { candidates } = await extract('share-change', 'qq-10002', '有人对练习乐器感兴趣');
  assert.equal((await store.memoryRecallPreview('share-change', 'qq-10003')).sharedConcepts.length, 1);
  await store.updateMemoryArchive('share-change', 'qq-10002', candidates[0].sourceIds[0], true);
  assert.deepEqual((await store.memoryRecallPreview('share-change', 'qq-10003')).sharedConcepts, []);
  await store.updateMemoryArchive('share-change', 'qq-10002', candidates[0].sourceIds[0], false);
  const options = { maxChars: 1, warnChars: 1, targetChars: 0, now: Date.now() + 8 * 86_400_000 };
  const preview = await store.previewNarrativeCompression('share-change', options);
  await store.applyNarrativeCompression('share-change', { ...options, revision: preview.revision });
  assert.deepEqual((await store.memoryRecallPreview('share-change', 'qq-10003')).sharedConcepts, []);
  await store.restoreNarrative('share-change', 'qq-10002', candidates[0].sourceIds[0]);
  await writeFile(join(data, 'characters/share-change/qq-10002.jsonl'), original.replace('吉他', '笛子'));
  assert.deepEqual((await store.memoryRecallPreview('share-change', 'qq-10003')).sharedConcepts, []);
  assert.equal((await store.extractionStatus('share-change', 'qq-10002')).todayChars,
    Array.from('一位朋友聊到练习乐器有人对练习乐器感兴趣').length);
});

test('old extraction without explicit sharing remains unavailable', async () => {
  await store.createCharacter('share-old', '# Test');
  await store.addMemory('share-old', 'qq-10002', { incoming: '今天一起听了音乐' });
  const { batch } = await store.extractionStatus('share-old', 'qq-10002');
  await appendFile(join(data, 'characters/share-old/memory-extractions.jsonl'), JSON.stringify({ version: 1, scope: 'qq-10002', sourceIds: [batch[0].sourceId],
    candidates: [{ id: 'old', sourceIds: [batch[0].sourceId], who: '', event: '听音乐', feeling: '', importance: 1 }] }) + '\n');
  assert.equal((await store.extractionStatus('share-old', 'qq-10002')).candidates[0].privacy.status, 'unassessed');
  assert.deepEqual((await store.memoryRecallPreview('share-old', 'qq-10003')).sharedConcepts, []);
});

test('corrupt revocation state never falls back to allowing shared recall', async () => {
  await store.createCharacter('share-corrupt', '# Test');
  await store.addMemory('share-corrupt', 'qq-10002', { incoming: '最近我买了一把吉他想要学习' });
  await extract('share-corrupt', 'qq-10002', '有人对练习乐器感兴趣');
  await writeFile(join(data, 'characters/share-corrupt/memory-sharing-revoked.jsonl'), '{}\n');
  await assert.rejects(store.memoryRecallPreview('share-corrupt', 'qq-10003'), /撤销记录损坏/);
});
