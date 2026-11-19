import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { roleStorageDirectory, withRoleStorageLock } from './role-storage.mjs';
import { memoryDay } from './memory-daily-policy.mjs';
import { characterDetails, memoryRecallPreview, narrativeInventory } from './store.mjs';
import { runCodex } from './codex.mjs';

const HEADER = /^===== (\d{4}-\d{2}-\d{2}) =====$/gm;
const MAX_CHARS = 500;
const versionOf = (raw) => createHash('sha256').update(raw).digest('hex');

function parseDiary(raw) {
  if (!raw) return [];
  const headers = [...raw.matchAll(HEADER)];
  if (!headers.length || headers[0].index !== 0) throw new Error('日记文件格式异常，已停止写入以保护原文件。');
  const seen = new Set();
  return headers.map((match, index) => {
    const day = match[1];
    if (seen.has(day)) throw new Error('日记日期重复，已停止写入以保护原文件。');
    seen.add(day);
    const start = match.index + match[0].length;
    if (raw[start] !== '\n') throw new Error('日记文件格式异常，已停止写入以保护原文件。');
    let content = raw.slice(start + 1, headers[index + 1]?.index ?? raw.length);
    if (!content.endsWith('\n')) throw new Error('日记文件格式异常，已停止写入以保护原文件。');
    content = content.slice(0, -1);
    return { day, text: content, chars: Array.from(content).length };
  });
}

function diaryFile(id) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(id)) throw new Error('角色 ID 格式无效。');
  return join(roleStorageDirectory(), 'characters', id, '日记', '日记.txt');
}

async function readRaw(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

function renderDiary(entries) {
  return entries.map(({ day, text }) => '===== ' + day + ' =====\n' + text + '\n').join('');
}

async function rewriteDiary(id, entries) {
  const path = diaryFile(id);
  const directory = join(roleStorageDirectory(), 'characters', id, '日记');
  await mkdir(directory, { recursive: true });
  const temporary = path + '.tmp-' + process.pid + '-' + Date.now();
  try {
    await writeFile(temporary, renderDiary(entries), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function readDiary(id, { now = Date.now() } = {}) {
  await characterDetails(id);
  return withRoleStorageLock(async () => {
    const raw = await readRaw(diaryFile(id));
    const entries = parseDiary(raw);
    const day = memoryDay(now), today = entries.find((entry) => entry.day === day);
    return { entries, day, version: versionOf(raw), used: today?.chars ?? 0, limit: MAX_CHARS };
  });
}

export async function appendDiary(id, text, { now = Date.now() } = {}) {
  await characterDetails(id);
  if (typeof text !== 'string' || !text.trim()) throw new Error('日记内容不能为空。');
  const normalized = text.replace(/\r\n?/g, '\n');
  if (/^===== \d{4}-\d{2}-\d{2} =====$/m.test(normalized)) throw new Error('日记内容不能包含日期分节标记。');
  const day = memoryDay(now);
  return withRoleStorageLock(async () => {
    const path = diaryFile(id), entries = parseDiary(await readRaw(path));
    const today = entries.find((entry) => entry.day === day);
    if (today && entries.at(-1) !== today) throw new Error('当前日期不是日记末尾日期，已停止写入以保护原文件。');
    if (!today && entries.length && day < entries.at(-1).day) throw new Error('当前日期早于日记末尾日期，已停止写入以保护原文件。');
    const count = Array.from(normalized).length + (today ? today.chars + 1 : 0);
    if (count > MAX_CHARS) throw new Error('当天日记最多 500 字符（含换行）。');
    await mkdir(join(roleStorageDirectory(), 'characters', id, '日记'), { recursive: true });
    await appendFile(path, (today ? '' : '===== ' + day + ' =====\n') + normalized + '\n', { mode: 0o600 });
    return { day, used: count, limit: MAX_CHARS };
  });
}

export async function replaceDiaryToday(id, text, { now, expectedDay, expectedVersion } = {}) {
  await characterDetails(id);
  if (typeof text !== 'string') throw new Error('日记内容无效。');
  const normalized = text.replace(/\r\n?/g, '\n');
  if (/^===== \d{4}-\d{2}-\d{2} =====$/m.test(normalized)) throw new Error('日记内容不能包含日期分节标记。');
  const count = Array.from(normalized).length;
  if (count > MAX_CHARS) throw new Error('当天日记最多 500 字符（含换行）。');
  return withRoleStorageLock(async () => {
    const day = memoryDay(now ?? Date.now());
    if (expectedDay !== undefined && expectedDay !== day) throw new Error('日期已变化，请刷新日记后再保存。');
    const raw = await readRaw(diaryFile(id));
    if (expectedVersion !== undefined && expectedVersion !== versionOf(raw)) throw new Error('日记已被修改，请刷新后再保存。');
    const entries = parseDiary(raw);
    const index = entries.findIndex((entry) => entry.day === day);
    if (!normalized.trim()) {
      if (index >= 0) entries.splice(index, 1);
      await rewriteDiary(id, entries);
      return { day, used: 0, limit: MAX_CHARS, deleted: index >= 0 };
    }
    const next = { day, text: normalized, chars: count };
    if (index >= 0) entries[index] = next;
    else entries.push(next);
    entries.sort((a, b) => a.day.localeCompare(b.day));
    await rewriteDiary(id, entries);
    return { day, used: count, limit: MAX_CHARS, deleted: false };
  });
}

export async function deleteDiaryToday(id, options = {}) {
  return replaceDiaryToday(id, '', options);
}

function readProposal(result, remaining) {
  let proposal;
  try { proposal = JSON.parse(result); } catch { throw new Error('日记生成格式无效，未写入。'); }
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal) || typeof proposal.write !== 'boolean') throw new Error('日记生成格式无效，未写入。');
  if (!proposal.write) return null;
  if (typeof proposal.text !== 'string' || !proposal.text.trim() || Array.from(proposal.text.replace(/\r\n?/g, '\n')).length > remaining) {
    throw new Error('生成的日记过长或无效，未写入。');
  }
  return proposal.text;
}

async function previousDiaryMaterial(id, day, started) {
  const earliest = memoryDay(started - 3 * 86_400_000);
  const conversations = new Map();
  return (await narrativeInventory(id, started))
    .filter(({ at, scope, text }) => {
      if (!text || !(scope === 'codex' || scope.startsWith('qq-')) || !Number.isFinite(Date.parse(at))) return false;
      const recordDay = memoryDay(Date.parse(at));
      return recordDay >= earliest && recordDay < day;
    })
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at)).slice(0, 18).reverse()
    .map(({ at, scope, text }) => {
      if (!conversations.has(scope)) conversations.set(scope, conversations.size + 1);
      return { day: memoryDay(Date.parse(at)), conversation: conversations.get(scope), text: Array.from(text).slice(0, 300).join('') };
    });
}

