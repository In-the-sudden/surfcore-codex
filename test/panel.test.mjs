import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = await mkdtemp(join(tmpdir(), 'surfcore-panel-test-'));
process.env.SURFCORE_DATA_DIR = data;
const store = await import('../plugin/src/store.mjs');
const settings = await import('../plugin/src/settings.mjs');
const { startPanel } = await import('../plugin/src/panel.mjs');
const { extractMemoryBatch } = await import('../plugin/src/memory-extraction.mjs');
await store.listCharacters();

test('panel serves browser assets and rejects unauthenticated or cross-origin changes', async () => {
  const panel = await startPanel({ port: 0 });
  const url = new URL(panel.url);
  const headers = { 'X-SurfCore-Key': new URLSearchParams(url.hash.slice(1)).get('access'), 'Content-Type': 'application/json' };
  try {
    for (const path of ['/', '/panel.js', '/panel.css', '/qq.js']) {
      const response = await fetch(url.origin + path);
      assert.equal(response.status, 200, path);
      assert.ok((await response.text()).length > 100);
    }
    const panelScript = await (await fetch(url.origin + '/panel.js')).text();
    assert.match(panelScript, /memoryCapacityState\.active > memoryCapacityState\.maxRecords/);
    assert.match(panelScript, /整理记忆容量（当前未超出上限）/);
    await store.createCharacter('panel-capacity', '# Panel Capacity');
    const capacityHeaders = { ...headers, 'Content-Type': 'application/json' };
    const capacity = await fetch(url.origin + '/api/memory/capacity?id=panel-capacity', { headers });
    assert.equal(capacity.status, 200);
    assert.equal((await capacity.json()).active, 0);
    const compact = await fetch(url.origin + '/api/memory/compact', { method: 'POST', headers: capacityHeaders, body: JSON.stringify({ characterId: 'panel-capacity' }) });
    assert.equal(compact.status, 200);
    assert.equal((await compact.json()).archived, 0);
    assert.equal((await fetch(url.origin + '/api/overview')).status, 401);
    assert.equal((await fetch(url.origin + '/api/overview', { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
    const request = (path, body, method = 'POST') => fetch(url.origin + path, { method, headers, body: JSON.stringify(body) });
    assert.equal((await request('/api/budget', { limit: -1 }, 'PUT')).status, 400);
    assert.equal((await request('/api/language', { characterId: 'lin', language: 'invalid' })).status, 400);
    assert.equal((await request('/api/memory', { characterId: 'lin', note: 'x'.repeat(9000) })).status, 400);
    assert.equal((await request('/api/qq/settings', { owner: '10002', selfId: '10001', admins: [], groups: [], wsUrl: 'ws://remote.test', httpUrl: 'http://127.0.0.1:3000' })).status, 400);
    assert.equal((await fetch(url.origin + '/api/qq', { headers })).status, 200);
    assert.equal((await request('/api/language', { characterId: 'lin', language: 'ja' })).status, 200);
    const result = await (await fetch(url.origin + '/api/character?id=lin', { headers })).json();
    assert.equal(result.preferences.language, 'ja');
    assert.equal((await settings.readCharacterPreferences('ming')).language, 'auto');
  } finally { await panel.close(); }
});

test('TTS endpoint protects mutations and returns explicit audio metadata or text fallback', async () => {
  const panel = await startPanel({ port: 0 });
  const url = new URL(panel.url), original = globalThis.fetch;
  const headers = { 'X-SurfCore-Key': new URLSearchParams(url.hash.slice(1)).get('access'), 'Content-Type': 'application/json' };
  const payload = { providerId: 'breeze', voiceId: 'missing', text: '保留这段文字。' };
  globalThis.fetch = (input, options) => String(input).startsWith('http://127.0.0.1:7860/') ? Promise.resolve(Response.json([])) : original(input, options);
  const request = (customHeaders) => fetch(url.origin + '/api/voice/synthesize', { method: 'POST', headers: customHeaders, body: JSON.stringify(payload) });
  try {
    assert.equal((await request({ 'Content-Type': 'application/json' })).status, 401);
    assert.equal((await request({ ...headers, Origin: 'https://remote.test' })).status, 403);
    const response = await request(headers), result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.status, 'text'); assert.equal(result.text, payload.text);
    assert.match(result.reason, /未自动更换/); assert.equal(result.audioBase64, undefined);
    const badSave = await fetch(url.origin + '/api/voice', { method: 'POST', headers, body: JSON.stringify({ characterId: 'lin', ...payload }) });
    assert.equal(badSave.status, 400);
    const saved = await fetch(url.origin + '/api/voice', { method: 'POST', headers, body: JSON.stringify({ characterId: 'lin', providerId: 'breeze', voiceId: '@design', style: { seed: 104 }, allowOnline: false }) });
    assert.equal(saved.status, 200); assert.equal((await saved.json()).providerId, 'breeze');
    await settings.setVoice('lin', 'none', '');
  } finally { globalThis.fetch = original; await panel.close(); }
});

test('diary endpoints require the local access key and keep entries out of recall', async () => {
  await store.createCharacter('diary-panel', '# Diary panel');
  const panel = await startPanel({ port: 0 });
  const url = new URL(panel.url);
  const headers = { 'X-SurfCore-Key': new URLSearchParams(url.hash.slice(1)).get('access'), 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(url.origin + '/api/diary?id=diary-panel')).status, 401);
    const post = await fetch(url.origin + '/api/diary', { method: 'POST', headers, body: JSON.stringify({ characterId: 'diary-panel', text: '不发送的日记' }) });
    assert.equal(post.status, 201);
    const diary = await (await fetch(url.origin + '/api/diary?id=diary-panel', { headers })).json();
    assert.equal(diary.entries[0].text, '不发送的日记');
    const stale = await fetch(url.origin + '/api/diary/today', { method: 'POST', headers, body: JSON.stringify({ characterId: 'diary-panel', text: '不应保存', day: diary.day, version: 'stale' }) });
    assert.notEqual(stale.status, 200);
    const saved = await fetch(url.origin + '/api/diary/today', { method: 'POST', headers, body: JSON.stringify({ characterId: 'diary-panel', text: '修改后的日记', day: diary.day, version: diary.version }) });
    assert.equal(saved.status, 200);
    const preview = await (await fetch(url.origin + '/api/memory/preview?id=diary-panel&scope=qq-10003', { headers })).json();
    assert.doesNotMatch(JSON.stringify(preview), /修改后的日记/);
  } finally { await panel.close(); }
});

test('QQ panel saves only selected favorites from the configured robot', async () => {
  const calls = [];
  const onebot = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, auth: req.headers.authorization, data: JSON.parse(Buffer.concat(chunks)) });
    const data = req.url === '/get_login_info' ? { user_id: 10001 } : [
      { emoji_id: 'first-star', desc: '星星', url: 'https://p.qpic.cn/example' },
      { emoji_id: 'second-star', desc: '星星', url: 'https://example.test/untrusted' },
    ];
    res.end(JSON.stringify({ retcode: 0, data }));
  });
  await new Promise((done) => onebot.listen(0, '127.0.0.1', done));
  const panel = await startPanel({ port: 0 });
  const url = new URL(panel.url);
  const headers = { 'X-SurfCore-Key': new URLSearchParams(url.hash.slice(1)).get('access'), 'Content-Type': 'application/json' };
  const post = (path, data) => fetch(url.origin + '/api/qq/' + path, { method: 'POST', headers, body: JSON.stringify(data) });
  try {
    const origin = 'http://127.0.0.1:' + onebot.address().port;
    assert.equal((await post('settings', { owner: '10002', selfId: '10001', admins: [], groups: [], wsUrl: origin.replace('http:', 'ws:'), httpUrl: origin })).status, 200);
    const response = await post('faces/sync', { httpToken: 'fixture-token' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(calls, [
      { path: '/get_login_info', auth: 'Bearer fixture-token', data: {} },
      { path: '/fetch_custom_face_detail', auth: 'Bearer fixture-token', data: { count: 100 } },
    ]);
    assert.deepEqual(result.faces.map(({ enabled }) => enabled), [false, false]);
    assert.equal(result.faces[1].image, undefined);
    assert.equal((await post('faces/save', { revision: result.revision, faces: [{ id: 'outside-favorites', label: '星星' }] })).status, 400);
    const saved = await post('faces/save', { revision: result.revision, faces: [{ id: 'second-star', label: '开心时发的星星' }] });
    assert.deepEqual(await saved.json(), { count: 1 });
    const refreshed = await (await post('faces/sync', {})).json();
    assert.deepEqual(refreshed.faces.map(({ enabled, label }) => [enabled, label]), [[false, '星星'], [true, '开心时发的星星']]);
  } finally {
    await panel.close();
    await new Promise((done) => onebot.close(done));
  }
});

