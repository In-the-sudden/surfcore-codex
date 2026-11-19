import { createHash, randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory, roleStorageDirectory, withRoleStorageLock } from './role-storage.mjs';
import { assessMemoryPrivacy, readMemoryPrivacy, shareSummaryIsUsable, defaultSharedSummary, sourcedNickname } from './memory-privacy.mjs';
import { memoryDay, memoryCandidateChars, dailyMemoryLimit } from './memory-daily-policy.mjs';

const bundled = fileURLToPath(new URL('../characters/', import.meta.url));
export { dataDirectory };
let characters, current;
function withStorage(work) {
  return withRoleStorageLock(() => {
    const directory = roleStorageDirectory();
    characters = join(directory, 'characters');
    current = join(directory, 'active.jsonl');
    return work();
  });
}
const idPattern = /^[a-z][a-z0-9-]{0,39}$/;
const scopePattern = /^(codex|shared|(?:qq|demo)-(?:group-)?[1-9][0-9]{3,14})$/;
const DEFAULT_MEMORY_CAPACITY = 200;
const DEFAULT_MEMORY_TARGET = 160;
const MEMORY_PROTECTION_DAYS = 7;
const NARRATIVE_LEVELS = ['清晰', '较清楚', '模糊', '印象', '遗忘'];

async function optionalRead(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function cleanText(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(label + '需要是 1–' + max + ' 字符的文本。');
  }
  return value.trim();
}

function roleDir(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('角色 ID 格式无效。');
  return join(characters, id);
}

