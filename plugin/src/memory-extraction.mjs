import { runCodex } from './codex.mjs';
import { extractionStatus, commitExtraction, extractionSchedule, setExtractionSchedule, memoryActivityDates } from './store.mjs';
import { availableMemoryChars, dailyMemoryLimit, memoryDay, memoryProcessingDue, MEMORY_INTERVAL_MS } from './memory-daily-policy.mjs';
import { readBudget } from './settings.mjs';

const running = new Set();

export function parseExtraction(text) {
  if (typeof text !== 'string' || text.length > 50_000) throw new Error('提炼结果格式无效。');
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('提炼结果不是有效 JSON，请重试。'); }
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.candidates)) throw new Error('提炼结果缺少候选列表，请重试。');
  return result.candidates;
}

export async function extractMemoryBatch(characterId, scope, { limit = 10, generate = runCodex, owner = process.env.SURFCORE_QQ_OWNER, now = Date.now(), canCommit = () => true } = {}) {
  const key = JSON.stringify([characterId, scope]);
  if (running.has(key)) throw new Error('此会话正在提炼，请稍后重试。');
  running.add(key);
  try {
    const status = await extractionStatus(characterId, scope, limit, now);
    if (!status.batch.length) return { scope, processed: 0, candidates: [], pending: 0 };
    let daily = null, maxChars = null;
    if (scope !== 'codex') {
      if (typeof owner !== 'string' || !/^[1-9][0-9]{3,14}$/.test(owner)) throw new Error('请先配置主人 QQ，才能执行摘要额度检查。');
      const activeDays = await memoryActivityDates(characterId, scope);
      const policy = dailyMemoryLimit({ scope, owner, activeDays: activeDays.map(memoryDay), today: memoryDay(now) });
      daily = { owner, day: memoryDay(now) };
      maxChars = policy.limit;
    }
    const previousCandidates = maxChars !== null ? status.todayCandidates : [];
    const merge = previousCandidates.length ? { day: memoryDay(now), revision: status.summaryRevision, sourceRevision: status.summarySourceRevision } : null;
    const budget = await readBudget(new Date(now));
    if (daily && budget.unreported > 0) throw new Error('存在未知模型用量，已暂停提炼；请先核对用量。');
    if (!canCommit()) throw new Error('提炼已取消。');
    const conversation = scope === 'codex' ? { kind: 'codex' } : scope.includes('-group-') ? { kind: 'group' } : { kind: 'private', contactId: scope.split('-').at(-1) };
    // Keep cross-conversation recall from being written back as an independent source.
    const records = status.batch.map(({ sharedContextUsed, reply, ...record }) => sharedContextUsed ? record : { ...record, reply });
    const text = await generate({
      role: { id: characterId, persona: '根据会话原文整理候选记忆。' },
      extractionMode: true,
      message: JSON.stringify({ conversation, records, ...(maxChars === null ? {} : { maxChars }),
        ...(merge ? { previousCandidates: previousCandidates.map(({ id, who, event, feeling, importance, shareAvailable }) =>
          ({ id, who, event, feeling, importance, shareEligible: shareAvailable })) } : {}) }),
    });
    const candidates = parseExtraction(text);
    const result = await commitExtraction(characterId, scope, status.batch.map((row) => row.sourceId), candidates, status.revision, daily, merge, canCommit);
    const after = await extractionStatus(characterId, scope, limit);
    return { ...result, merged: Boolean(merge), todayChars: after.todayChars, pending: after.pending,
      remaining: availableMemoryChars(maxChars, after.todayChars) };
  } finally { running.delete(key); }
}

function automaticTiming(status, schedule, now) {
  const lastFailure = Date.parse(schedule.lastFailureAt);
  const lastProcessed = Date.parse(status.lastProcessedAt || schedule.lastProcessedAt);
  const lastFailureAt = lastFailure > (lastProcessed || 0) ? schedule.lastFailureAt : null;
  const retryAt = lastFailure + MEMORY_INTERVAL_MS;
  if (lastFailureAt && now < retryAt) return { state: 'retry', dueAt: new Date(retryAt).toISOString(), lastFailureAt };
  const timing = memoryProcessingDue({ firstPendingAt: status.firstPendingAt, lastProcessedAt: status.lastProcessedAt || schedule.lastProcessedAt, now });
  if (status.pending >= 10) return { state: 'due', dueAt: status.firstPendingAt, lastFailureAt };
  return { state: timing.due ? 'due' : 'waiting', dueAt: timing.dueAt, lastFailureAt };
}

export async function memoryExtractionStatus(characterId, scope, { owner, now = Date.now() } = {}) {
  const status = await extractionStatus(characterId, scope, 10, now);
  const { pending, processed, candidates, todayChars, lastProcessedAt } = status;
  let automatic;
  if (running.has(JSON.stringify([characterId, scope]))) automatic = { state: 'running' };
  else if (!scope.startsWith('qq-')) automatic = { state: 'manual' };
  else if (!pending) automatic = { state: 'empty' };
  else if (!/^[1-9][0-9]{3,14}$/.test(owner || '')) automatic = { state: 'owner-unavailable' };
  else {
    automatic = automaticTiming(status, await extractionSchedule(characterId, scope), now);
    if (automatic.state === 'due' && (await readBudget(new Date(now))).unreported > 0) automatic.state = 'usage-unknown';
  }
  return { pending, processed, candidates, todayChars, lastProcessedAt, automatic,
    shareableCount: candidates.filter(({ shareAvailable }) => shareAvailable).length };
}

export async function autoExtractMemory(characterId, scope, { owner, now = Date.now(), generate = runCodex, canCommit = () => true } = {}) {
  if (scope === 'shared' || scope === 'codex') return { triggered: false, reason: 'scope-not-automatic' };
  if (typeof owner !== 'string' || !/^[1-9][0-9]{3,14}$/.test(owner)) return { triggered: false, reason: 'owner-unavailable' };
  const status = await extractionStatus(characterId, scope, 10, now);
  if (!status.pending) {
    const current = await extractionSchedule(characterId, scope);
    if (current.firstPendingAt !== null) await setExtractionSchedule(characterId, scope, { firstPendingAt: null });
    return { triggered: false, reason: 'empty' };
  }
  const schedule = await extractionSchedule(characterId, scope);
  const timing = automaticTiming(status, schedule, now);
  if (timing.state !== 'due') {
    if (schedule.firstPendingAt !== status.firstPendingAt) await setExtractionSchedule(characterId, scope, { firstPendingAt: status.firstPendingAt });
    return { triggered: false, reason: timing.state, dueAt: timing.dueAt };
  }
  const budget = await readBudget(new Date(now));
  const checkLater = new Date(now + MEMORY_INTERVAL_MS).toISOString();
  if (budget.unreported > 0) return { triggered: false, reason: 'usage-unknown', pending: status.pending, dueAt: checkLater };
  let result;
  try {
    result = await extractMemoryBatch(characterId, scope, { limit: 10, owner, now, generate, canCommit });
  } catch (error) {
    if (!canCommit()) return { triggered: false, reason: 'canceled' };
    await setExtractionSchedule(characterId, scope, { lastFailureAt: new Date(now).toISOString() });
    return { triggered: true, error: error.message, pending: status.pending, dueAt: checkLater };
  }
  const after = await extractionStatus(characterId, scope, 10);
  await setExtractionSchedule(characterId, scope, { firstPendingAt: after.firstPendingAt, lastProcessedAt: new Date(now).toISOString(), lastFailureAt: null });
  return { triggered: true, ...result, nextImmediate: after.pending >= 10 };
}

export { extractionStatus };
