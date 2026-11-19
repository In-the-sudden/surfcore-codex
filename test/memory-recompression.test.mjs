import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const data = await mkdtemp(join(tmpdir(), 'surfcore-recompression-'));
process.env.SURFCORE_DATA_DIR = data;
const store = await import('../plugin/src/store.mjs');
const { extractMemoryBatch } = await import('../plugin/src/memory-extraction.mjs');
const { memoryDay } = await import('../plugin/src/memory-daily-policy.mjs');
const owner = '10001', scope = 'qq-10002';
const candidate = (sourceIds, event, previousCandidateIds = [], share) => ({ sourceIds, previousCandidateIds, who: '', event, feeling: '', importance: 2, ...(share ? { share } : {}) });
const output = (...candidates) => JSON.stringify({ candidates });
const extract = (role, generate, extra = {}) => extractMemoryBatch(role, scope, { owner, generate, ...extra });
async function seed(role, text = '最近开始学习吉他') {
  await store.createCharacter(role, '# Test');
  await store.addMemory(role, scope, { incoming: text, reply: '慢慢练习' });
}

test('manual extraction obeys final Unicode character allowance and preserves failed work', async () => {
  await seed('manual-limit');
  await assert.rejects(extract('manual-limit', async ({ message }) => {
    const input = JSON.parse(message);
    assert.equal(input.maxChars, 100);
    return output(candidate([input.records[0].sourceId], '字'.repeat(101)));
  }), /今日额度/);
  assert.equal((await store.extractionStatus('manual-limit', scope)).pending, 1);
  const result = await extract('manual-limit', async ({ message }) => output(candidate([JSON.parse(message).records[0].sourceId], '字'.repeat(100))));
  assert.equal(result.todayChars, 100);
  await store.addMemory('manual-limit', scope, { incoming: '又练了一次' });
  const file = join(data, 'characters/manual-limit/' + scope + '.jsonl');
  const original = await readFile(file, 'utf8');
  await assert.rejects(extract('manual-limit', async ({ message }) => {
    const input = JSON.parse(message);
    return output(candidate([input.records[0].sourceId], '长'.repeat(101), [input.previousCandidates[0].id]));
  }), /今日额度/);
  assert.equal((await store.extractionStatus('manual-limit', scope)).todayChars, 100);
  const merged = await extract('manual-limit', async ({ message }) => {
    const input = JSON.parse(message);
    return output(candidate([input.records[0].sourceId], '\u{1f600}'.repeat(100), [input.previousCandidates[0].id]));
  });
  assert.equal(merged.todayChars, 100);
  assert.equal(await readFile(file, 'utf8'), original);
});

test('owner summaries have no daily cap and private source content still cannot cross conversations', async () => {
  await store.createCharacter('owner-private', '# Test');
  const ownerScope = 'qq-' + owner;
  await store.addMemory('owner-private', ownerScope, { incoming: '别告诉别人，今天我去了医院。' });
  const result = await extractMemoryBatch('owner-private', ownerScope, { owner, generate: async ({ message }) => {
    const input = JSON.parse(message);
    assert.equal('maxChars' in input, false);
    return output(candidate([input.records[0].sourceId], '事'.repeat(400), [], { decision: 'share', summary: '有人今天出门了' }));
  } });
  assert.equal(result.remaining, null);
  assert.equal(result.candidates[0].privacy.status, 'restricted');
  assert.equal(result.candidates[0].share, undefined);
  assert.deepEqual((await store.memoryRecallPreview('owner-private', 'qq-10003')).sharedConcepts, []);
});

test('replacement removes old shared recall, keeps lineage beyond twenty records and honors ancestor revocation', async () => {
  await seed('lineage');
  const first = await extract('lineage', async ({ message }) => output(candidate([JSON.parse(message).records[0].sourceId], '练习吉他', [], { decision: 'share', summary: '有人对练习乐器感兴趣' })));
  for (let index = 0; index < 3; index++) {
    for (let row = 0; row < 10; row++) await store.addMemory('lineage', scope, { incoming: '练习进度' + index + '-' + row });
    await extract('lineage', async ({ message }) => {
      const input = JSON.parse(message);
      assert.equal(input.previousCandidates.length, 1);
      return output(candidate(input.records.map((row) => row.sourceId), '持续练习乐器', [input.previousCandidates[0].id], { decision: 'share', summary: '练习乐器需要持续投入' }));
    });
  }
  const status = await store.extractionStatus('lineage', scope);
  assert.equal(status.todayCandidates[0].sourceIds.length, 31);
  const recall = await store.memoryRecallPreview('lineage', 'qq-10003');
  assert.deepEqual(recall.sharedConcepts.map((concept) => concept.text), ['练习乐器需要持续投入']);
  await store.revokeSharedMemoryConcept('lineage', first.candidates[0].id);
  assert.deepEqual((await store.memoryRecallPreview('lineage', 'qq-10003')).sharedConcepts, []);
  await store.addMemory('lineage', scope, { incoming: '继续练习' });
  const after = await extract('lineage', async ({ message }) => {
    const input = JSON.parse(message);
    return output(candidate([input.records[0].sourceId], '继续练习乐器', [input.previousCandidates[0].id], { decision: 'share', summary: '有人正在培养乐器爱好' }));
  });
  assert.equal(after.candidates[0].share, undefined);
});