async function init() {
  await mkdir(characters, { recursive: true });
  for (const id of ['lin', 'ming']) {
    const dir = roleDir(id);
    await mkdir(dir, { recursive: true });
    try {
      await copyFile(join(bundled, id, 'persona.md'), join(dir, 'persona.md'), 1);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

async function loadPersona(id) {
  const versions = await optionalRead(join(roleDir(id), 'persona-versions.jsonl'));
  const persona = versions?.trim() ? JSON.parse(versions.trim().split('\n').at(-1)).persona : await optionalRead(join(roleDir(id), 'persona.md'));
  if (!persona) throw new Error('找不到角色 ' + id + '。');
  return cleanText(persona, 12_000, '人设');
}

async function activeCharacter() {
  await init();
  const pointer = await optionalRead(current);
  const id = pointer ? JSON.parse(pointer.trimEnd().split('\n').at(-1)).id : 'lin';
  const persona = await loadPersona(id);
  return { id, name: persona.split(/\r?\n/)[0].replace(/^#+\s*/, ''), persona };
}

async function listCharacters() {
  const active = await activeCharacter();
  const roles = [];
  for (const entry of await readdir(characters, { withFileTypes: true })) {
    if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
    const persona = await loadPersona(entry.name);
    if (persona) roles.push({ id: entry.name, name: persona.split(/\r?\n/)[0].replace(/^#+\s*/, '') });
  }
  return { active: active.id, characters: roles };
}

async function createCharacter(id, persona) {
  const card = cleanText(persona, 12_000, '人设');
  const dir = roleDir(id);
  await init();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'persona.md'), card + '\n', { flag: 'wx', mode: 0o600 });
  return { id };
}

async function activateCharacter(id) {
  await init();
  await loadPersona(id);
  const previous = await activeCharacter();
  if (previous.id !== id) await snapshotCharacter(previous.id, '切换前');
  await appendFile(current, JSON.stringify({ id }) + '\n');
  return { active: id };
}

const revisionOf = (persona) => createHash('sha256').update(persona).digest('hex');
let edits = Promise.resolve();
function serializeEdit(work) {
  const next = edits.then(work); edits = next.catch(() => {}); return next;
}
async function characterDetails(id) {
  const persona = await loadPersona(id);
  let snapshots = [];
  try {
    const files = await readdir(join(roleDir(id), 'snapshots'));
    snapshots = await Promise.all(files.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).map(async (name) => {
      const item = JSON.parse(await readFile(join(roleDir(id), 'snapshots', name), 'utf8'));
      return { id: item.id, at: item.at, label: item.label };
    }));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { id, persona, revision: revisionOf(persona), snapshots: snapshots.sort((a,b) => b.at.localeCompare(a.at)) };
}
async function snapshotCharacter(id, label = '手动存档') {
  const persona = await loadPersona(id), dir = join(roleDir(id), 'snapshots');
  await mkdir(dir, { recursive: true });
  const journals = {};
  for (const file of (await readdir(roleDir(id))).filter((name) => name.endsWith('.jsonl'))) journals[file] = await readFile(join(roleDir(id), file), 'utf8');
  const snapshot = { id: randomUUID(), at: new Date().toISOString(), label, persona, journals };
  await writeFile(join(dir, snapshot.id + '.json'), JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
  return { id: snapshot.id, at: snapshot.at, label };
}
function updatePersona(id, value, revision) {
  return serializeEdit(async () => {
    const persona = cleanText(value, 12_000, '人设');
    if (revision !== revisionOf(await loadPersona(id))) throw new Error('人格已更改，请重新读取后编辑。');
    await snapshotCharacter(id, '编辑前');
    await appendFile(join(roleDir(id), 'persona-versions.jsonl'), JSON.stringify({ persona, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    return characterDetails(id);
  });
}
function restoreCharacter(id, snapshotId) {
  return serializeEdit(async () => {
    if (typeof snapshotId !== 'string' || !/^[a-f0-9-]{36}$/.test(snapshotId)) throw new Error('存档 ID 无效。');
    const snapshot = JSON.parse(await readFile(join(roleDir(id), 'snapshots', snapshotId + '.json'), 'utf8'));
    const persona = cleanText(snapshot.persona, 12_000, '人设');
    await snapshotCharacter(id, '恢复前');
    await appendFile(join(roleDir(id), 'persona-versions.jsonl'), JSON.stringify({ persona, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    return characterDetails(id);
  });
}

function journalPath(id, scope) {
  if (typeof scope !== 'string' || !scopePattern.test(scope)) throw new Error('记忆范围无效。');
  return join(roleDir(id), scope + '.jsonl');
}

async function addMemory(id, scope, record) {
  await loadPersona(id);
  await appendFile(journalPath(id, scope), JSON.stringify({ ...record, id: randomUUID(), at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  try { return { maintenance: await maintainNarrative(id) }; }
  catch (error) { return { maintenanceError: '记忆已保存，但容量维护失败：' + error.message }; }
}

function recordId(record, line, index) {
  return record.id || createHash('sha256').update(index + ':' + line).digest('hex').slice(0, 24);
}

async function memoryRows(id, scope) {
  const raw = await optionalRead(journalPath(id, scope));
  if (!raw) return [];
  return raw.trimEnd().split('\n').map((line, index) => {
    const record = JSON.parse(line);
    return { ...record, id: recordId(record, line, index) };
  });
}

// A completed batch is recorded on a single line, so retrying after a failure
// leaves the source pending and cannot duplicate an already committed batch.
async function extractionTransactions(id) {
  const raw = await optionalRead(join(roleDir(id), 'memory-extractions.jsonl'));
  const transactions = [];
  const lines = raw?.split('\n') ?? [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try { transactions.push(JSON.parse(line)); }
    catch {
      if (i !== lines.length - 1 && !line.endsWith(' #incomplete-extraction')) throw new Error('提炼记录损坏，请检查数据后重试。');
      // Only a final unterminated line can be safely treated as an interrupted append.
    }
  }
  return transactions;
}

function supersededCandidates(transactions) {
  return new Set(transactions.flatMap((transaction) => transaction.replaces || []));
}

function extractionCandidates(transactions) {
  const superseded = supersededCandidates(transactions);
  return transactions.flatMap((transaction) => (transaction.candidates || []).map((candidate) => ({
    ...candidate, at: transaction.at, superseded: superseded.has(candidate.id),
  })));
}

function sourceRecord({ id: sourceId, at, incoming, reply, messages, sharedContextUsed }) {
  return { sourceId, at, incoming, reply, messages, ...(sharedContextUsed === true ? { sharedContextUsed } : {}) };
}

function sourceDigest(sources) {
  return createHash('sha256').update(JSON.stringify(sources.map(sourceRecord))).digest('hex');
}

async function modelCardsFor(id, { groups, flags }) {
  const transactions = await extractionTransactions(id);
  const superseded = supersededCandidates(transactions);
  const byScope = new Map(groups.map(({ scope, rows }) => [scope, new Map(rows.map((row) => [row.id, row]))]));
  const cards = new Map();
  for (const { scope, candidates } of transactions) {
    const rows = byScope.get(scope);
    if (!rows || !Array.isArray(candidates)) continue;
    for (const candidate of candidates) {
      if (!candidate || superseded.has(candidate.id) || !Array.isArray(candidate.sourceIds) || !candidate.sourceIds.length || !candidate.event) continue;
      const sources = candidate.sourceIds.map((sourceId) => rows.get(sourceId));
      if (sources.some((row) => !row || flags.get(scope + ':' + row.id)?.archived)) continue;
      const digest = candidate.sourceDigest || candidate.share?.sourceDigest;
      if (!digest || digest !== sourceDigest(sources)) continue;
      // A multi-source summary is displayed once, on its newest source record.
      const anchor = sources.reduce((latest, row) => Date.parse(row.at) >= Date.parse(latest.at) ? row : latest);
      const key = scope + ':' + anchor.id;
      const { id: candidateId, who, event, feeling, importance } = candidate;
      const existing = cards.get(key) || [];
      existing.push({ candidateId, who, event, feeling, importance });
      cards.set(key, existing);
    }
  }
  return cards;
}

function effectiveSharing(candidate, sources) {
  if (candidate.sharingDecision === 'private' || readMemoryPrivacy(candidate.privacy).status !== 'review') return null;
  const sourceDigest = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
  const share = candidate.share;
  if (share?.version === 1 && share.sourceDigest === sourceDigest && shareSummaryIsUsable(share.summary, candidate, sources)) return share;
  if (candidate.sourceDigest !== sourceDigest) return null;
  const summary = defaultSharedSummary(candidate, sources);
  return summary ? { version: 1, summary, sourceDigest, derived: true } : null;
}

async function extractionStatusInternal(id, scope, limit = 10, now = Date.now()) {
  await loadPersona(id);
  if (scope === 'shared') throw new Error('共享手记不能自动提炼。');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('批处理数量无效。');
  const rows = await memoryRows(id, scope);
  const transactions = (await extractionTransactions(id)).filter((t) => t.scope === scope);
  const revoked = await revokedConcepts(id);
  const done = new Set(transactions.flatMap((t) => t.sourceIds || []));
  const today = memoryDay(now);
  const storedCandidates = extractionCandidates(transactions);
  const flags = storedCandidates.length ? await reinforcementFor(id) : new Map();
  const cards = storedCandidates.length ? await memoryCards(id) : new Map();
  const compression = storedCandidates.length ? await memoryCompressionStates(id) : new Map();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const candidates = storedCandidates.map((candidate) => {
    const sources = candidate.sourceIds.map((sourceId) => byId.get(sourceId));
    const share = sources.every(Boolean) ? effectiveSharing(candidate, sources.map(sourceRecord)) : null;
    const shareRevoked = revoked.has(candidate.id) || (candidate.ancestorCandidateIds || []).some((ancestorId) => revoked.has(ancestorId));
    return { ...candidate, share: share || undefined, privacy: readMemoryPrivacy(candidate.privacy), shareRevoked,
      shareAvailable: Boolean(share && !shareRevoked && !candidate.superseded && sources.every((row) => shareSourceAvailable(scope, row, { flags, cards, compression }, now))) };
  });
  const todayCandidates = candidates.filter((candidate) => !candidate.superseded && typeof candidate.at === 'string' && memoryDay(candidate.at) === today);
  const storedTodayCandidates = storedCandidates.filter((candidate) => !candidate.superseded && typeof candidate.at === 'string' && memoryDay(candidate.at) === today);
  const todayChars = storedTodayCandidates.reduce((sum, candidate) => sum + memoryCandidateChars(candidate), 0);
  const pending = rows.filter((row) => !done.has(row.id) && (typeof row.incoming === 'string' || typeof row.reply === 'string'));
  const batch = pending.slice(0, limit).map(sourceRecord);
  return { scope, pending: pending.length, processed: done.size, firstPendingAt: pending[0]?.at ?? null, lastProcessedAt: transactions.at(-1)?.at ?? null, todayChars, batch,
    revision: createHash('sha256').update(JSON.stringify(batch)).digest('hex'),
    todayCandidates, summaryRevision: createHash('sha256').update(JSON.stringify(storedTodayCandidates.map((candidate) => ({ ...candidate,
      shareRevoked: revoked.has(candidate.id) || (candidate.ancestorCandidateIds || []).some((ancestorId) => revoked.has(ancestorId)),
    })))).digest('hex'),
    summarySourceRevision: createHash('sha256').update(JSON.stringify(todayCandidates.map((candidate) => candidate.sourceIds.map((sourceId) => {
      const row = rows.find((source) => source.id === sourceId);
      return row ? sourceRecord(row) : null;
    })))).digest('hex'), candidates };
}

async function extractionScheduleInternal(id, scope) {
  await loadPersona(id);
  if (scope === 'shared' || !scopePattern.test(scope)) throw new Error('请选择具体对话范围。');
  const raw = await optionalRead(join(roleDir(id), 'memory-extraction-schedule.jsonl'));
  let found = null;
  for (const line of raw?.split('\n').filter(Boolean) ?? []) {
    let item;
    try { item = JSON.parse(line); } catch { throw new Error('提炼调度记录损坏，已停止自动提炼。'); }
    if (item.scope === scope) found = item;
  }
  return { scope, firstPendingAt: typeof found?.firstPendingAt === 'string' ? found.firstPendingAt : null,
    lastProcessedAt: typeof found?.lastProcessedAt === 'string' ? found.lastProcessedAt : null,
    lastFailureAt: typeof found?.lastFailureAt === 'string' ? found.lastFailureAt : null };
}

async function setExtractionScheduleInternal(id, scope, patch) {
  const current = await extractionScheduleInternal(id, scope);
  const next = { scope, firstPendingAt: patch.firstPendingAt === undefined ? current.firstPendingAt : patch.firstPendingAt,
    lastProcessedAt: patch.lastProcessedAt === undefined ? current.lastProcessedAt : patch.lastProcessedAt,
    lastFailureAt: patch.lastFailureAt === undefined ? current.lastFailureAt : patch.lastFailureAt,
    at: new Date().toISOString() };
  await appendFile(join(roleDir(id), 'memory-extraction-schedule.jsonl'), JSON.stringify(next) + '\n', { mode: 0o600 });
  return next;
}

async function memoryActivityDatesInternal(id, scope) {
  await loadPersona(id);
  if (scope === 'shared' || scope === 'codex') throw new Error('请选择 QQ 或演示对话。');
  return (await memoryRows(id, scope)).filter((row) => typeof row.incoming === 'string' && Number.isFinite(Date.parse(row.at)))
    .map((row) => row.at);
}

async function commitExtractionInternal(id, scope, sourceIds, candidates, revision, daily = null, merge = null, canCommit = () => true) {
  await loadPersona(id);
  if (scope === 'shared') throw new Error('共享手记不能自动提炼。');
  if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 20 || new Set(sourceIds).size !== sourceIds.length) throw new Error('来源记录无效。');
  const rows = await memoryRows(id, scope);
  const available = new Set(rows.map((row) => row.id));
  if (sourceIds.some((sourceId) => typeof sourceId !== 'string' || !available.has(sourceId))) throw new Error('来源记录已更改，请重试。');
  const current = sourceIds.map((sourceId) => sourceRecord(rows.find((row) => row.id === sourceId)));
  if (revision !== createHash('sha256').update(JSON.stringify(current)).digest('hex')) throw new Error('来源内容已更改，请重试。');
  const done = new Set((await extractionTransactions(id)).filter((t) => t.scope === scope).flatMap((t) => t.sourceIds || []));
  if (sourceIds.some((sourceId) => done.has(sourceId))) throw new Error('部分来源已处理，请刷新后重试。');
  const status = await extractionStatusInternal(id, scope, 1);
  const previous = merge ? status.todayCandidates : [];
  if (merge && (merge.day !== memoryDay(Date.now()) || merge.revision !== status.summaryRevision)) throw new Error('当日摘要或日期已变化，请重新提炼。');
  if (merge && merge.sourceRevision !== createHash('sha256').update(JSON.stringify(previous.map((candidate) =>
    candidate.sourceIds.map((sourceId) => {
      const row = rows.find((source) => source.id === sourceId);
      return row ? sourceRecord(row) : null;
    })))).digest('hex')) throw new Error('旧摘要来源已更改，请重新提炼。');
  for (const candidate of previous) {
    const sources = candidate.sourceIds.map((sourceId) => {
      const row = rows.find((source) => source.id === sourceId);
      if (!row) throw new Error('旧摘要来源已更改，请重新提炼。');
      return sourceRecord(row);
    });
    const digest = candidate.sourceDigest || candidate.share?.sourceDigest;
    if (digest && digest !== createHash('sha256').update(JSON.stringify(sources)).digest('hex')) throw new Error('旧摘要来源已更改，请重新提炼。');
  }
  if (!Array.isArray(candidates) || candidates.length > 40) throw new Error('候选记忆无效。');
  const allowed = new Set(sourceIds);
  const clean = candidates.map((item) => {
    const parentIds = item?.previousCandidateIds ?? [];
    if (!Array.isArray(parentIds) || new Set(parentIds).size !== parentIds.length || parentIds.some((parentId) => !previous.some((candidate) => candidate.id === parentId))) throw new Error('旧摘要来源无效。');
    if (!item || !Array.isArray(item.sourceIds) || (!item.sourceIds.length && !parentIds.length) || item.sourceIds.some((sourceId) => !allowed.has(sourceId)) ||
        new Set(item.sourceIds).size !== item.sourceIds.length || ![1, 2, 3].includes(item.importance)) throw new Error('候选记忆来源或重要度无效。');
    const parents = parentIds.map((parentId) => previous.find((candidate) => candidate.id === parentId));
    const linked = [...new Set([...item.sourceIds, ...parents.flatMap((candidate) => candidate.sourceIds)])];
    const result = { id: randomUUID(), sourceIds: linked, importance: item.importance,
      ...(parents.length ? { previousCandidateIds: parentIds, ancestorCandidateIds: [...new Set(parents.flatMap((candidate) => [candidate.id, ...(candidate.ancestorCandidateIds || [])]))] } : {}) };
    for (const field of ['who', 'event', 'feeling']) {
      if (typeof item[field] !== 'string' || item[field].length > 500) throw new Error('候选记忆字段无效。');
      result[field] = item[field].trim();
    }
    if (!result.event) throw new Error('候选记忆缺少事件。');
    const sources = linked.map((sourceId) => {
      const row = rows.find((source) => source.id === sourceId);
      if (!row) throw new Error('旧摘要来源已更改，请重新提炼。');
      return sourceRecord(row);
    });
    result.privacy = assessMemoryPrivacy(result, sources);
    result.sourceDigest = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
    if (Object.hasOwn(item, 'share') && item.share?.decision !== 'share') result.sharingDecision = 'private';
    if (parents.some((parent) => !parent.share || parent.shareRevoked)) result.sharingDecision = 'private';
    if (item.share?.decision === 'share' && result.sharingDecision !== 'private' && result.privacy.status === 'review' && shareSummaryIsUsable(item.share.summary, result, sources)) {
      result.share = { version: 1, summary: item.share.summary.trim(), sourceDigest: createHash('sha256').update(JSON.stringify(sources)).digest('hex') };
    } else if (item.share?.decision === 'share') {
      result.sharingDecision = 'private';
    }
    return result;
  });
  if (daily) {
    const day = memoryDay(Date.now());
    if (daily.day !== day) throw new Error('日期已变化，请重新提炼。');
    const policy = dailyMemoryLimit({ scope, owner: daily.owner,
      activeDays: (await memoryActivityDatesInternal(id, scope)).map(memoryDay), today: day });
    const chars = clean.reduce((sum, candidate) => sum + memoryCandidateChars(candidate), 0);
    if (policy.limit !== null && (merge ? 0 : status.todayChars) + chars > policy.limit) throw new Error('摘要超过该对话今日额度，未写入。');
  }
  const transaction = { version: 1, scope, sourceIds, candidates: clean, ...(merge ? { replaces: previous.map((candidate) => candidate.id) } : {}), at: new Date().toISOString() };
  const file = join(roleDir(id), 'memory-extractions.jsonl');
  const existing = await optionalRead(file);
  let prefix = '\n';
  if (existing && !existing.endsWith('\n')) {
    try { JSON.parse(existing.slice(existing.lastIndexOf('\n') + 1)); }
    catch { prefix = ' #incomplete-extraction\n'; }
  }
  if (!canCommit()) throw new Error('提炼已取消。');
  await appendFile(file, prefix + JSON.stringify(transaction) + '\n', { mode: 0o600 });
  return { scope, processed: sourceIds.length, candidates: clean };
}

async function memoryCards(id) {
  const raw = await optionalRead(join(roleDir(id), 'memory-cards.jsonl'));
  const cards = new Map();
  for (const line of raw?.trim().split('\n').filter(Boolean) ?? []) {
    const card = JSON.parse(line);
    cards.set(card.scope + ':' + card.memoryId, card);
  }
  return cards;
}

// A transaction is one line so an interrupted write cannot apply part of a compaction.
async function memoryCompressionStates(id) {
  const raw = await optionalRead(join(roleDir(id), 'memory-compression.jsonl'));
  const states = new Map();
  for (const line of raw?.split('\n').filter(Boolean) ?? []) {
    let transaction;
    try { transaction = JSON.parse(line); } catch { continue; }
    if (transaction.version !== 1 || !Array.isArray(transaction.changes)) continue;
    for (const change of transaction.changes) {
      if (typeof change?.scope !== 'string' || !scopePattern.test(change.scope) ||
          typeof change.memoryId !== 'string' || !/^[a-f0-9-]{24,36}$/.test(change.memoryId) ||
          !Number.isInteger(change.level) || change.level < 0 || change.level > 4) continue;
      states.set(change.scope + ':' + change.memoryId, { level: change.level, at: transaction.at });
    }
  }
  return states;
}

async function updateMemoryCard(id, scope, memoryId, fields) {
  await loadPersona(id);
  if (typeof memoryId !== 'string' || !/^[a-f0-9-]{24,36}$/.test(memoryId)) throw new Error('记忆条目无效。');
  if (!(await memoryRows(id, scope)).some((row) => row.id === memoryId)) throw new Error('找不到该记忆条目。');
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('记忆卡内容无效。');
  const card = { version: 1, scope, memoryId, at: new Date().toISOString() };
  for (const name of ['who', 'event', 'feeling']) {
    const value = fields[name] ?? '';
    if (typeof value !== 'string' || value.length > 500) throw new Error('记忆卡字段最多 500 字符。');
    card[name] = value.trim();
  }
  const previous = (await memoryCards(id)).get(scope + ':' + memoryId);
  const importance = fields.importance ?? previous?.importance ?? 1;
  if (![1, 2, 3].includes(importance)) throw new Error('记忆重要程度无效。');
  card.importance = importance;
  await appendFile(join(roleDir(id), 'memory-cards.jsonl'), JSON.stringify(card) + '\n', { mode: 0o600 });
  return card;
}

async function reinforcementFor(id) {
  const raw = await optionalRead(join(roleDir(id), 'memory-strength.jsonl'));
  const flags = new Map();
  for (const line of raw?.trim().split('\n').filter(Boolean) ?? []) {
    const update = JSON.parse(line);
    const key = update.scope + ':' + update.memoryId;
    const current = flags.get(key) || {};
    if (update.action === 'pin') current.pinned = update.enabled === true;
    else if (update.action === 'boost') current.boostedAt = update.at;
    else current.reinforced = update.enabled === true;
    flags.set(key, current);
  }
  const archived = await optionalRead(join(roleDir(id), 'memory-archive.jsonl'));
  for (const line of archived?.trim().split('\n').filter(Boolean) ?? []) {
    const update = JSON.parse(line);
    const key = update.scope + ':' + update.memoryId;
    const state = flags.get(key) || {};
    state.archived = update.enabled === true;
    flags.set(key, state);
  }
  return flags;
}

function memoryStatus(row, state = {}, now = Date.now(), card = null, compression = null) {
  const origin = Math.max(Date.parse(row.at) || 0, Date.parse(state.boostedAt) || 0);
  const age = Math.max(0, (now - origin) / 86_400_000);
  const importance = [1, 2, 3].includes(card?.importance) ? card.importance : 1;
  const weight = state.pinned || state.reinforced ? 100 : Math.max(0, Math.round(100 * (1 - age / (60 * importance))));
  const timeLevel = weight >= 80 ? 0 : weight >= 60 ? 1 : weight >= 40 ? 2 : weight > 0 ? 3 : 4;
  const lastBoost = Date.parse(state.boostedAt) || 0;
  const compressedLevel = (Date.parse(compression?.at) || 0) >= lastBoost ? compression?.level || 0 : 0;
  const protectedUntil = origin ? new Date(origin + MEMORY_PROTECTION_DAYS * 86_400_000).toISOString() : null;
  const protectedRecent = !!origin && now < origin + MEMORY_PROTECTION_DAYS * 86_400_000;
  const level = state.pinned || state.reinforced ? 0 : Math.max(timeLevel, compressedLevel);
  const clarityReason = state.pinned ? '永久固定' : state.reinforced ? '旧版强化' :
    level > timeLevel ? '容量整理' : protectedRecent ? '近期保护期' : level ? '时间衰减' : '近期记忆';
  return { reinforced: !!state.reinforced, pinned: !!state.pinned, archived: !!state.archived, weight,
    clarity: NARRATIVE_LEVELS[level], clarityLevel: level, clarityReason, protectedRecent, protectedUntil,
    compressedLevel, importance, boostedAt: state.boostedAt || null };
}

async function listMemoryPage(id, { scope = '', search = '', offset = 0, limit = 50 } = {}) {
  if (typeof scope !== 'string' || (scope && !scopePattern.test(scope))) throw new Error('记忆范围无效。');
  if (typeof search !== 'string' || search.length > 200) throw new Error('搜索内容无效。');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('记忆分页参数无效。');
  }
  const inventory = await memoryInventory(id);
  const { flags, cards, compression, groups } = inventory;
  const modelCards = await modelCardsFor(id, inventory);
  const now = Date.now();
  const scopeCounts = Object.fromEntries(groups.map(({ scope: name, rows }) => [name, rows.length]));
  const query = search.trim().toLocaleLowerCase();
  const records = groups.filter(({ scope: name }) => !scope || name === scope).flatMap(({ scope: name, rows }) => rows.map((row) => {
    const key = name + ':' + row.id, card = cards.get(key) || null;
    return { ...row, scope: name, card, modelCards: modelCards.get(key) || [],
      ...memoryStatus(row, flags.get(key), now, card, compression.get(key)) };
  })).filter((row) => !query || [row.note, row.incoming, row.reply, row.card?.who, row.card?.event, row.card?.feeling,
    ...row.modelCards.flatMap(({ who, event, feeling }) => [who, event, feeling])]
    .some((text) => typeof text === 'string' && text.toLocaleLowerCase().includes(query)))
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return { items: records.slice(offset, offset + limit), total: records.length, offset, limit, scopeCounts };
}

async function listMemoryItems(id) {
  return (await listMemoryPage(id, { limit: 200 })).items;
}

function capacityOptions({ maxRecords = DEFAULT_MEMORY_CAPACITY, targetRecords = DEFAULT_MEMORY_TARGET } = {}) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100_000 ||
      !Number.isSafeInteger(targetRecords) || targetRecords < 0 || targetRecords > maxRecords) {
    throw new Error('记忆容量参数无效。');
  }
  return { maxRecords, targetRecords };
}

async function memoryInventory(id) {
  await loadPersona(id);
  const files = await readdir(roleDir(id), { withFileTypes: true });
  const scopes = files.filter((file) => file.isFile() && file.name.endsWith('.jsonl'))
    .map((file) => file.name.slice(0, -6)).filter((name) => scopePattern.test(name)).sort();
  const flags = await reinforcementFor(id);
  const cards = await memoryCards(id);
  const compression = await memoryCompressionStates(id);
  const groups = await Promise.all(scopes.map(async (scope) => ({ scope, rows: await memoryRows(id, scope) })));
  return { flags, cards, compression, groups };
}

async function memoryCapacity(id, options = {}) {
  const limits = capacityOptions(options);
  const { flags, groups } = await memoryInventory(id);
  const scopes = groups.map(({ scope, rows }) => {
    const archived = rows.filter((row) => flags.get(scope + ':' + row.id)?.archived).length;
    const pinned = rows.filter((row) => !flags.get(scope + ':' + row.id)?.archived && flags.get(scope + ':' + row.id)?.pinned).length;
    return { scope, total: rows.length, active: rows.length - archived, archived, pinned };
  });
  const active = scopes.reduce((sum, item) => sum + item.active, 0);
  const total = scopes.reduce((sum, item) => sum + item.total, 0);
  const archived = scopes.reduce((sum, item) => sum + item.archived, 0);
  const pinned = scopes.reduce((sum, item) => sum + item.pinned, 0);
  return { ...limits, total, active, archived, pinned, remaining: Math.max(0, limits.maxRecords - active),
    percent: Math.round(active / limits.maxRecords * 100), overCapacity: Math.max(0, active - limits.maxRecords), scopes };
}

function narrativeText(row, card, level, modelCards = []) {
  const structured = (card && (card.who || card.event || card.feeling) ? [card] : modelCards)
    .map(({ who, event, feeling }) => [who && '人物：' + who, event && '事件：' + event, feeling && '感受：' + feeling]
      .filter(Boolean).join('；')).join('\n');
  const source = structured || [row.note, row.incoming && '来信：' + row.incoming, row.reply && '回复：' + row.reply].filter(Boolean).join('；');
  const limits = [Infinity, 240, 120, 50, 0];
  const chars = Array.from(source);
  const limit = limits[level];
  if (chars.length <= limit) return source;
  if (!limit) return '';
  return chars.slice(0, Math.max(0, limit - 1)).join('') + '…';
}

function narrativeOptions({ maxChars = 0, warnChars = 60_000, targetChars } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0 || maxChars > 10_000_000 ||
      !Number.isSafeInteger(warnChars) || warnChars < 1 || warnChars > 10_000_000) throw new Error('记忆字符容量参数无效。');
  const target = targetChars ?? Math.floor((maxChars || warnChars) * 0.8);
  if (!Number.isSafeInteger(target) || target < 0 || target > (maxChars || warnChars)) throw new Error('记忆压缩目标无效。');
  return { maxChars, warnChars, targetChars: target };
}

async function narrativePolicy(id) {
  await loadPersona(id);
  const raw = await optionalRead(join(roleDir(id), 'memory-policy.jsonl'));
  const policy = raw?.trim() ? JSON.parse(raw.trim().split('\n').at(-1)) : { maxChars: 0, warnChars: 60_000, auto: true };
  narrativeOptions(policy);
  if (typeof policy.auto !== 'boolean') throw new Error('记忆容量设置无效。');
  return { maxChars: policy.maxChars, warnChars: policy.warnChars, auto: policy.auto };
}

async function setNarrativePolicy(id, policy) {
  await loadPersona(id);
  const { maxChars, warnChars } = narrativeOptions(policy);
  if (typeof policy.auto !== 'boolean') throw new Error('自动整理设置无效。');
  await appendFile(join(roleDir(id), 'memory-policy.jsonl'), JSON.stringify({ maxChars, warnChars, auto: policy.auto }) + '\n', { mode: 0o600 });
  return { policy: await narrativePolicy(id), maintenance: await maintainNarrative(id) };
}

async function maintainNarrative(id) {
  const policy = await narrativePolicy(id);
  const capacity = await narrativeCapacity(id, policy);
  if (!policy.auto || !capacity.full) return { capacity, applied: false };
  const options = { ...policy, targetChars: Math.floor(policy.maxChars * 0.9) };
  const preview = await previewNarrativeCompression(id, options);
  const result = await applyNarrativeCompression(id, { ...options, revision: preview.revision });
  return { capacity: await narrativeCapacity(id, policy), applied: true, reached: result.reached, blockedChars: result.blockedChars };
}

async function narrativeInventory(id, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error('记忆时间无效。');
  const inventory = await memoryInventory(id);
  const { flags, cards, compression, groups } = inventory;
  const modelCards = await modelCardsFor(id, inventory);
  return groups.flatMap(({ scope, rows }) => rows.map((row) => {
    const key = scope + ':' + row.id, state = flags.get(key) || {}, card = cards.get(key);
    const status = memoryStatus(row, state, now, card, compression.get(key));
    const text = status.archived ? '' : narrativeText(row, card, status.clarityLevel, modelCards.get(key));
    return { characterId: id, scope, memoryId: row.id, version: 1, at: row.at,
      ...status, text, chars: Array.from(text).length };
  }));
}

async function narrativeCapacity(id, options = {}) {
  const limits = narrativeOptions(options);
  const items = await narrativeInventory(id, options.now);
  const chars = items.reduce((sum, item) => sum + item.chars, 0);
  const basis = limits.maxChars || limits.warnChars;
  return { ...limits, chars, percent: Math.floor(chars * 100 / basis),
    warning: chars >= basis ? 100 : chars >= basis * 0.9 ? 90 : chars >= basis * 0.8 ? 80 : 0,
    full: limits.maxChars > 0 && chars >= limits.maxChars, count: items.length,
    pinned: items.filter((item) => item.pinned && !item.archived).length };
}

async function previewNarrativeCompression(id, options = {}) {
  const limits = narrativeOptions(options);
  const items = await narrativeInventory(id, options.now);
  const originalChars = items.reduce((sum, item) => sum + item.chars, 0);
  let remainingChars = originalChars;
  const candidates = items.filter((item) => !item.archived && !item.pinned && !item.reinforced && !item.protectedRecent && item.clarityLevel < 4)
    .sort((a, b) => a.importance - b.importance || a.weight - b.weight || (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  const changes = [];
  const inventory = await memoryInventory(id);
  const { cards, groups } = inventory;
  const modelCards = await modelCardsFor(id, inventory);
  const rows = new Map(groups.flatMap(({ scope, rows: group }) => group.map((row) => [scope + ':' + row.id, row])));
  for (const item of candidates) {
    if (remainingChars <= limits.targetChars) break;
    const key = item.scope + ':' + item.memoryId, row = rows.get(key), card = cards.get(key);
    let level = item.clarityLevel, text = item.text;
    while (level < 4 && remainingChars > limits.targetChars) {
      const nextText = narrativeText(row, card, level + 1, modelCards.get(key));
      remainingChars -= Array.from(text).length - Array.from(nextText).length;
      text = nextText; level++;
    }
    if (level !== item.clarityLevel) changes.push({ scope: item.scope, memoryId: item.memoryId,
      fromLevel: item.clarityLevel, level, before: item.text, after: text });
  }
  const preview = { ...limits, originalChars, remainingChars, reached: remainingChars <= limits.targetChars,
    blockedChars: Math.max(0, remainingChars - limits.targetChars), changes };
  return { ...preview, revision: createHash('sha256').update(JSON.stringify(preview)).digest('hex') };
}

async function applyNarrativeCompression(id, options = {}) {
  if (typeof options.revision !== 'string' || !/^[a-f0-9]{64}$/.test(options.revision)) throw new Error('请先预览记忆整理。');
  const preview = await previewNarrativeCompression(id, options);
  if (preview.revision !== options.revision) throw new Error('记忆或容量已变化，请重新预览。');
  if (preview.changes.length) {
    const transaction = { version: 1, at: new Date().toISOString(), changes: preview.changes.map(({ scope, memoryId, level }) => ({ scope, memoryId, level })) };
    await appendFile(join(roleDir(id), 'memory-compression.jsonl'), '\n' + JSON.stringify(transaction) + '\n', { mode: 0o600 });
  }
  return preview;
}

async function restoreNarrative(id, scope, memoryId) {
  await loadPersona(id);
  if (typeof memoryId !== 'string' || !/^[a-f0-9-]{24,36}$/.test(memoryId) || !(await memoryRows(id, scope)).some((row) => row.id === memoryId)) throw new Error('找不到该记忆条目。');
  const transaction = { version: 1, at: new Date().toISOString(), changes: [{ scope, memoryId, level: 0 }] };
  await appendFile(join(roleDir(id), 'memory-compression.jsonl'), '\n' + JSON.stringify(transaction) + '\n', { mode: 0o600 });
  return { scope, memoryId, restored: true };
}

async function compactMemory(id, options = {}) {
  const limits = capacityOptions(options);
  const { flags, cards, groups } = await memoryInventory(id);
  const now = Date.now();
  const candidates = groups.flatMap(({ scope, rows }) => rows
    .filter((row) => {
      const state = flags.get(scope + ':' + row.id) || {};
      return !state.archived && !state.pinned;
    })
    .map((row) => ({ row, scope, state: flags.get(scope + ':' + row.id) || {} })))
    .sort((a, b) => memoryStatus(a.row, a.state, now, cards.get(a.scope + ':' + a.row.id)).weight - memoryStatus(b.row, b.state, now, cards.get(b.scope + ':' + b.row.id)).weight ||
      (Date.parse(a.row.at) || 0) - (Date.parse(b.row.at) || 0));
  const active = groups.reduce((sum, group) => sum + group.rows.filter((row) => !flags.get(group.scope + ':' + row.id)?.archived).length, 0);
  // Capacity cleanup is a no-op until the active set actually exceeds its cap.
  // Once over the cap, reduce it to the configured target while preserving pins.
  const count = active > limits.maxRecords
    ? Math.min(candidates.length, Math.max(0, active - limits.targetRecords))
    : 0;
  const selected = candidates.slice(0, count);
  if (selected.length) {
    const at = new Date().toISOString();
    await appendFile(join(roleDir(id), 'memory-archive.jsonl'),
      selected.map(({ row, scope }) => JSON.stringify({ scope, memoryId: row.id, enabled: true, at }) + '\n').join(''), { mode: 0o600 });
  }
  const protectedPinned = groups.flatMap(({ scope, rows }) => rows.filter((row) =>
    !flags.get(scope + ':' + row.id)?.archived && flags.get(scope + ':' + row.id)?.pinned)).length;
  return { archived: selected.length, protectedPinned, capacity: await memoryCapacity(id, limits) };
}

async function setMemoryStrength(id, scope, memoryId, enabled) {
  await loadPersona(id);
  if (typeof enabled !== 'boolean' || typeof memoryId !== 'string' || !/^[a-f0-9-]{24,36}$/.test(memoryId)) {
    throw new Error('记忆条目或强化状态无效。');
  }
  if (!(await memoryRows(id, scope)).some((row) => row.id === memoryId)) throw new Error('找不到该记忆条目。');
  await appendFile(join(roleDir(id), 'memory-strength.jsonl'),
    JSON.stringify({ scope, memoryId, enabled }) + '\n', { mode: 0o600 });
  return { id: memoryId, reinforced: enabled };
}

async function updateMemoryWeight(id, scope, memoryId, action, enabled) {
  await loadPersona(id);
  if (!['boost', 'pin'].includes(action) || (action === 'pin' && typeof enabled !== 'boolean') ||
      typeof memoryId !== 'string' || !/^[a-f0-9-]{24,36}$/.test(memoryId)) throw new Error('记忆操作无效。');
  if (!(await memoryRows(id, scope)).some((row) => row.id === memoryId)) throw new Error('找不到该记忆条目。');
  if (action === 'pin' && enabled && (await reinforcementFor(id)).get(scope + ':' + memoryId)?.archived) {
    throw new Error('请先恢复记忆，再永久固定。');
  }
  await appendFile(join(roleDir(id), 'memory-strength.jsonl'),
    JSON.stringify({ scope, memoryId, action, enabled, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return { id: memoryId, action };
}

async function updateMemoryArchive(id, scope, memoryId, archived) {
  await loadPersona(id);
  if (typeof archived !== 'boolean' || typeof memoryId !== 'string' || !/^[a-f0-9-]{24,36}$/.test(memoryId)) {
    throw new Error('记忆条目或归档状态无效。');
  }
  if (!(await memoryRows(id, scope)).some((row) => row.id === memoryId)) throw new Error('找不到该记忆条目。');
  const state = (await reinforcementFor(id)).get(scope + ':' + memoryId);
  if (archived && state?.pinned) throw new Error('请先取消永久固定，再归档记忆。');
  await appendFile(join(roleDir(id), 'memory-archive.jsonl'),
    JSON.stringify({ scope, memoryId, enabled: archived, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return { id: memoryId, archived };
}

async function readMemory(id, scope, { limit = 10, maxDays = 30, now = Date.now() } = {}) {
  if (limit <= 0) return [];
  const allRecords = await memoryRows(id, scope);
  if (!allRecords.length) return [];
  const flags = await reinforcementFor(id);
  const cards = await memoryCards(id);
  const state = (row) => flags.get(scope + ':' + row.id) || {};
  const card = (row) => cards.get(scope + ':' + row.id);
  const records = allRecords.filter((row) => !state(row).archived);
  const reinforced = (row) => state(row).reinforced || state(row).pinned;
  const priority = records.filter(reinforced).slice(-limit);
  const remaining = limit - priority.length;
  const recent = remaining ? records.filter((row) => !reinforced(row) && Math.max(Date.parse(row.at) || 0, Date.parse(state(row).boostedAt) || 0) >= now - maxDays * memoryStatus(row, state(row), now, card(row)).importance * 86_400_000)
    .sort((a, b) => memoryStatus(b, state(b), now, card(b)).weight - memoryStatus(a, state(a), now, card(a)).weight).slice(0, remaining) : [];
  const selected = new Set([...priority, ...recent]);
  return records.filter((row) => selected.has(row)).map((row) => {
    const card = cards.get(scope + ':' + row.id);
    return card ? { ...row, card: { who: card.who, event: card.event, feeling: card.feeling } } : row;
  });
}

function sharingPartition(scope) {
  if (scope === 'codex' || /^qq-(?:group-)?[1-9][0-9]{3,14}$/.test(scope)) return 'real';
  if (/^demo-(?:group-)?[1-9][0-9]{3,14}$/.test(scope)) return 'demo';
  return null;
}

function shareSourceAvailable(scope, row, { flags, cards, compression }, now) {
  const key = scope + ':' + row.id;
  const status = memoryStatus(row, flags.get(key), now, cards.get(key), compression.get(key));
  return !status.archived && status.clarityLevel === 0;
}

async function sharedConcepts(id, scope, limit = 12) {
  const partition = sharingPartition(scope);
  if (!partition) return [];
  const transactions = await extractionTransactions(id);
  const superseded = supersededCandidates(transactions);
  const revoked = await revokedConcepts(id);
  const { groups, flags, cards, compression } = await memoryInventory(id);
  const byScope = new Map(groups.map(({ scope: name, rows }) => [name, rows]));
  const concepts = [], used = new Set();
  const now = Date.now();
  for (const transaction of [...transactions].reverse()) {
    const origin = transaction.scope;
    if (origin === scope || sharingPartition(origin) !== partition || !Array.isArray(transaction.candidates)) continue;
    const rows = byScope.get(origin);
    if (!rows) continue;
    for (const candidate of [...transaction.candidates].reverse()) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
          typeof candidate.id !== 'string' || !/^[0-9a-f-]{24,36}$/.test(candidate.id) || superseded.has(candidate.id) || revoked.has(candidate.id) ||
          (candidate.ancestorCandidateIds || []).some((ancestorId) => revoked.has(ancestorId))) continue;
      if (readMemoryPrivacy(candidate.privacy).status !== 'review' ||
          !Array.isArray(candidate.sourceIds) || !candidate.sourceIds.length ||
          candidate.sourceIds.some((sourceId) => typeof sourceId !== 'string') || new Set(candidate.sourceIds).size !== candidate.sourceIds.length) continue;
      const referenced = candidate.sourceIds.map((sourceId) => rows.find((row) => row.id === sourceId));
      if (referenced.some((row) => !row)) continue;
      if (referenced.some((row) => !shareSourceAvailable(origin, row, { flags, cards, compression }, now))) continue;
      const sources = referenced.map(sourceRecord);
      const share = effectiveSharing(candidate, sources);
      if (!share) continue;
      if (createHash('sha256').update(JSON.stringify(sources)).digest('hex') !== share.sourceDigest ||
          assessMemoryPrivacy(candidate, sources).status !== 'review' || !shareSummaryIsUsable(share.summary, candidate, sources) || used.has(share.summary)) continue;
      used.add(share.summary);
      const nickname = sourcedNickname(candidate, sources);
      concepts.push({ candidateId: candidate.id, text: share.summary, originScope: origin, sourceIds: [...candidate.sourceIds],
        ...(nickname && { nickname }),
        relatedMemoryIds: [...(candidate.previousCandidateIds || [])] });
      if (concepts.length === limit) return concepts;
    }
  }
  return concepts;
}

async function revokedConcepts(id) {
  const revoked = new Set();
  const sharingRaw = await optionalRead(join(roleDir(id), 'memory-sharing-revoked.jsonl'));
  for (const line of sharingRaw?.split('\n').filter(Boolean) ?? []) {
    try {
      const item = JSON.parse(line);
      if (typeof item?.candidateId !== 'string' || !/^[0-9a-f-]{24,36}$/.test(item.candidateId)) throw new Error('invalid');
      revoked.add(item.candidateId);
    }
    catch { throw new Error('共享记忆撤销记录损坏，已停止跨对话共享。'); }
  }
  return revoked;
}

async function revokeSharedConcept(id, candidateId) {
  await loadPersona(id);
  if (typeof candidateId !== 'string' || !/^[0-9a-f-]{24,36}$/.test(candidateId)) throw new Error('候选记忆无效。');
  const transactions = await extractionTransactions(id);
  if (!transactions.some((transaction) => Array.isArray(transaction.candidates) && transaction.candidates.some((candidate) => candidate?.id === candidateId))) throw new Error('未找到候选记忆。');
  await appendFile(join(roleDir(id), 'memory-sharing-revoked.jsonl'), JSON.stringify({ candidateId, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return { candidateId, revoked: true };
}

async function memoryRecallPreview(id, scope, { includeShared = false } = {}) {
  await loadPersona(id);
  if (scope === 'shared') throw new Error('请选择一个对话范围预览召回。');
  if (typeof includeShared !== 'boolean') throw new Error('共享手记选项无效。');
  const limits = { shared: 12, recent: 10 };
  const [shared, recent] = await Promise.all([
    includeShared ? readMemory(id, 'shared', { limit: limits.shared, maxDays: Infinity }) : [],
    readMemory(id, scope, { limit: limits.recent }),
  ]);
  const selected = new Set([...shared.map((row) => 'shared:' + row.id), ...recent.map((row) => scope + ':' + row.id)]);
  const narrative = (await narrativeInventory(id)).filter((item) => selected.has(item.scope + ':' + item.memoryId) && item.text)
    .map(({ scope: sourceScope, memoryId, text, clarity, clarityReason }) => ({ scope: sourceScope, memoryId, text, clarity, clarityReason }));
  const concepts = await sharedConcepts(id, scope);
  return { scope, includeShared, shared, recent, narrative, sharedConcepts: concepts, limits };
}

async function characterContext(scope = 'codex', { includeShared = true } = {}) {
  const role = await activeCharacter();
  const { shared, recent, narrative, sharedConcepts } = await memoryRecallPreview(role.id, scope, { includeShared });
  return { ...role, shared, recent, narrative, sharedConcepts };
}

async function remember(id, text) {
  const value = cleanText(text, 1_000, '记忆');
  const active = await activeCharacter();
  if (active.id !== id) throw new Error('当前角色已切换，请重新读取角色。');
  await addMemory(id, 'shared', { note: value });
  return { character: id, saved: true };
}

export const activeCharacterStored = (...args) => withStorage(() => activeCharacter(...args));
export const listCharactersStored = (...args) => withStorage(() => listCharacters(...args));
export const createCharacterStored = (...args) => withStorage(() => createCharacter(...args));
export const activateCharacterStored = (...args) => withStorage(() => activateCharacter(...args));
export const characterDetailsStored = (...args) => withStorage(() => characterDetails(...args));
export const snapshotCharacterStored = (...args) => withStorage(() => snapshotCharacter(...args));
export const updatePersonaStored = (...args) => withStorage(() => updatePersona(...args));
export const restoreCharacterStored = (...args) => withStorage(() => restoreCharacter(...args));
export const addMemoryStored = (...args) => withStorage(() => addMemory(...args));
export const listMemoryPageStored = (...args) => withStorage(() => listMemoryPage(...args));
export const listMemoryItemsStored = (...args) => withStorage(() => listMemoryItems(...args));
export const memoryCapacityStored = (...args) => withStorage(() => memoryCapacity(...args));
export const compactMemoryStored = (...args) => withStorage(() => compactMemory(...args));
export const setMemoryStrengthStored = (...args) => withStorage(() => setMemoryStrength(...args));
export const updateMemoryWeightStored = (...args) => withStorage(() => updateMemoryWeight(...args));
export const updateMemoryArchiveStored = (...args) => withStorage(() => updateMemoryArchive(...args));
export const updateMemoryCardStored = (...args) => withStorage(() => updateMemoryCard(...args));
export const extractionStatus = (...args) => withStorage(() => extractionStatusInternal(...args));
export const commitExtraction = (...args) => withStorage(() => commitExtractionInternal(...args));
export const extractionSchedule = (...args) => withStorage(() => extractionScheduleInternal(...args));
export const setExtractionSchedule = (...args) => withStorage(() => setExtractionScheduleInternal(...args));
export const memoryActivityDates = (...args) => withStorage(() => memoryActivityDatesInternal(...args));
export const revokeSharedMemoryConcept = (...args) => withStorage(() => revokeSharedConcept(...args));
export const narrativeInventoryStored = (...args) => withStorage(() => narrativeInventory(...args));
export const narrativeCapacityStored = (...args) => withStorage(() => narrativeCapacity(...args));
export const narrativePolicyStored = (...args) => withStorage(() => narrativePolicy(...args));
export const setNarrativePolicyStored = (...args) => withStorage(() => setNarrativePolicy(...args));
export const previewNarrativeCompressionStored = (...args) => withStorage(() => previewNarrativeCompression(...args));
export const applyNarrativeCompressionStored = (...args) => withStorage(() => applyNarrativeCompression(...args));
export const restoreNarrativeStored = (...args) => withStorage(() => restoreNarrative(...args));
export const readMemoryStored = (...args) => withStorage(() => readMemory(...args));
export const memoryRecallPreviewStored = (...args) => withStorage(() => memoryRecallPreview(...args));
export const characterContextStored = (...args) => withStorage(() => characterContext(...args));
export const rememberStored = (...args) => withStorage(() => remember(...args));
export { activeCharacterStored as activeCharacter, listCharactersStored as listCharacters, createCharacterStored as createCharacter,
  activateCharacterStored as activateCharacter, characterDetailsStored as characterDetails, snapshotCharacterStored as snapshotCharacter,
  updatePersonaStored as updatePersona, restoreCharacterStored as restoreCharacter, addMemoryStored as addMemory,
  listMemoryPageStored as listMemoryPage, listMemoryItemsStored as listMemoryItems, memoryCapacityStored as memoryCapacity,
  compactMemoryStored as compactMemory, setMemoryStrengthStored as setMemoryStrength, updateMemoryWeightStored as updateMemoryWeight, updateMemoryArchiveStored as updateMemoryArchive, updateMemoryCardStored as updateMemoryCard,
  narrativeInventoryStored as narrativeInventory, narrativeCapacityStored as narrativeCapacity, narrativePolicyStored as narrativePolicy, setNarrativePolicyStored as setNarrativePolicy, previewNarrativeCompressionStored as previewNarrativeCompression, applyNarrativeCompressionStored as applyNarrativeCompression, restoreNarrativeStored as restoreNarrative,
  readMemoryStored as readMemory, memoryRecallPreviewStored as memoryRecallPreview, characterContextStored as characterContext,
  rememberStored as remember };