test('shared concept revoke endpoint requires authentication and removes recall', async () => {
  await store.createCharacter('sharing-panel', '# Sharing');
  await store.addMemory('sharing-panel', 'qq-10002', { incoming: '最近我买了一把吉他想要学习' });
  const result = await extractMemoryBatch('sharing-panel', 'qq-10002', { owner: '10001', generate: async ({ message }) => {
    const { records } = JSON.parse(message);
    return JSON.stringify({ candidates: [{ sourceIds: [records[0].sourceId], who: '', event: '想学吉他', feeling: '', importance: 2,
      share: { decision: 'share', summary: '有人对练习乐器感兴趣' } }] });
  } });
  const panel = await startPanel({ port: 0 });
  const url = new URL(panel.url);
  const headers = { 'X-SurfCore-Key': new URLSearchParams(url.hash.slice(1)).get('access'), 'Content-Type': 'application/json' };
  const body = JSON.stringify({ characterId: 'sharing-panel', candidateId: result.candidates[0].id });
  try {
    assert.equal((await fetch(url.origin + '/api/memory/sharing/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
    assert.equal((await store.memoryRecallPreview('sharing-panel', 'qq-10003')).sharedConcepts.length, 1);
    assert.equal((await fetch(url.origin + '/api/memory/sharing/revoke', { method: 'POST', headers, body })).status, 200);
    assert.deepEqual((await store.memoryRecallPreview('sharing-panel', 'qq-10003')).sharedConcepts, []);
  } finally { await panel.close(); }
});

test('daily policy preview is per conversation and treats the owner separately', async () => {
  process.env.SURFCORE_QQ_OWNER = '10002';
  await store.createCharacter('daily-preview', '# Daily preview');
  await store.addMemory('daily-preview', 'qq-10003', { incoming: 'private' });
  await store.addMemory('daily-preview', 'qq-group-10004', { incoming: 'group' });
  const panel = await startPanel({ port: 0 });
  const url = new URL(panel.url);
  const headers = { 'X-SurfCore-Key': new URLSearchParams(url.hash.slice(1)).get('access') };
  const get = (scope) => fetch(url.origin + '/api/memory/daily-policy?id=daily-preview&scope=' + scope, { headers });
  try {
    assert.equal((await fetch(url.origin + '/api/memory/daily-policy?id=daily-preview&scope=qq-10003')).status, 401);
    assert.equal((await (await get('qq-10003')).json()).limit, 100);
    assert.equal((await (await get('qq-group-10004')).json()).limit, 300);
    assert.equal((await (await get('qq-10002')).json()).limit, null);
    assert.equal((await get('shared')).status, 400);
  } finally {
    await panel.close();
    delete process.env.SURFCORE_QQ_OWNER;
  }
});

test('extraction endpoint requires authentication and a single conversation', async () => {
  await store.createCharacter('extraction-panel', '# Extraction panel');
  await store.addMemory('extraction-panel', 'qq-10002', { incoming: 'hello', reply: 'hi' });
  const panel = await startPanel({ port: 0 });
  const url = new URL(panel.url);
  const headers = { 'X-SurfCore-Key': new URLSearchParams(url.hash.slice(1)).get('access'), 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(url.origin + '/api/memory/extraction?id=extraction-panel&scope=qq-10002')).status, 401);
    const response = await fetch(url.origin + '/api/memory/extraction?id=extraction-panel&scope=qq-10002', { headers });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.pending, 1);
    assert.equal(status.processed, 0);
    assert.deepEqual(status.candidates, []);
    assert.equal('batch' in status, false);
    assert.equal((await fetch(url.origin + '/api/memory/extraction?id=extraction-panel&scope=shared', { headers })).status, 400);
    assert.equal((await fetch(url.origin + '/api/memory/extraction', { method: 'POST', headers, body: JSON.stringify({ characterId: 'extraction-panel', scope: 'shared' }) })).status, 400);
    assert.equal((await fetch(url.origin + '/api/memory/extraction?id=missing&scope=qq-10002', { headers })).status, 400);
  } finally { await panel.close(); }
});

