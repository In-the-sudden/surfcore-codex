import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { addMemory, cleanText, listCharacters, listMemoryItems, listMemoryPage, memoryCapacity, compactMemory, memoryRecallPreview, setMemoryStrength, updateMemoryWeight, updateMemoryArchive, updateMemoryCard } from './store.mjs';
import { narrativeCapacity, narrativePolicy, setNarrativePolicy, previewNarrativeCompression, applyNarrativeCompression, restoreNarrative } from './store.mjs';
import { LANGUAGES, VOICE_PACKS, readBudget, readCharacterPreferences, setBudget, setLanguage, setVoice } from './settings.mjs';
import { loadVoices, previewVoice, synthesize } from './voice.mjs';
import { characterDetails, createCharacter, activateCharacter, updatePersona, snapshotCharacter, restoreCharacter } from './store.mjs';
import { readQuotaPolicy, setQuotaPolicy } from './settings.mjs';
import { accountStatus } from './account.mjs';
import { packStatus, configurePack, startPack, stopPack, checkPack } from './voice-manager.mjs';
import { createQQManager } from './qq-manager.mjs';
import { createSnowLumaManager } from './snowluma-manager.mjs';
import { getRoleStorage, moveRoleStorage } from './role-storage.mjs';
import { chooseStorageFolder, openStorageFolder } from './storage-ui.mjs';
import { extractionStatus, memoryExtractionStatus, extractMemoryBatch } from './memory-extraction.mjs';
import { memoryActivityDates, revokeSharedMemoryConcept } from './store.mjs';
import { dailyMemoryLimit, memoryDay } from './memory-daily-policy.mjs';
import { readDiary, appendDiary, replaceDiaryToday, deleteDiaryToday, composeDiary, reviewDiaryOnOpen } from './diary.mjs';
import { importSongRecording } from './qq-song.mjs';
import { join } from 'node:path';
import { voiceCache } from './voice-cache.mjs';

const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/panel.css', ['panel.css', 'text/css; charset=utf-8']],
  ['/memory-graph.css', ['memory-graph.css', 'text/css; charset=utf-8']],
  ['/panel.js', ['panel.js', 'text/javascript; charset=utf-8']],
  ['/qq.js', ['qq.js', 'text/javascript; charset=utf-8']],
]);

function reply(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src https://p.qpic.cn; media-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(body);
}

function json(res, status, data) {
  reply(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

async function body(req, max = 8_192) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new Error('需要 JSON 请求。');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > max) throw new Error('请求超过允许大小。');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('需要 JSON 对象。');
  return data;
}

async function requireCharacter(id) {
  const { characters } = await listCharacters();
  if (!characters.some((character) => character.id === id)) throw new Error('请选择已有角色。');
}

function hasKey(req, key) {
  const given = req.headers['x-surfcore-key'];
  if (typeof given !== 'string') return false;
  const input = Buffer.from(given);
  const expected = Buffer.from(key);
  return input.length === expected.length && timingSafeEqual(input, expected);
}

function memoryBridgeState(scope, bridge) {
  if (!scope.startsWith('qq-')) return 'manual';
  if (bridge.state !== 'connected') return bridge.state;
  if (bridge.mode !== 'send') return 'preview';
  if (bridge.paused) return 'paused';
  if (scope.startsWith('qq-group-')) {
    if (!bridge.config.groups.includes(scope.slice(9))) return 'not-allowed';
    if (!bridge.groupAuthorized) return 'group-authorization';
  } else if (![bridge.config.owner, ...bridge.config.admins].includes(scope.slice(3))) return 'not-allowed';
  return 'enabled';
}