test('private parents cannot become shared through summary recompression', async () => {
  await seed('private-parent', '别告诉别人，我准备练习吉他');
  await extract('private-parent', async ({ message }) => output(candidate([JSON.parse(message).records[0].sourceId], '练习吉他')));
  await store.addMemory('private-parent', scope, { incoming: '进展顺利' });
  const result = await extract('private-parent', async ({ message }) => {
    const input = JSON.parse(message);
    assert.equal(input.previousCandidates[0].shareEligible, false);
    return output(candidate([input.records[0].sourceId], '练习有所进展', [input.previousCandidates[0].id], { decision: 'share', summary: '练习可以带来进步' }));
  });
  assert.equal(result.candidates[0].share, undefined);
});

test('changed old sources reject recompression and retain the previous version and new pending records', async () => {
  await seed('source-change');
  await extract('source-change', async ({ message }) => output(candidate([JSON.parse(message).records[0].sourceId], '练习吉他')));
  await store.addMemory('source-change', scope, { incoming: '继续练习' });
  const file = join(data, 'characters/source-change/' + scope + '.jsonl');
  await assert.rejects(extract('source-change', async ({ message }) => {
    const input = JSON.parse(message);
    await writeFile(file, (await readFile(file, 'utf8')).replace('学习吉他', '学习笛子'));
    return output(candidate([input.records[0].sourceId], '练习乐器', [input.previousCandidates[0].id]));
  }), /旧摘要来源已更改/);
  const status = await store.extractionStatus('source-change', scope);
  assert.equal(status.pending, 1);
  assert.equal(status.todayCandidates[0].event, '练习吉他');
});

test('stale parallel commits and cross-day commits cannot replace newer summaries', async () => {
  await seed('stale-commit');
  await extract('stale-commit', async ({ message }) => output(candidate([JSON.parse(message).records[0].sourceId], '练习吉他')));
  await store.addMemory('stale-commit', scope, { incoming: '新的计划' });
  await store.addMemory('stale-commit', scope, { incoming: '另一条计划' });
  const status = await store.extractionStatus('stale-commit', scope);
  const merge = { day: memoryDay(Date.now()), revision: status.summaryRevision, sourceRevision: status.summarySourceRevision };
  const daily = { owner, day: merge.day };
  const results = await Promise.allSettled(status.batch.map((record) => store.commitExtraction('stale-commit', scope,
    [record.sourceId], [candidate([record.sourceId], '计划练习', [status.todayCandidates[0].id])],
    createHash('sha256').update(JSON.stringify([record])).digest('hex'), daily, merge)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /当日摘要或日期已变化/);
  await store.addMemory('stale-commit', scope, { incoming: '明天的计划' });
  const next = await store.extractionStatus('stale-commit', scope);
  await assert.rejects(store.commitExtraction('stale-commit', scope, next.batch.map((row) => row.sourceId), [], next.revision,
    { owner, day: memoryDay(Date.now() - 86_400_000) }), /日期已变化/);
  assert.equal((await store.extractionStatus('stale-commit', scope)).pending, 2);
});

test('legacy summaries count until replaced, while older days do not enter the daily merge', async () => {
  await seed('legacy-merge');
  const first = await store.extractionStatus('legacy-merge', scope);
  const file = join(data, 'characters/legacy-merge/memory-extractions.jsonl');
  await appendFile(file, JSON.stringify({ version: 1, scope, sourceIds: [first.batch[0].sourceId],
    candidates: [{ ...candidate([first.batch[0].sourceId], '旧'.repeat(100)), id: '11111111-1111-1111-1111-111111111111' }], at: new Date().toISOString() }) + '\n');
  await store.addMemory('legacy-merge', scope, { incoming: '今天的新消息' });
  await extract('legacy-merge', async ({ message }) => {
    const input = JSON.parse(message);
    assert.equal(input.previousCandidates[0].event.length, 100);
    return output(candidate([input.records[0].sourceId], '合并后摘要', [input.previousCandidates[0].id]));
  });
  const status = await store.extractionStatus('legacy-merge', scope);
  assert.equal(status.todayCandidates.length, 1);
  assert.equal(status.candidates[0].superseded, true);
  const tomorrow = await store.extractionStatus('legacy-merge', scope, 10, Date.now() + 86_400_000);
  assert.equal(tomorrow.todayChars, 0);
  assert.deepEqual(tomorrow.todayCandidates, []);
});

test('missing owner and unknown model usage stop manual extraction before making a model request', async () => {
  await seed('unknown-usage');
  let calls = 0;
  const generate = async () => { calls++; return output(); };
  await assert.rejects(extractMemoryBatch('unknown-usage', scope, { generate }), /配置主人/);
  const { recordUsage } = await import('../plugin/src/settings.mjs');
  await recordUsage(new Date(), null);
  await assert.rejects(extract('unknown-usage', generate), /未知模型用量/);
  assert.equal(calls, 0);
  assert.equal((await store.extractionStatus('unknown-usage', scope)).pending, 1);
});
