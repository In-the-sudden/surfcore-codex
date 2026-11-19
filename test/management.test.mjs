import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.SURFCORE_DATA_DIR = await mkdtemp(join(tmpdir(), 'surfcore-management-'));
const store = await import('../plugin/src/store.mjs');
const settings = await import('../plugin/src/settings.mjs');

test('voice manager identifies incomplete packs and refuses to start missing runtime', async () => {
  const voice = await import('../plugin/src/voice-manager.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'surfcore-empty-voice-'));
  const info = await voice.configurePack('local', dir);
  assert.equal(info.readyToStart, false);
  assert.ok(info.missing.includes('config.toml'));
  await assert.rejects(voice.startPack('local'), /缺少/);
  await assert.rejects(voice.configurePack('invalid', dir));
});

test('legacy voice preferences remain readable and new provider/style/permission events are append-only', async () => {
  const file = join(process.env.SURFCORE_DATA_DIR, 'panel-settings.jsonl');
  const legacy = JSON.stringify({ type: 'voice', characterId: 'legacy-voice', pack: 'local', voiceId: 'old' }) + '\n';
  await appendFile(file, legacy);
  const previous = await readFile(file, 'utf8');
  const old = await settings.readCharacterPreferences('legacy-voice');
  assert.equal(old.providerId, 'local'); assert.equal(old.voiceId, 'old'); assert.equal(old.allowOnline, false);
  await settings.setVoice('legacy-voice', 'breeze', 'saved', { style: { instruction: 'Warm.', seed: 104, cfgScale: 1.5 },
    allowOnline: true, fallback: { providerId: 'cloud', voiceId: 'bound' } });
  const current = await settings.readCharacterPreferences('legacy-voice');
  assert.equal(current.pack, 'breeze'); assert.equal(current.providerId, 'breeze'); assert.equal(current.style.seed, 104);
  assert.equal(current.fallback.voiceId, 'bound'); assert.equal(current.allowOnline, true);
  assert.ok((await readFile(file, 'utf8')).startsWith(previous));
  await assert.rejects(settings.setVoice('legacy-voice', 'breeze', 'saved', { allowOnline: true }), /绑定/);
  await assert.rejects(settings.setVoice('legacy-voice', 'breeze', 'saved', { style: { speed: 2 } }), /风格/);
  await settings.setVoice('legacy-voice', 'none', '');
  const cleared = await settings.readCharacterPreferences('legacy-voice');
  assert.equal(cleared.allowOnline, false); assert.equal(cleared.fallback, null); assert.deepEqual(cleared.style, {});
});

test('Breeze status separates listener, health and synthesis; stop never kills an external service', async () => {
  const service = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/health' ? { status: 'ok', sample_rate: 24000 } : [])); });
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
  const voice = await import('../plugin/src/voice-manager.mjs');
  const { configureProvider } = await import('../plugin/src/voice-config.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'surfcore-breeze-'));
  const baseUrl = 'http://127.0.0.1:' + service.address().port;
  try {
    for (const invalid of ['http://remote.test:7860', 'http://user:pass@127.0.0.1:7860', 'http://127.0.0.1:7860/private']) await assert.rejects(configureProvider({ providerId: 'breeze', baseUrl: invalid }));
    const state = await voice.configurePack('breeze', dir, { baseUrl });
    assert.equal(state.running, true); assert.equal(state.health.healthy, true); assert.equal(state.synthesis, null);
    assert.equal(state.managed, false); assert.equal(state.readyToStart, false);
    await voice.stopPack('breeze');
    assert.equal((await fetch(baseUrl + '/health')).status, 200);
  } finally { await new Promise((resolve) => service.close(resolve)); }
});

test('persona edits reject stale versions; snapshots restore persona without deleting later memories', async () => {
  await store.listCharacters();
  const initial = await store.characterDetails('lin');
  const snapshot = await store.snapshotCharacter('lin');
  await store.updatePersona('lin', '# Changed\nNew personality', initial.revision);
  await assert.rejects(store.updatePersona('lin', '# Stale', initial.revision), /已更改/);
  await store.addMemory('lin', 'shared', { note: 'after snapshot' });
  await store.restoreCharacter('lin', snapshot.id);
  assert.equal((await store.characterDetails('lin')).persona, initial.persona);
  assert.equal((await store.readMemory('lin', 'shared'))[0].note, 'after snapshot');
  await assert.rejects(store.restoreCharacter('lin', '../outside'));
  await store.createCharacter('new-role', '# New role');
  await store.activateCharacter('new-role');
  assert.equal((await store.activeCharacter()).id, 'new-role');
});

test('account percentage guard blocks either quota window and rejects unavailable quota when enabled', async () => {
  const { enforceQuota } = await import('../plugin/src/quota.mjs');
  const limits = { primary: { usedPercent: 60, resetsAt: Date.now()/1000+500 }, secondary: { usedPercent: 91, resetsAt: Date.now()/1000+500 } };
  assert.throws(() => enforceQuota(limits, { enabled: true, primaryRemaining: 20, secondaryRemaining: 10 }), /额度/);
  assert.doesNotThrow(() => enforceQuota(limits, { enabled: true, primaryRemaining: 20, secondaryRemaining: 5 }));
  assert.throws(() => enforceQuota(null, { enabled: true, primaryRemaining: 20, secondaryRemaining: 10 }), /读取/);
  assert.doesNotThrow(() => enforceQuota(null, { enabled: false }));
  await settings.setQuotaPolicy({ enabled: true, primaryRemaining: 20, secondaryRemaining: 10 });
  assert.equal((await settings.readQuotaPolicy()).primaryRemaining, 20);
  await assert.rejects(settings.setQuotaPolicy({ enabled: true, primaryRemaining: -1, secondaryRemaining: 10 }));
});