export async function startPanel({ port = Number(process.env.SURFCORE_PANEL_PORT || 0), maintainVoiceCache = false, memoryGenerate } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('控制台端口无效。');
  const key = randomBytes(24).toString('base64url');
  const qq = createQQManager();
  const snowluma = createSnowLumaManager();
  let host;
  let origin;
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)) {
        return json(res, 403, { error: '控制台只接受本机同源访问。' });
      }
      const url = new URL(req.url, origin);
      if (url.origin !== origin) return json(res, 403, { error: '访问地址无效。' });
      const method = req.method;
      const path = url.pathname;
      const asset = ASSETS.get(path);
      if (method === 'GET' && asset) {
        const [file, mime] = asset;
        return reply(res, 200, await readFile(new URL('../panel/' + file, import.meta.url)), mime);
      }
      if (!path.startsWith('/api/')) return json(res, 404, { error: '页面不存在。' });
      if (!hasKey(req, key)) return json(res, 401, { error: '请从终端里的完整控制台地址重新打开。' });

      if (method === 'GET' && path === '/api/overview') {
        return json(res, 200, { ...await listCharacters(), budget: await readBudget(), quotaPolicy: await readQuotaPolicy(), languages: LANGUAGES, packs: VOICE_PACKS });
      }
      if (method === 'GET' && path === '/api/character') {
        const id = url.searchParams.get('id');
        return json(res, 200, { ...await characterDetails(id), memories: await listMemoryItems(id), preferences: await readCharacterPreferences(id) });
      }
      if (method === 'GET' && path === '/api/memories') {
        const id = url.searchParams.get('id');
        const scope = url.searchParams.get('scope') || '';
        const search = url.searchParams.get('search') || '';
        const offset = Number(url.searchParams.get('offset') || 0);
        return json(res, 200, await listMemoryPage(id, { scope, search, offset, limit: 50 }));
      }
      if (method === 'GET' && path === '/api/memory/preview') {
        const id = url.searchParams.get('id');
        const scope = url.searchParams.get('scope');
        const owner = (await qq.status()).config.owner || process.env.SURFCORE_QQ_OWNER;
        const includeShared = scope === 'codex' || (/^[1-9][0-9]{3,14}$/.test(owner || '') && scope === 'qq-' + owner);
        return json(res, 200, await memoryRecallPreview(id, scope, { includeShared }));
      }
      if (method === 'GET' && path === '/api/memory/extraction') {
        const id = url.searchParams.get('id'), scope = url.searchParams.get('scope');
        await requireCharacter(id);
        const bridge = await qq.status();
        const owner = bridge.config.owner || process.env.SURFCORE_QQ_OWNER;
        return json(res, 200, { ...await memoryExtractionStatus(id, scope, { owner }), bridgeState: memoryBridgeState(scope, bridge) });
      }
      if (method === 'GET' && path === '/api/diary') {
        const id = url.searchParams.get('id');
        await requireCharacter(id);
        return json(res, 200, await readDiary(id));
      }
      if (method === 'GET' && path === '/api/memory/daily-policy') {
        const id = url.searchParams.get('id'), scope = url.searchParams.get('scope');
        await requireCharacter(id);
        const owner = (await qq.status()).config.owner || process.env.SURFCORE_QQ_OWNER;
        if (!/^[1-9][0-9]{3,14}$/.test(owner || '')) throw new Error('请先配置主人 QQ，才能区分主人私聊。');
        const dates = await memoryActivityDates(id, scope);
        const { todayChars } = await extractionStatus(id, scope);
        return json(res, 200, { ...dailyMemoryLimit({ scope, owner, activeDays: dates.map(memoryDay), today: memoryDay(Date.now()) }), todayChars, activitySource: 'saved-replies' });
      }
      if (method === 'GET' && path === '/api/memory/capacity') {
        const id = url.searchParams.get('id');
        const maxRecords = Number(url.searchParams.get('maxRecords') || 200);
        const targetRecords = Number(url.searchParams.get('targetRecords') || 160);
        return json(res, 200, await memoryCapacity(id, { maxRecords, targetRecords }));
      }
      if (method === 'GET' && path === '/api/memory/narrative-capacity') {
        const id = url.searchParams.get('id'), policy = await narrativePolicy(id);
        const capacity = await narrativeCapacity(id, policy);
        const plan = capacity.full && policy.auto ? await previewNarrativeCompression(id, { ...policy, targetChars: Math.floor(policy.maxChars * 0.9) }) : null;
        return json(res, 200, { ...capacity, policy, blockedChars: plan?.blockedChars ?? 0 });
      }
      if (method === 'GET' && path === '/api/budget') return json(res, 200, await readBudget());
      if (method === 'GET' && path === '/api/account') return json(res, 200, await accountStatus());
      if (method === 'GET' && path === '/api/qq') return json(res, 200, await qq.status());
      if (method === 'GET' && path === '/api/snowluma') return json(res, 200, await snowluma.status());
      if (method === 'GET' && path === '/api/voice/cache') return json(res, 200, voiceCache.status());
      if (method === 'GET' && path === '/api/storage') return json(res, 200, await getRoleStorage());
      if (method === 'GET' && path === '/api/voice/status') return json(res, 200, await Promise.all(['local', 'cloud', 'breeze'].map(packStatus)));
      if (method === 'GET' && path === '/api/voices') return json(res, 200, await loadVoices(url.searchParams.get('providerId') || url.searchParams.get('pack')));
      if (method === 'PUT' && path === '/api/budget') {
        const value = await body(req);
        return json(res, 200, await setBudget(value.limit, value.weeklyLimit ?? null));
      }
      if (method !== 'POST') return json(res, 404, { error: '操作不存在。' });
      const limit = path === '/api/qq/faces/save' ? 350_000 : path.startsWith('/api/character/') ? 65_536 : 8_192;
      const data = await body(req, limit);
      switch (path) {
        case '/api/snowluma/start': return json(res, 200, await snowluma.start());
        case '/api/storage/choose': return json(res, 200, await chooseStorageFolder());
        case '/api/storage/move':
          if ((await qq.status()).state !== 'stopped') throw new Error('请先停止本控制台管理的 QQ 桥接。');
          await listCharacters();
          return json(res, 200, await moveRoleStorage(data.directory));
        case '/api/storage/open': {
          const storage = await getRoleStorage();
          if (data.characterId) {
            await requireCharacter(data.characterId);
            return json(res, 200, await openStorageFolder(join(storage.characters, data.characterId)));
          }
          return json(res, 200, await openStorageFolder(storage.directory));
        }
        case '/api/qq/settings': return json(res, 200, await qq.save(data));
        case '/api/qq/start': return json(res, 200, await qq.start(data));
        case '/api/qq/stop': return json(res, 200, await qq.stop());
        case '/api/qq/pause': return json(res, 200, await qq.pause(data.paused));
        case '/api/qq/faces/sync': return json(res, 200, await qq.syncFaces(data));
        case '/api/qq/faces/save': return json(res, 200, await qq.saveFaces(data));
        case '/api/qq/song/import': return json(res, 201, await importSongRecording(data));
        case '/api/voice/directory': return json(res, 200, await configurePack(data.providerId || data.pack, data.dir, { baseUrl: data.baseUrl, modelPath: data.modelPath, cpu: data.cpu }));
        case '/api/voice/start': return json(res, 200, await startPack(data.pack));
        case '/api/voice/stop': return json(res, 200, await stopPack(data.pack));
        case '/api/voice/check': return json(res, 200, await checkPack(data.pack));
        case '/api/character/create':
          return json(res, 201, await createCharacter(data.id, data.persona));
        case '/api/character/activate':
          return json(res, 200, await activateCharacter(data.id));
        case '/api/character/persona':
          return json(res, 200, await updatePersona(data.id, data.persona, data.revision));
        case '/api/character/snapshot':
          return json(res, 201, await snapshotCharacter(data.id));
        case '/api/character/restore':
          return json(res, 200, await restoreCharacter(data.id, data.snapshotId));
        case '/api/quota-policy':
          return json(res, 200, await setQuotaPolicy(data));
        case '/api/memory':
          return json(res, 201, { saved: true, ...await addMemory(data.characterId, 'shared', { note: cleanText(data.note, 1_000, '记忆') }) });
        case '/api/memory/strength':
          return json(res, 200, await setMemoryStrength(data.characterId, data.scope, data.memoryId, data.enabled));
        case '/api/memory/weight':
          return json(res, 200, await updateMemoryWeight(data.characterId, data.scope, data.memoryId, data.action, data.enabled));
        case '/api/memory/card':
          return json(res, 200, await updateMemoryCard(data.characterId, data.scope, data.memoryId, data.card));
        case '/api/memory/extraction': {
          await requireCharacter(data.characterId);
          const owner = (await qq.status()).config.owner || process.env.SURFCORE_QQ_OWNER;
          return json(res, 200, await extractMemoryBatch(data.characterId, data.scope, { owner, generate: memoryGenerate }));
        }
        case '/api/memory/sharing/revoke':
          await requireCharacter(data.characterId);
          return json(res, 200, await revokeSharedMemoryConcept(data.characterId, data.candidateId));
        case '/api/diary':
          await requireCharacter(data.characterId);
          return json(res, 201, await appendDiary(data.characterId, data.text));
        case '/api/diary/today':
          await requireCharacter(data.characterId);
          if (typeof data.day !== 'string' || typeof data.version !== 'string') throw new Error('请先刷新日记再保存。');
          return json(res, 200, await replaceDiaryToday(data.characterId, data.text, { expectedDay: data.day, expectedVersion: data.version }));
        case '/api/diary/today/delete':
          await requireCharacter(data.characterId);
          if (typeof data.day !== 'string' || typeof data.version !== 'string') throw new Error('请先刷新日记再删除。');
          return json(res, 200, await deleteDiaryToday(data.characterId, { expectedDay: data.day, expectedVersion: data.version }));
        case '/api/diary/compose':
          await requireCharacter(data.characterId);
          return json(res, 200, await composeDiary(data.characterId, data.scope));
        case '/api/diary/review-on-open': {
          const { active } = await listCharacters();
          return json(res, 200, await reviewDiaryOnOpen(active));
        }
        case '/api/memory/archive':
          return json(res, 200, await updateMemoryArchive(data.characterId, data.scope, data.memoryId, data.archived));
        case '/api/memory/compact':
          return json(res, 200, await compactMemory(data.characterId, { maxRecords: data.maxRecords, targetRecords: data.targetRecords }));
        case '/api/memory/narrative-preview':
          return json(res, 200, await previewNarrativeCompression(data.characterId, { maxChars: data.maxChars, warnChars: data.warnChars, targetChars: data.targetChars }));
        case '/api/memory/narrative-compress':
          return json(res, 200, await applyNarrativeCompression(data.characterId, { maxChars: data.maxChars, warnChars: data.warnChars, targetChars: data.targetChars, revision: data.revision }));
        case '/api/memory/narrative-restore':
          return json(res, 200, await restoreNarrative(data.characterId, data.scope, data.memoryId));
        case '/api/memory/narrative-policy':
          return json(res, 200, await setNarrativePolicy(data.characterId, data.policy));
        case '/api/language':
          await requireCharacter(data.characterId);
          return json(res, 200, await setLanguage(data.characterId, data.language));
        case '/api/voice': {
          await requireCharacter(data.characterId);
          const providerId = data.providerId ?? data.pack;
          if (providerId !== 'none') {
            const catalog = await loadVoices(providerId);
            if (!catalog.voices.some(({ id }) => id === data.voiceId)) throw new Error('语音包中没有选中的音色。');
          }
          if (data.allowOnline && data.fallback) {
            const catalog = await loadVoices(data.fallback.providerId);
            if (!catalog.voices.some(({ id }) => id === data.fallback.voiceId)) throw new Error('在线备选没有加载绑定的音色。');
          }
          return json(res, 200, await setVoice(data.characterId, providerId, data.voiceId, data));
        }
        case '/api/voice/synthesize': {
          const controller = new AbortController();
          const cancel = () => { if (!res.writableEnded) controller.abort(); };
          res.once('close', cancel);
          try {
            const { audio, ...result } = await synthesize({ ...data, signal: controller.signal });
            if (!res.destroyed) return json(res, 200, { ...result, ...(audio ? { audioBase64: audio.toString('base64') } : {}) });
            return;
          } finally { res.off('close', cancel); }
        }
        case '/api/voice/sample':
          return reply(res, 200, await previewVoice(data), 'audio/wav');
        default:
          return json(res, 404, { error: '操作不存在。' });
      }
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      host = '127.0.0.1:' + server.address().port;
      origin = 'http://' + host;
      server.off('error', reject);
      resolve();
    });
  });
  let cacheTimer;
  if (maintainVoiceCache) {
    void voiceCache.check();
    cacheTimer = setInterval(() => void voiceCache.check(), 60_000);
    cacheTimer.unref();
  }
  return { url: origin + '/#access=' + key, close: async () => {
    clearInterval(cacheTimer);
    await qq.stop();
    await Promise.all(['local', 'cloud', 'breeze'].map(stopPack));
    await new Promise((resolve) => server.close(resolve));
  } };
}
