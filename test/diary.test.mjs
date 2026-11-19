import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = await mkdtemp(join(tmpdir(), 'surfcore-diary-'));
process.env.SURFCORE_DATA_DIR = data;
const { createCharacter, memoryRecallPreview, addMemory } = await import('../plugin/src/store.mjs');
const diary = await import('../plugin/src/diary.mjs');
const { readDiary, appendDiary, replaceDiaryToday, deleteDiaryToday, composeDiary } = diary;
const beforeMidnight = Date.parse('2026-11-08T15:59:59Z');
const afterMidnight = Date.parse('2026-11-08T16:00:00Z');

test('opening on a new Hong Kong day reviews earlier days once even when the model declines', async () => {
  await createCharacter('diary-auto', '# Daily diary');
  for (const [scope, at, incoming] of [['qq-group-10003', beforeMidnight, '昨天试了新的画笔'], ['qq-10002', afterMidnight, '今天才发生']]) {
    await writeFile(join(data, 'characters', 'diary-auto', scope + '.jsonl'), JSON.stringify({ at: new Date(at).toISOString(), incoming }) + '\n');
  }
  let calls = 0;
  const open = () => diary.reviewDiaryOnOpen('diary-auto', { now: afterMidnight, generate: async ({ message }) => {
    calls++;
    assert.match(message, /昨天试了新的画笔/);
    assert.doesNotMatch(message, /今天才发生/);
    return '{"write":false}';
  } });
  await Promise.all([open(), open()]);
  await open();
  assert.equal(calls, 1);
  assert.equal((await readDiary('diary-auto', { now: afterMidnight })).entries.length, 0);
  const next = afterMidnight + 86_400_000;
  const result = await diary.reviewDiaryOnOpen('diary-auto', { now: next, generate: async () => '{"write":true,"text":"记下这两天的事。"}' });
  assert.equal(result.written, true);
  assert.deepEqual((await readDiary('diary-auto', { now: next })).entries.map(({ day }) => day), ['2026-11-10']);
});

test('an unavailable model leaves the same day eligible for a later opening', async () => {
  await createCharacter('diary-retry', '# Retry diary');
  await writeFile(join(data, 'characters', 'diary-retry', 'codex.jsonl'),
    JSON.stringify({ at: new Date(beforeMidnight).toISOString(), incoming: '昨天在练习画画' }) + '\n');
  await assert.rejects(diary.reviewDiaryOnOpen('diary-retry', { now: afterMidnight, generate: async () => {
    throw new Error('额度不足');
  } }), /额度不足/);
  const reopened = await diary.reviewDiaryOnOpen('diary-retry', { now: afterMidnight, generate: async () => '{"write":false}' });
  assert.equal(reopened.state, 'skipped');
});

test('each role has one dated daily section with Unicode limits and preserves drawing', async () => {
  await createCharacter('diary-one', '# Diary one');
  await createCharacter('diary-two', '# Diary two');
  await appendDiary('diary-one', '心情\n  /\\_/\\\n ( °.° )', { now: beforeMidnight });
  await appendDiary('diary-one', '😀'.repeat(10), { now: beforeMidnight });
  await appendDiary('diary-one', '第二天', { now: afterMidnight });
  const result = await readDiary('diary-one', { now: afterMidnight });
  assert.deepEqual(result.entries.map((item) => item.day), ['2026-11-08', '2026-11-09']);
  assert.match(result.entries[0].text, /  \/\\_\/\\/);
  assert.equal(result.used, 3);
  assert.equal((await readDiary('diary-two', { now: afterMidnight })).entries.length, 0);
  const raw = await readFile(join(data, 'characters', 'diary-one', '日记', '日记.txt'), 'utf8');
  assert.equal((raw.match(/^===== 2026-11-08 =====$/gm) || []).length, 1);
  await assert.rejects(appendDiary('diary-one', 'x'.repeat(498), { now: afterMidnight }), /500/);
  await assert.rejects(appendDiary('diary-one', '===== 2026-11-10 =====', { now: afterMidnight }), /分节/);
  await assert.rejects(appendDiary('diary-one', '晚到的记录', { now: beforeMidnight }), /末尾日期/);
});

