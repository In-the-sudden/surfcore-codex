import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = await mkdtemp(join(tmpdir(), 'surfcore-memory-privacy-'));
process.env.SURFCORE_DATA_DIR = data;
process.env.SURFCORE_QQ_OWNER = '10001';
const { assessMemoryPrivacy, readMemoryPrivacy, shareSummaryIsUsable, defaultSharedSummary } = await import('../plugin/src/memory-privacy.mjs');
const store = await import('../plugin/src/store.mjs');
const { extractMemoryBatch } = await import('../plugin/src/memory-extraction.mjs');

test('source risks remain restricted when a summary omits the sensitive details', () => {
  for (const text of ['验证码：123456', '别告诉任何人我今天在医院', '孩子就读的学校是某学校', '这是客户名单', '家庭住址：某路 1 号', '手机号：13812345678', 'ＣＶＶ：１２３', '这段别分享给其他人', '不要共享这条', '不要传播', '不许转发', '禁止对外透露']) {
    const result = assessMemoryPrivacy({ who: '朋友', event: '分享了一件事', feeling: '' }, [{ incoming: text }]);
    assert.equal(result.status, 'restricted', text);
    assert.equal(JSON.stringify(result).includes(text), false);
  }
});

test('candidate-only risk is detected and unknown is never declared shareable', () => {
  const result = assessMemoryPrivacy({ event: '验证码：123456' }, [{ incoming: '普通对话' }]);
  assert.equal(result.status, 'restricted');
  assert.ok(result.reasons.includes('credential'));
  assert.equal(assessMemoryPrivacy({ event: '普通话题' }, [{ incoming: '今天天气不错' }]).status, 'review');
  assert.equal(assessMemoryPrivacy({ event: '普通话题' }, []).status, 'unassessed');
  assert.equal(readMemoryPrivacy().status, 'unassessed');
  assert.equal(readMemoryPrivacy({ version: 1, status: 'safe', reasons: [] }).status, 'unassessed');
  assert.equal(readMemoryPrivacy({ version: 1, status: 'review', reasons: ['private'] }).status, 'unassessed');
  assert.equal(shareSummaryIsUsable('小明喜欢乐器', { who: '小明' }, [{ incoming: '有人开始练吉他' }]), false);
  assert.equal(shareSummaryIsUsable('编号 100012345 的人喜欢乐器', { who: '' }, [{ incoming: '有人开始练吉他' }]), false);
});

test('derived sharing avoids multi-person names and turns first-person summaries into anonymous experiences', () => {
  const sources = [{ incoming: '准备开始学习一门乐器' }];
  const derive = (who, event) => defaultSharedSummary({ who, event, privacy: { version: 1, status: 'review', reasons: [] } }, sources);
  assert.equal(derive('李明和张华', '李明练习乐器'), null);
  assert.equal(derive('林', '林练习乐器'), null);
  assert.equal(derive('我', '我喜欢音乐'), '一位对话者喜欢音乐');
  assert.equal(derive('', '我开始练琴'), '一位对话者开始练琴');
});

test('extraction persists source-based classification while preserving raw conversation and scope', async () => {
  await store.createCharacter('privacy', '# Privacy');
  await store.addMemory('privacy', 'qq-10002', { incoming: '别告诉别人，今天我去了医院。', reply: '好的' });
  const file = join(data, 'characters/privacy/qq-10002.jsonl');
  const original = await readFile(file, 'utf8');
  const result = await extractMemoryBatch('privacy', 'qq-10002', { generate: async ({ message }) => {
    const { records } = JSON.parse(message);
    return JSON.stringify({ candidates: [{ sourceIds: [records[0].sourceId], who: '朋友', event: '去过医院', feeling: '', importance: 2, privacy: { status: 'safe' } }] });
  } });
  assert.equal(result.candidates[0].privacy.status, 'restricted');
  assert.ok(result.candidates[0].privacy.reasons.includes('private'));
  assert.equal((await store.extractionStatus('privacy', 'qq-10002')).candidates[0].privacy.status, 'restricted');
  assert.equal((await store.extractionStatus('privacy', 'qq-10003')).candidates.length, 0);
  assert.equal((await store.memoryRecallPreview('privacy', 'qq-10003')).narrative.includes('去过医院'), false);
  assert.equal(await readFile(file, 'utf8'), original);
});
