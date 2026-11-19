import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDirectory } from './store.mjs';
import { voiceBinding, validateStyle, validVoiceId, DESIGN_VOICE } from './voice-config.mjs';

const settingsFile = join(dataDirectory, 'panel-settings.jsonl');
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' });
const DEFAULT_PREFERENCES = { language: 'auto', pack: 'none', providerId: 'none', voiceId: '', style: {}, allowOnline: false, fallback: null };

export const LANGUAGES = Object.freeze({
  auto: '跟随来信',
  'zh-CN': '普通话（简体中文）',
  'yue-HK': '粤语（繁体中文）',
  en: 'English',
  ja: '日本語',
});
export const VOICE_PACKS = Object.freeze({
  none: '不使用语音包',
  local: 'SurfVoice 本地包',
  cloud: 'SurfVoice 云端包',
  breeze: 'Breeze 本机',
});

async function records(file) {
  try {
    const raw = await readFile(file, 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function append(file, row) {
  await mkdir(dataDirectory, { recursive: true });
  await appendFile(file, JSON.stringify(row) + '\n', { mode: 0o600 });
}

function budgetDate(now) {
  const parts = dayFormatter.formatToParts(now);
  return ['year', 'month', 'day'].map((part) => parts.find(({ type }) => type === part).value).join('-');
}

function usageFile(now) {
  return join(dataDirectory, 'usage-' + budgetDate(now) + '.jsonl');
}

function dateShift(date, days) {
  const value = new Date(date + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export async function readBudget(now = new Date()) {
  const [changes, log] = await Promise.all([records(settingsFile), records(usageFile(now))]);
  const config = changes.findLast((item) => item.type === 'budget') ?? {};
  const limit = config.limit ?? null;
  const weeklyLimit = config.weeklyLimit ?? null;
  const used = log.reduce((total, item) => total + (item.tokens ?? 0), 0);
  const date = budgetDate(now);
  const day = new Date(date + 'T00:00:00Z');
  const mondayOffset = (day.getUTCDay() + 6) % 7;
  const daysThisWeek = mondayOffset + 1;
  const weekLogs = (await Promise.all(Array.from({ length: daysThisWeek }, (_, index) => records(join(dataDirectory, 'usage-' + dateShift(date, -index) + '.jsonl'))))).flat();
  const weeklyUsed = weekLogs.reduce((total, item) => total + (item.tokens ?? 0), 0);
  return { date, limit, weeklyLimit, used, weeklyUsed, turns: log.length, unreported: log.filter((item) => item.tokens === null).length };
}

export async function setBudget(limit, weeklyLimit = null) {
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000_000)) {
    throw new Error('每日额度请输入 1 到 10 亿之间的整数，或选择仅统计。');
  }
  if (weeklyLimit !== null && (!Number.isSafeInteger(weeklyLimit) || weeklyLimit < 1 || weeklyLimit > 10_000_000_000)) {
    throw new Error('每周额度请输入 1 到 100 亿之间的整数，或选择不限制。');
  }
  if (limit !== null && weeklyLimit !== null && weeklyLimit < limit) throw new Error('每周额度不能小于每日额度。');
  await append(settingsFile, { type: 'budget', limit, weeklyLimit });
  return readBudget();
}

export async function requireBudget(now) {
  const [{ limit, weeklyLimit, used, weeklyUsed }, policy] = await Promise.all([readBudget(now), readQuotaPolicy()]);
  if (!policy.enabled && limit !== null && used >= limit) {
    throw new Error('SurfCore 今日额度已用完。可在控制台调整每日额度，或等香港时间零点。');
  }
  if (weeklyLimit !== null && weeklyUsed >= weeklyLimit) throw new Error('SurfCore 本周额度已用完。可在控制台调整每周额度，或等下周。');
}

export async function recordUsage(startedAt, total) {
  const value = total?.totalTokens;
  const tokens = Number.isSafeInteger(value) && value >= 0 ? value : null;
  await append(usageFile(startedAt), { at: startedAt.toISOString(), tokens });
}

export async function readCharacterPreferences(id) {
  return (await records(settingsFile)).reduce((preferences, row) => {
    if (row.characterId === id && row.type === 'language') return { ...preferences, language: row.language };
    if (row.characterId === id && row.type === 'voice') return { ...preferences, pack: row.providerId ?? row.pack,
      providerId: row.providerId ?? row.pack, voiceId: row.voiceId, style: row.style ?? {}, allowOnline: row.allowOnline === true, fallback: row.fallback ?? null };
    return preferences;
  }, { ...DEFAULT_PREFERENCES });
}

export async function setLanguage(id, language) {
  if (!Object.hasOwn(LANGUAGES, language)) throw new Error('请选择有效的回复语言。');
  await append(settingsFile, { type: 'language', characterId: id, language });
  return readCharacterPreferences(id);
}

export async function setVoice(id, pack, voiceId, options = {}) {
  if (!Object.hasOwn(VOICE_PACKS, pack) || (pack !== 'none' && !(validVoiceId(voiceId) || (pack === 'breeze' && voiceId === DESIGN_VOICE)))) {
    throw new Error('请选择有效的语音包和音色。');
  }
  const style = validateStyle(options.style, pack);
  if (options.allowOnline !== undefined && typeof options.allowOnline !== 'boolean') throw new Error('联网备选许可无效。');
  const fallback = options.fallback ? voiceBinding(options.fallback) : null;
  if (fallback && fallback.providerId !== 'cloud') throw new Error('在线备选须绑定云端服务及具体音色。');
  if (options.allowOnline && !fallback) throw new Error('请先绑定在线备选音色。');
  await append(settingsFile, { type: 'voice', characterId: id, pack, providerId: pack, voiceId: pack === 'none' ? '' : voiceId,
    style: pack === 'none' ? {} : style, allowOnline: pack !== 'none' && options.allowOnline === true, fallback: pack === 'none' ? null : fallback });
  return readCharacterPreferences(id);
}

export async function readQuotaPolicy() {
  return (await records(settingsFile)).findLast((row) => row.type === 'quotaPolicy')?.policy
    ?? { enabled: false, primaryRemaining: 20, secondaryRemaining: 10 };
}
export async function setQuotaPolicy(policy) {
  if (typeof policy?.enabled !== 'boolean' || !['primaryRemaining', 'secondaryRemaining'].every((key) =>
    Number.isInteger(policy[key]) && policy[key] >= 0 && policy[key] <= 100)) throw new Error('额度保留百分比应为 0–100 的整数。');
  const value = { enabled: policy.enabled, primaryRemaining: policy.primaryRemaining, secondaryRemaining: policy.secondaryRemaining };
  await append(settingsFile, { type: 'quotaPolicy', policy: value }); return value;
}