test('concurrent writes respect the daily cap, and diary never enters memory recall', async () => {
  await createCharacter('diary-lock', '# Diary lock');
  const results = await Promise.allSettled([
    appendDiary('diary-lock', '甲'.repeat(300), { now: beforeMidnight }),
    appendDiary('diary-lock', '乙'.repeat(300), { now: beforeMidnight }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal((await readDiary('diary-lock', { now: beforeMidnight })).used, 300);
  const preview = await memoryRecallPreview('diary-lock', 'qq-10003');
  assert.deepEqual(preview.narrative, []);
});

test('model can choose not to write and only receives chosen scope', async () => {
  await createCharacter('diary-compose', '# Diary compose');
  await addMemory('diary-compose', 'qq-10003', { note: '一段对话' });
  await addMemory('diary-compose', 'qq-10004', { note: '另一个会话的秘密' });
  const skip = await composeDiary('diary-compose', 'qq-10003', { now: beforeMidnight, generate: async (input) => {
    assert.equal(input.diaryMode, true);
    assert.doesNotMatch(input.message, /另一个会话的秘密/);
    return '{"write":false}';
  } });
  assert.equal(skip.written, false);
  assert.equal((await readDiary('diary-compose', { now: beforeMidnight })).entries.length, 0);
  const written = await composeDiary('diary-compose', 'qq-10003', { now: beforeMidnight, generate: async () => '{"write":true,"text":"今天想写几句。"}' });
  assert.equal(written.written, true);
  await assert.rejects(composeDiary('diary-compose', 'qq-10003', { now: beforeMidnight, generate: async () => '{"write":true,"text":"' + '长'.repeat(501) + '"}' }), /过长/);
});

test('damaged diary fails closed without overwriting content', async () => {
  await createCharacter('diary-broken', '# Diary broken');
  await appendDiary('diary-broken', '原文', { now: beforeMidnight });
  const path = join(data, 'characters', 'diary-broken', '日记', '日记.txt');
  await writeFile(path, 'unexpected content');
  await assert.rejects(appendDiary('diary-broken', '新内容', { now: beforeMidnight }), /格式异常/);
  assert.equal(await readFile(path, 'utf8'), 'unexpected content');
});

test('today diary can be replaced or deleted without changing other days', async () => {
  await createCharacter('diary-edit', '# Diary edit');
  const today = Date.parse('2026-11-08T04:00:00Z');
  const tomorrow = Date.parse('2026-11-09T04:00:00Z');
  await appendDiary('diary-edit', '旧内容', { now: today });
  await appendDiary('diary-edit', '明日内容', { now: tomorrow });
  await replaceDiaryToday('diary-edit', '新内容\n符号', { now: tomorrow });
  let result = await readDiary('diary-edit', { now: tomorrow });
  assert.equal(result.entries.find((entry) => entry.day === '2026-11-09').text, '新内容\n符号');
  await deleteDiaryToday('diary-edit', { now: tomorrow });
  result = await readDiary('diary-edit', { now: tomorrow });
  assert.deepEqual(result.entries.map(({ day }) => day), ['2026-11-08']);
  assert.equal(result.entries[0].text, '旧内容');
});

test('stale and previous-day edits cannot overwrite newer diary data', async () => {
  await createCharacter('diary-stale', '# Diary stale');
  await appendDiary('diary-stale', '原文', { now: beforeMidnight });
  const snapshot = await readDiary('diary-stale', { now: beforeMidnight });
  await appendDiary('diary-stale', '追加内容', { now: beforeMidnight });
  await assert.rejects(replaceDiaryToday('diary-stale', '过期编辑', { now: beforeMidnight, expectedDay: snapshot.day, expectedVersion: snapshot.version }), /已被修改/);
  await assert.rejects(deleteDiaryToday('diary-stale', { now: afterMidnight, expectedDay: snapshot.day, expectedVersion: snapshot.version }), /日期已变化/);
  assert.equal((await readDiary('diary-stale', { now: beforeMidnight })).entries[0].text, '原文\n追加内容');
  const current = await readDiary('diary-stale', { now: beforeMidnight });
  await replaceDiaryToday('diary-stale', '更新', { now: beforeMidnight, expectedDay: current.day, expectedVersion: current.version });
  assert.equal((await readDiary('diary-stale', { now: beforeMidnight })).entries[0].text, '更新');
});
