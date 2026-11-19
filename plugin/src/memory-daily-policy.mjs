const DAY_MS = 86_400_000;
export const MEMORY_INTERVAL_MS = 2 * 60 * 60 * 1000;
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function memoryDay(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error('记忆活动时间无效。');
  const parts = dateFormatter.formatToParts(date);
  return ['year', 'month', 'day'].map((name) => parts.find((part) => part.type === name).value).join('-');
}

function dayNumber(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('记忆日期无效。');
  const time = Date.parse(day + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== day) throw new Error('记忆日期无效。');
  return time / DAY_MS;
}

// Activity is per character and conversation. Consecutive days grow
// logarithmically to the cap on day 14; inactive days decay exponentially.
export function dailyMemoryLimit({ scope, owner, activeDays, today }) {
  if (typeof scope !== 'string' || !/^(?:qq|demo)-(?:group-)?[1-9][0-9]{3,14}$/.test(scope)) throw new Error('记忆对话范围无效。');
  if (typeof owner !== 'string' || !/^[1-9][0-9]{3,14}$/.test(owner)) throw new Error('主人账号无效。');
  if (!Array.isArray(activeDays)) throw new Error('记忆活动日期无效。');
  const current = dayNumber(today);
  const days = [...new Set(activeDays.map(dayNumber))].filter((day) => day <= current).sort((a, b) => a - b);
  const group = /-group-/.test(scope);
  const mainOwner = !group && scope.slice(scope.indexOf('-') + 1) === owner;
  if (mainOwner) return { limit: null, base: null, maximum: null, streak: 0, inactiveDays: 0 };
  const base = group ? 300 : 100;
  const maximum = group ? 1500 : 500;
  if (!days.length) return { limit: base, base, maximum, streak: 0, inactiveDays: 0 };
  const last = days.at(-1);
  let streak = 0, progress = 0, previous = null;
  for (const day of days) {
    const gap = previous === null ? 0 : day - previous - 1;
    if (gap > 0) { progress *= Math.pow(0.75, gap); streak = 0; }
    const before = Math.min(1, Math.log(Math.max(1, streak)) / Math.log(14));
    streak++;
    const after = Math.min(1, Math.log(streak) / Math.log(14));
    progress = Math.min(1, progress + after - before);
    previous = day;
  }
  const inactiveDays = current - last;
  const limit = Math.round(base + (maximum - base) * progress * Math.pow(0.75, inactiveDays));
  return { limit, base, maximum, streak, inactiveDays };
}

export function memoryProcessingDue({ firstPendingAt, lastProcessedAt = null, now }) {
  const first = Date.parse(firstPendingAt);
  const current = typeof now === 'number' ? now : Date.parse(now);
  const last = lastProcessedAt === null ? null : Date.parse(lastProcessedAt);
  if (!Number.isFinite(first) || !Number.isFinite(current) || (last !== null && !Number.isFinite(last))) throw new Error('记忆调度时间无效。');
  const dueAt = last === null ? first + MEMORY_INTERVAL_MS : Math.max(first, last + MEMORY_INTERVAL_MS);
  return { due: current >= dueAt, dueAt: new Date(dueAt).toISOString() };
}

export function availableMemoryChars(limit, alreadyWritten) {
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('记忆额度无效。');
  if (!Number.isSafeInteger(alreadyWritten) || alreadyWritten < 0) throw new Error('已用记忆额度无效。');
  return limit === null ? null : Math.max(0, limit - alreadyWritten);
}

export function memoryCandidateChars(candidate) {
  return [candidate?.who, candidate?.event, candidate?.feeling, ...(candidate?.share?.derived ? [] : [candidate?.share?.summary])]
    .filter((value) => typeof value === 'string')
    .reduce((sum, value) => sum + Array.from(value).length, 0);
}