test('panel model compression exposes structured cards and anonymous recall in another group', async () => {
  const originalOwner = process.env.SURFCORE_QQ_OWNER;
  process.env.SURFCORE_QQ_OWNER = '10001';
  await store.createCharacter('group-memory-panel', '# Group memory');
  const scope = 'qq-group-10004';
  await store.addMemory('group-memory-panel', scope, { incoming: '我第一次去公园参加了观鸟活动，认出了不少常见鸟类。',
    messages: [{ senderId: '10005', messageId: '9', text: '我第一次去公园参加了观鸟活动，认出了不少常见鸟类。' }] });
  const panel = await startPanel({ port: 0, memoryGenerate: async ({ message }) => {
    const input = JSON.parse(message);
    assert.equal(input.conversation.kind, 'group');
    assert.equal(input.records[0].messages[0].senderId, '10005');
    return JSON.stringify({ candidates: [{ sourceIds: [input.records[0].sourceId], who: '10005', event: '首次参加观鸟活动', feeling: '', importance: 2,
      share: { decision: 'share', summary: '有人开始参加观鸟活动' } }] });
  } });
  const url = new URL(panel.url);
  const headers = { 'X-SurfCore-Key': new URLSearchParams(url.hash.slice(1)).get('access'), 'Content-Type': 'application/json' };
  const get = async (path) => {
    const response = await fetch(url.origin + '/api/' + path, { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  const extraction = 'memory/extraction?id=group-memory-panel&scope=' + scope;
  try {
    const before = await get(extraction);
    assert.equal(before.pending, 1);
    assert.equal(before.bridgeState, 'stopped');
    const response = await fetch(url.origin + '/api/memory/extraction', { method: 'POST', headers,
      body: JSON.stringify({ characterId: 'group-memory-panel', scope }) });
    assert.equal(response.status, 200, await response.text());
    const after = await get(extraction);
    assert.equal(after.processed, 1);
    assert.equal(after.pending, 0);
    assert.equal(after.shareableCount, 1);
    assert.ok(after.lastProcessedAt);
    const { items } = await get('memories?id=group-memory-panel&scope=' + scope);
    assert.equal(items[0].modelCards[0].who, '10005');
    assert.equal(items[0].modelCards[0].event, '首次参加观鸟活动');
    const other = await get('memory/preview?id=group-memory-panel&scope=qq-group-10006');
    assert.deepEqual(other.sharedConcepts.map(({ text }) => text), ['有人开始参加观鸟活动']);
    assert.equal(JSON.stringify(other).includes('10005'), false);
  } finally {
    await panel.close();
    if (originalOwner === undefined) delete process.env.SURFCORE_QQ_OWNER;
    else process.env.SURFCORE_QQ_OWNER = originalOwner;
  }
});

test('legacy reinforcement recalls expired memory only in original role and scope', async () => {
  await writeFile(join(data, 'characters/lin/qq-10002.jsonl'), JSON.stringify({ at: '2020-01-01T00:00:00Z', incoming: 'old secret', reply: 'ok' }) + '\n');
  const [item] = await store.listMemoryItems('lin');
  assert.equal((await store.readMemory('lin', 'qq-10002')).length, 0);
  await store.setMemoryStrength('lin', item.scope, item.id, true);
  assert.equal((await store.readMemory('lin', 'qq-10002'))[0].incoming, 'old secret');
  assert.equal((await store.readMemory('ming', 'qq-10002')).length, 0);
  assert.equal((await store.readMemory('lin', 'qq-10004')).length, 0);
  await store.setMemoryStrength('lin', item.scope, item.id, false);
  assert.equal((await store.readMemory('lin', 'qq-10002')).length, 0);
});

test('budget persists, blocks exhausted day, rolls at Hong Kong midnight and exposes unknown usage', async () => {
  const before = new Date('2026-11-07T15:59:59Z');
  const after = new Date('2026-11-07T16:00:00Z');
  await settings.setBudget(100);
  await settings.recordUsage(before, { totalTokens: 100 });
  await settings.recordUsage(before, null);
  assert.deepEqual(await settings.readBudget(before), { date: '2026-11-07', limit: 100, weeklyLimit: null, used: 100, weeklyUsed: 100, turns: 2, unreported: 1 });
  await assert.rejects(settings.requireBudget(before));
  await settings.requireBudget(after);
  assert.equal((await settings.readBudget(after)).date, '2026-11-08');
  await settings.setBudget(null, 100);
  await assert.rejects(settings.requireBudget(after), /本周额度/);
  await settings.setBudget(null);
  await settings.requireBudget(before);
});

test('percentage mode skips daily fixed limit but retains weekly limit and resets on Hong Kong Monday', async () => {
  const sunday = new Date('2026-11-08T15:59:59Z');
  const monday = new Date('2026-11-08T16:00:00Z');
  await settings.recordUsage(sunday, { totalTokens: 75 });
  await settings.recordUsage(monday, { totalTokens: 50 });
  await settings.setBudget(50, 100);
  await settings.setQuotaPolicy({ enabled: true, primaryRemaining: 20, secondaryRemaining: 10 });
  assert.equal((await settings.readBudget(monday)).weeklyUsed, 50);
  await settings.requireBudget(monday);
  await settings.recordUsage(monday, { totalTokens: 50 });
  await assert.rejects(settings.requireBudget(monday), /本周额度/);
  await settings.setQuotaPolicy({ enabled: false, primaryRemaining: 20, secondaryRemaining: 10 });
  await assert.rejects(settings.requireBudget(monday), /今日额度/);
  await settings.setBudget(null);
});

test('memory APIs page and search records, and preview shared notes only for Codex or configured owner', async () => {
  process.env.SURFCORE_QQ_OWNER = '10002';
  await store.createCharacter('memory-api', '# Memory API');
  await store.addMemory('memory-api', 'shared', { note: 'shared private fact' });
  await store.addMemory('memory-api', 'qq-10002', { incoming: 'owner message', reply: 'owner reply' });
  await store.addMemory('memory-api', 'qq-10003', { incoming: 'admin message', reply: 'admin reply' });
  await store.addMemory('memory-api', 'qq-group-10002', { incoming: 'group message', reply: 'group reply' });
  const panel = await startPanel({ port: 0 });
  const url = new URL(panel.url);
  const headers = { 'X-SurfCore-Key': new URLSearchParams(url.hash.slice(1)).get('access') };
  const get = (path) => fetch(url.origin + path, { headers });
  try {
    const list = await (await get('/api/memories?id=memory-api&search=owner')).json();
    assert.equal(list.total, 1);
    assert.equal(list.items[0].scope, 'qq-10002');
    const cardResponse = await fetch(url.origin + '/api/memory/card', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'memory-api', scope: 'qq-10002', memoryId: list.items[0].id, card: { who: '主人', event: '一起聊天', feeling: '', importance: 2 } }) });
    assert.equal(cardResponse.status, 200);
    assert.equal((await (await get('/api/memories?id=memory-api&search=owner')).json()).items[0].importance, 2);
    assert.equal((await get('/api/memories?id=memory-api&offset=-1')).status, 400);
    const preview = async (scope) => (await get('/api/memory/preview?id=memory-api&scope=' + scope + '&includeShared=true')).json();
    assert.equal((await preview('codex')).shared[0].note, 'shared private fact');
    assert.equal((await preview('qq-10002')).shared[0].note, 'shared private fact');
    const initial = await preview('qq-10002');
    assert.deepEqual(initial.limits, { recent: 10, shared: 12 });
    assert.ok(initial.narrative.some(({ text }) => text.includes('主人')));
    assert.ok(initial.narrative.every(({ scope }) => ['shared', 'qq-10002'].includes(scope)));
    const capacity = await (await get('/api/memory/narrative-capacity?id=memory-api')).json();
    assert.equal(capacity.policy.maxChars, 0);
    const options = { characterId: 'memory-api', maxChars: 0, warnChars: 100, targetChars: 80 };
    const plan = await (await fetch(url.origin + '/api/memory/narrative-preview', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(options) })).json();
    assert.match(plan.revision, /^[a-f0-9]{64}$/);
    const stale = await fetch(url.origin + '/api/memory/narrative-compress', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...options, revision: '0'.repeat(64) }) });
    assert.equal(stale.status, 400);
    const changeArchive = (archived) => fetch(url.origin + '/api/memory/archive', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'memory-api', scope: 'qq-10002', memoryId: list.items[0].id, archived }) });
    assert.equal((await changeArchive(true)).status, 200);
    assert.equal((await (await get('/api/memories?id=memory-api&search=owner')).json()).items[0].archived, true);
    assert.deepEqual((await preview('qq-10002')).recent, []);
    assert.equal((await changeArchive(false)).status, 200);
    assert.equal((await preview('qq-10002')).recent[0].incoming, 'owner message');
    const admin = await preview('qq-10003');
    assert.deepEqual(admin.shared, []);
    assert.equal(admin.recent[0].incoming, 'admin message');
    const group = await preview('qq-group-10002');
    assert.deepEqual(group.shared, []);
    assert.equal(group.recent[0].incoming, 'group message');
    const saved = await fetch(url.origin + '/api/qq/settings', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: '10003', selfId: '10009', admins: [], groups: [], wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000' }) });
    assert.equal(saved.status, 200);
    assert.deepEqual((await preview('qq-10002')).shared, []);
    assert.equal((await preview('qq-10003')).shared[0].note, 'shared private fact');
  } finally {
    await panel.close();
    delete process.env.SURFCORE_QQ_OWNER;
  }
});

test('panel storage settings move role data only through an authenticated request', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'surfcore-panel-destination-'));
  const panel = await startPanel({ port: 0 });
  const url = new URL(panel.url);
  const headers = { 'X-SurfCore-Key': new URLSearchParams(url.hash.slice(1)).get('access'), 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(url.origin + '/api/storage')).status, 401);
    const response = await fetch(url.origin + '/api/storage/move', { method: 'POST', headers, body: JSON.stringify({ directory: destination }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).directory, destination);
    const storage = await (await fetch(url.origin + '/api/storage', { headers })).json();
    assert.equal(storage.directory, destination);
    const role = await (await fetch(url.origin + '/api/character?id=memory-api', { headers })).json();
    assert.match(role.persona, /Memory API/);
    assert.equal((await store.listMemoryPage('memory-api', { scope: 'shared' })).items[0].note, 'shared private fact');
  } finally { await panel.close(); }
});