async function latestReview(log) {
  return (await readRaw(log)).trim().split('\n').at(-1);
}

export async function reviewDiaryOnOpen(id, { generate = runCodex, now } = {}) {
  const started = now ?? Date.now();
  const before = await readDiary(id, { now: started });
  const { day } = before;
  const initial = { day, written: false };
  if (before.used) return { ...initial, state: 'already-written' };
  const logFile = () => join(dirname(diaryFile(id)), '自动回看.txt');
  const claim = day + ' running ' + started;
  const claimed = await withRoleStorageLock(async () => {
    const log = logFile();
    const [lastDay, state, timestamp] = (await latestReview(log)).split(' ');
    if (lastDay > day || (lastDay === day && (state === 'done' || !state))) return 'already-reviewed';
    if (lastDay === day && state === 'running' && started - Number(timestamp) < 120_000) return 'running';
    await mkdir(dirname(log), { recursive: true });
    await appendFile(log, claim + '\n', { mode: 0o600 });
    return null;
  });
  if (claimed) return { ...initial, state: claimed };
  let completed = false;
  try {
    const narrative = await previousDiaryMaterial(id, day, started);
    let outcome = { ...initial, state: 'no-history' };
    if (narrative.length) {
      const { persona } = await characterDetails(id);
      const result = await generate({ role: { id, persona }, diaryMode: true, signal: AbortSignal.timeout(90_000),
        message: JSON.stringify({ retrospective: true, day, narrative, maxChars: MAX_CHARS }) });
      const text = readProposal(result, MAX_CHARS);
      if (text === null) outcome = { ...initial, state: 'skipped' };
      else {
        const entry = await replaceDiaryToday(id, text, { now, expectedDay: day, expectedVersion: before.version });
        outcome = { ...entry, written: true, state: 'written' };
      }
    }
    completed = true;
    return outcome;
  } finally {
    await withRoleStorageLock(async () => {
      const log = logFile();
      if ((await latestReview(log)) === claim) await appendFile(log, day + (completed ? ' done\n' : ' retry\n'), { mode: 0o600 });
    });
  }
}

export async function composeDiary(id, scope, { generate = runCodex, now } = {}) {
  const started = now ?? Date.now();
  const { persona } = await characterDetails(id);
  const before = await readDiary(id, { now: started });
  const remaining = before.limit - before.used - (before.used ? 1 : 0);
  if (remaining <= 0) throw new Error('今天的日记已满。');
  const { narrative } = await memoryRecallPreview(id, scope, { includeShared: false });
  const result = await generate({ role: { id, persona }, diaryMode: true,
    message: JSON.stringify({ scope, narrative: narrative.filter((item) => item.scope === scope).map(({ text }) => text), maxChars: remaining }) });
  const text = readProposal(result, remaining);
  if (text === null) return { written: false, day: before.day, used: before.used, limit: before.limit };
  // A request started before midnight must not write into the wrong date.
  if (memoryDay(now ?? Date.now()) !== before.day) throw new Error('日期已变化，请重新生成日记。');
  return { written: true, ...await appendDiary(id, text, { now: started }) };
}
