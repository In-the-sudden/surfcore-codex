import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const dir = await mkdtemp(join(tmpdir(), 'surfcore-qq-test-'));
process.env.SURFCORE_DATA_DIR = dir;
let unreadFileId = 0;
const unreadStateFile = () => join(dir, 'social-unread-' + (++unreadFileId) + '.jsonl');
const { createQQManager, snowTokens } = await import('../plugin/src/qq-manager.mjs');
const { createMessageHandler, sampleEvent } = await import('../plugin/src/bridge.mjs');

test('SnowLuma credentials require matching bot and endpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snow-config-test-'));
  try {
    await mkdir(join(root, 'config'));
    await writeFile(join(root, 'config', 'onebot_10001.json'), JSON.stringify({ networks: {
      httpServers: [{ host: '127.0.0.1', port: 3000, path: '/', accessToken: 'http-secret' }],
      wsServers: [{ host: '127.0.0.1', port: 3001, path: '/', accessToken: 'ws-secret' }],
    } }));
    const config = { selfId: '10001', httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001' };
    assert.deepEqual(await snowTokens(config, root), { httpToken: 'http-secret', wsToken: 'ws-secret' });
    await assert.rejects(snowTokens({ ...config, httpUrl: 'http://127.0.0.1:3002' }, root), /无法匹配/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('QQ settings validate, persist without tokens, and control only the managed bridge', async () => {
  let options;
  const manager = createQQManager({ runner: async (value) => {
    options = value;
    value.onEvent({ type: 'connected' });
    await new Promise((resolve) => value.signal.addEventListener('abort', resolve, { once: true }));
  }, generate: async () => 'stub' });
  try {
    const config = { owner: '10002', selfId: '10001', admins: ['10003', '10003'], groups: ['10004'], wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000' };
    assert.equal((await manager.status()).state, 'stopped');
    await assert.rejects(manager.save({ ...config, httpUrl: 'http://example.com:3000' }), /本机/);
    await assert.rejects(manager.save({ ...config, admins: ['10001'] }), /机器人/);
    assert.deepEqual((await manager.save(config)).config.admins, ['10003']);
    await writeFile(join(dir, 'qq-settings.json'), JSON.stringify({ ...config, social: { enabled: true, botName: '知微', keywords: ['海边'], speakerIds: ['10003'], probability: 0.05 } }));
    assert.equal((await manager.status()).config.imageDelayCompensation, true);
    await assert.rejects(manager.save({ ...config, imageDelayCompensation: 'false' }), /图片慢加载/);
    await manager.save({ ...config, imageDelayCompensation: false });
    assert.equal((await manager.save(config)).config.imageDelayCompensation, false);
    assert.deepEqual((await manager.status()).config.social.botNames, ['知微']);
    assert.deepEqual((await manager.save(config)).config.social.botNames, ['知微']);
    const namesConfig = { enabled: true, botNames: ['知微', ' 小知 ', '小知'], keywords: ['海边'], speakerIds: ['10003'], probability: 0.05 };
    const savedNames = (await manager.save({ ...config, social: namesConfig })).config.social;
    assert.deepEqual(savedNames.botNames, ['知微', '小知']);
    assert.equal(savedNames.botName, '知微');
    assert.deepEqual((await manager.status()).config.social.botNames, ['知微', '小知']);
    const oldPanelSettings = { enabled: true, botName: '知微', keywords: ['海边'], speakerIds: ['10003'], probability: 0.05 };
    assert.deepEqual((await manager.save({ ...config, social: oldPanelSettings })).config.social.botNames, ['知微', '小知']);
    await assert.rejects(manager.save({ ...config, social: { ...namesConfig, botNames: Array(21).fill('name') } }), /最多 20/);
    await assert.rejects(manager.save({ ...config, social: { ...namesConfig, botNames: ['x'.repeat(41)] } }), /40 字符/);
    assert.deepEqual((await manager.save({ ...config, social: { ...namesConfig, botName: '知微', botNames: [] } })).config.social.botNames, []);
    await manager.save({ ...config, social: namesConfig });
    const starting = manager.start({ mode: 'preview', wsToken: 'private-ws', httpToken: 'private-http' });
    await assert.rejects(manager.start({ mode: 'preview' }), /已启动/);
    await starting;
    assert.equal((await manager.status()).state, 'connected');
    assert.equal(options.send, false);
    assert.equal(options.imageDelayCompensation, false);
    assert.deepEqual(options.social.botNames, ['知微', '小知']);
    assert.equal(options.shouldContinue(), true);
    await manager.pause(true);
    assert.equal(options.shouldContinue(), false);
    await assert.rejects(manager.save(config), /先停止/);
    await manager.pause(false);
    assert.equal(options.shouldContinue(), true);
    await manager.stop();
    assert.equal((await manager.status()).state, 'stopped');
    assert.equal(options.shouldContinue(), false);
    const saved = await readFile(join(dir, 'qq-settings.json'), 'utf8');
    assert.doesNotMatch(saved, /private-ws|private-http/);
  } finally { await manager.stop(); }
});

test('nickname wake remains gated by session consent and group allowlist', async () => {
  let groupCalls = 0;
  const handler = createMessageHandler({ owner: '10002', selfId: '10001', groups: ['10004'], record: false,
    simulated: true, askGroupConsent: true, social: { enabled: true, botNames: ['知微', '小知'], probability: 0 },
    generate: async ({ decisionMode }) => { if (decisionMode) groupCalls++; return decisionMode ? JSON.stringify({ action: 'speak', text: 'ok' }) : 'ok'; },
    deliver: async () => {},
  });
  const group = (id, groupId) => ({ ...sampleEvent('小知，过来', id), user_id: 10003, message_type: 'group', group_id: groupId });
  assert.equal(await handler(group(1, 10004)), null);
  await handler(sampleEvent('同意群聊', 2));
  assert.equal(await handler(group(3, 10005)), null);
  assert.equal((await handler(group(4, 10004))).action, 'speak');
  assert.equal(groupCalls, 1);
  await handler(sampleEvent('撤销群聊', 5));
  assert.equal(await handler(group(6, 10004)), null);
  await handler.close();
});

test('pausing during generation cancels old replies and queued messages even after resume', async () => {
  let paused = false, generation = 0, begin, release, delivered = 0, generated = 0;
  const started = new Promise((resolve) => { begin = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const handler = createMessageHandler({ owner: '10002', selfId: '10001', record: false,
    shouldContinue: () => !paused,
    generationToken: () => generation,
    generate: async () => { generated++; begin(); await gate; return 'test reply'; },
    deliver: async () => { delivered++; },
  });
  const first = handler(sampleEvent('first', 1));
  await started;
  const second = handler(sampleEvent('queued', 2));
  paused = true; generation++;
  paused = false;
  release();
  assert.equal(await first, null);
  assert.equal(await second, null);
  assert.equal(generated, 1);
  assert.equal(delivered, 0);
  await rm(dir, { recursive: true, force: true });
});

test('social opt-in accumulates whitelisted group unread until a model speaks; owner private remains direct', async () => {
  const delivered = [], prompts = [];
  const handler = createMessageHandler({ owner: '10002', selfId: '10001', groups: ['10004'], record: false,
    unreadStateFile: unreadStateFile(),
    social: { enabled: true, botName: '知微', keywords: ['海边'], speakerIds: ['10005'], probability: 0 },
    generate: async ({ message, decisionMode }) => {
      prompts.push({ payload: JSON.parse(message), decisionMode });
      return JSON.stringify({ action: prompts.length === 1 ? 'wait' : 'speak', text: '预览结果' });
    },
    deliver: async (contact, reply) => delivered.push([contact, reply]),
  });
  assert.equal((await handler(sampleEvent('同意群聊', 0))).action, 'authorization');
  const group = (text, id, sender = 10003) => {
    const base = sampleEvent(text, id);
    return { ...base, user_id: sender, message_type: 'group', group_id: 10004 };
  };
  assert.equal((await handler(group('普通聊天', 1))).reason, 'no-trigger');
  assert.equal((await handler(group('知微，你觉得呢', 2))).action, 'wait');
  assert.deepEqual(prompts[0].payload.unread.map((message) => message.text), ['普通聊天', '知微，你觉得呢']);
  assert.equal((await handler(group('海边很漂亮', 3))).action, 'speak');
  assert.deepEqual(prompts[1].payload.unread.map((message) => message.text), ['普通聊天', '知微，你觉得呢', '海边很漂亮']);
  assert.equal(delivered.length, 2);
  const privateHandler = createMessageHandler({ owner: '10002', selfId: '10001', social: { enabled: true }, record: false,
    generate: async ({ decisionMode }) => { assert.equal(decisionMode, false); return '主人私聊回复'; },
    deliver: async (contact, reply) => delivered.push([contact, reply]),
  });
  await privateHandler(sampleEvent('主人来信', 10));
  assert.deepEqual(delivered.at(-1), ['10002', '主人私聊回复']);
});

test('model failures preserve unread and malformed decisions never reach the preview delivery callback', async () => {
  let calls = 0, previews = 0;
  const handler = createMessageHandler({ owner: '10002', selfId: '10001', groups: ['10004'], record: false,
    unreadStateFile: unreadStateFile(),
    social: { enabled: true, botName: '知微' },
    generate: async ({ message }) => {
      const unread = JSON.parse(message).unread;
      calls++;
      if (calls === 1) throw new Error('model unavailable');
      if (unread.length === 2) return 'not valid decision';
      return JSON.stringify({ action: 'speak', text: '可预览' });
    },
    deliver: async (contact, reply, kind) => { if (kind === 'group') previews++; },
  });
  assert.equal((await handler(sampleEvent('同意群聊', 0))).authorized, true);
  const event = (text, id) => {
    const base = sampleEvent(text, id);
    return { ...base, user_id: 10003, message_type: 'group', group_id: 10004 };
  };
  await assert.rejects(handler(event('知微，来看看', 1)), /model unavailable/);
  assert.equal((await handler(event('知微，还在吗', 2))).action, 'wait');
  assert.equal(previews, 0);
  assert.equal((await handler(event('知微，继续聊', 3))).action, 'speak');
  assert.equal(previews, 1);
});

test('group consent is prompted after an owner reply and lasts only for the allowlisted groups in this bridge session', async () => {
  const delivered = [], modes = [];
  let calls = 0;
  const options = {
    owner: '10002', selfId: '10001', groups: ['10004'], record: false, askGroupConsent: true,
    unreadStateFile: unreadStateFile(),
    social: { enabled: true, botName: '知微', probability: 0 },
    generate: async ({ decisionMode }) => {
      calls++;
      modes.push(decisionMode);
      return decisionMode ? JSON.stringify({ action: 'speak', text: '群聊回复' }) : '主号回复';
    },
    deliver: async (contact, reply, kind) => delivered.push({ contact, reply, kind }),
  };
  const handler = createMessageHandler(options);
  await handler(sampleEvent('你好', 1));
  assert.equal(delivered.length, 2);
  assert.match(delivered[1].reply, /同意群聊/);
  assert.match(delivered[1].reply, /白名单外群始终不处理/);

  const group = (text, id, groupId = 10004) => {
    const event = sampleEvent(text, id);
    return { ...event, user_id: 10003, message_type: 'group', group_id: groupId };
  };
  assert.equal(await handler(group('知微，你觉得呢？', 2)), null);
  assert.equal(await handler(group('知微，你觉得呢？', 3, 10005)), null);
  assert.equal(calls, 1);

  assert.equal((await handler(sampleEvent('同意群聊。', 4))).effective, true);
  assert.equal((await handler(group('知微，你觉得呢？', 5))).action, 'speak');
  assert.equal(modes.at(-1), true);
  assert.equal((await handler(sampleEvent('撤销群聊', 6))).authorized, false);
  assert.equal(await handler(group('知微，再聊聊？', 7)), null);

  const nextSession = createMessageHandler(options);
  assert.equal(await nextSession(group('知微，你觉得呢？', 8)), null);
});
