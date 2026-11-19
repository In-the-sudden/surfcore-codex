import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnreadPool, evaluateWake, validateSocialDecision } from '../plugin/src/social.mjs';

test('unread pool deduplicates, bounds history, isolates sessions and marks through a watermark', () => {
  const pool = new UnreadPool({ limit: 2, ttlMs: 60_000 });
  assert.equal(pool.add('group:1', { messageId: '1', text: 'first' }, 1000), true);
  assert.equal(pool.add('group:1', { messageId: '1', text: 'duplicate' }, 1000), false);
  pool.add('group:1', { messageId: '2', text: 'second' }, 1001);
  pool.add('group:1', { messageId: '3', text: 'third' }, 1002);
  pool.add('private:1', { messageId: '1', text: 'private' }, 1002);
  assert.deepEqual(pool.unread('group:1').map(({ messageId }) => messageId), ['2', '3']);
  assert.equal(pool.markRead('group:1', '2'), 1);
  assert.deepEqual(pool.unread('group:1').map(({ messageId }) => messageId), ['3']);
  assert.equal(pool.unread('private:1')[0].text, 'private');
  assert.equal(pool.add('expired', { messageId: 'old', text: 'old', at: 1 }, 1000), true);
  assert.equal(pool.add('expired', { messageId: 'new', text: 'new' }, 100_000), true);
  assert.deepEqual(pool.unread('expired').map(({ messageId }) => messageId), ['new']);
});

test('unread state survives restart, read markers persist, and storage stays compact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'surfcore-social-'));
  const stateFile = join(dir, 'unread.jsonl');
  const options = { limit: 2, ttlMs: 60_000, stateFile, lock: async (work) => work() };
  try {
    const first = new UnreadPool(options);
    await first.ready();
    const now = Date.now();
    first.add('qq-group-10004', { messageId: '1', text: 'first' }, now);
    first.add('qq-group-10004', { messageId: '2', text: 'second' }, now + 1);
    await first.flush();

    const second = new UnreadPool(options);
    await second.ready();
    assert.deepEqual(second.unread('qq-group-10004').map(({ messageId }) => messageId), ['1', '2']);
    assert.equal(second.markRead('qq-group-10004', '1'), 1);
    await second.flush();

    const third = new UnreadPool(options);
    await third.ready();
    assert.deepEqual(third.unread('qq-group-10004').map(({ messageId }) => messageId), ['2']);
    third.clear('qq-group-10004');
    await third.flush();
    assert.deepEqual((await readFile(stateFile, 'utf8')).trim().split('\n').map(JSON.parse).at(-1).sessions, {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pending social decisions persist with their unread watermark', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'surfcore-social-'));
  const stateFile = join(dir, 'unread.jsonl');
  const options = { stateFile, lock: async (work) => work() };
  try {
    const pool = new UnreadPool(options);
    await pool.ready();
    const incoming = { kind: 'group', contact: '10004', messageId: '10', text: '稍后回答', senderId: '10003', atBot: true };
    pool.add('qq-group-10004', incoming);
    assert.equal(pool.setPending('qq-group-10004', { action: 'lurk', deadline: Date.now() + 5_000, waitMs: 5_000, watermark: '10', incoming }), true);
    await pool.flush();

    const restored = new UnreadPool(options);
    await restored.ready();
    const pending = restored.pending('qq-group-10004');
    assert.equal(pending.action, 'lurk');
    assert.equal(pending.waitMs, 5_000);
    assert.equal(pending.watermark, '10');
    assert.ok(Number.isFinite(pending.deadline));
    assert.deepEqual(pending.incoming, incoming);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('expired unread and pending state is pruned from persisted snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'surfcore-social-'));
  const stateFile = join(dir, 'unread.jsonl');
  const now = Date.now();
  const incoming = { kind: 'group', contact: '10004', messageId: '10', text: '稍后回答', senderId: '10003', atBot: true };
  await writeFile(stateFile, JSON.stringify({
    op: 'snapshot',
    sessions: { 'qq-group-10004': [{ messageId: '10', text: '稍后回答', at: now - 5_000, senderId: '10003' }] },
    seen: { 'qq-group-10004': ['10'] },
    pending: { 'qq-group-10004': { action: 'lurk', deadline: now - 1_000, waitMs: 5_000, watermark: '10', incoming } },
  }) + '\n');
  try {
    const pool = new UnreadPool({ stateFile, ttlMs: 1_000, lock: async (work) => work() });
    await pool.ready();
    await pool.flush();
    assert.deepEqual(pool.unread('qq-group-10004'), []);
    assert.equal(pool.pending('qq-group-10004'), null);
    const snapshot = JSON.parse((await readFile(stateFile, 'utf8')).trim().split('\n').at(-1));
    assert.deepEqual(snapshot.sessions, {});
    assert.deepEqual(snapshot.pending, {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('wake triggers distinguish explicit calls, questions, speakers and low-probability participation', () => {
  const config = { enabled: true, botName: '知微', speakerIds: ['42'], keywords: ['海边'], probability: 0.05, random: () => 0.01 };
  assert.equal(evaluateWake({ text: '@知微 在吗' }, config).reason, 'atMention');
  assert.equal(evaluateWake({ text: '知微，你觉得呢？' }, config).reason, 'nameMention');
  assert.equal(evaluateWake({ text: '这个周末怎么样？' }, config).reason, 'question');
  assert.equal(evaluateWake({ text: '普通消息', senderId: '42' }, config).reason, 'speaker');
  assert.equal(evaluateWake({ text: '闲聊' }, config).reason, 'probability');
  assert.equal(evaluateWake({ text: '闲聊' }, { ...config, probability: 0, random: () => 0 }).wake, false);
  assert.equal(evaluateWake({ text: '@知微', isSelf: true }, config).wake, false);
  assert.equal(evaluateWake({ text: '闲聊' }, { ...config, enabled: false }).wake, false);
});

test('multiple names and nicknames trigger without changing legacy matching', () => {
  const settings = { enabled: true, botNames: ['知微', '小知', 'A+B'], question: false, probability: 0 };
  assert.equal(evaluateWake({ text: '知微，过来' }, settings).reason, 'nameMention');
  assert.equal(evaluateWake({ text: '小知，过来' }, settings).reason, 'nameMention');
  assert.equal(evaluateWake({ text: '@小知 过来' }, settings).reason, 'atMention');
  assert.equal(evaluateWake({ text: 'A+B，过来' }, settings).reason, 'nameMention');
  assert.equal(evaluateWake({ text: 'AAAB，过来' }, settings).wake, false);
  assert.equal(evaluateWake({ text: '小知，过来' }, { ...settings, enabled: false }).wake, false);
  assert.equal(evaluateWake({ text: '小知，过来', isSelf: true }, settings).wake, false);
  assert.equal(evaluateWake({ text: '知微，过来' }, { ...settings, botNames: [], botName: '知微' }).wake, false);
  assert.equal(evaluateWake({ text: '知微，过来' }, { enabled: true, botName: '知微', question: false }).reason, 'nameMention');
});

test('social decisions only speak with explicit bounded text and otherwise wait or lurk', () => {
  assert.deepEqual(validateSocialDecision('{"action":"speak","text":"你好"}'), { action: 'speak', text: '你好' });
  assert.deepEqual(validateSocialDecision({ action: 'wait', waitMs: 500 }), { action: 'wait', waitMs: 5000 });
  assert.equal(validateSocialDecision({ action: 'lurk', waitMs: 50_000 }).action, 'lurk');
  assert.equal(validateSocialDecision({ action: 'speak', text: '' }).action, 'wait');
  assert.equal(validateSocialDecision('not json').action, 'wait');
  assert.equal(validateSocialDecision({ action: 'send', text: 'unsafe' }).action, 'wait');
  assert.equal(validateSocialDecision({ action: 'speak', text: 'x'.repeat(1001) }).action, 'wait');
});

test('wait timer retries unread only within the same authorized bridge session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'surfcore-social-'));
  const oldData = process.env.SURFCORE_DATA_DIR;
  process.env.SURFCORE_DATA_DIR = dir;
  try {
    const { createMessageHandler, sampleEvent } = await import('../plugin/src/bridge.mjs');
    const timers = [], delivered = [], calls = [];
    const handler = createMessageHandler({
      owner: '10002', selfId: '10001', groups: ['10004'], record: false,
      social: { enabled: true, botName: '知微', probability: 0 },
      stateLock: async (work) => work(), waitMinMs: 0,
      scheduleTimer: (callback, waitMs) => { const timer = { callback, waitMs, cancelled: false, unref() {} }; timers.push(timer); return timer; },
      cancelTimer: (timer) => { timer.cancelled = true; },
      generate: async ({ message }) => { calls.push(JSON.parse(message)); return JSON.stringify({ action: 'wait', waitMs: 5000 }); },
      deliver: async (contact, reply, kind) => delivered.push({ contact, reply, kind }),
    });
    const group = (text, id) => {
      const base = sampleEvent(text, id);
      return { ...base, user_id: '10003', message_type: 'group', group_id: '10004',
        message: [{ type: 'at', data: { qq: '10001' } }, ...base.message] };
    };
    await handler(sampleEvent('同意群聊', 1));
    assert.equal((await handler(group('知微，能听到吗？', 2))).action, 'wait');
    assert.equal(timers[0].waitMs, 5000);
    await handler(sampleEvent('撤销群聊', 3));
    timers[0].callback();
    await handler.idle();
    assert.equal(calls.length, 1);
    assert.equal(delivered.filter((item) => item.kind === 'group').length, 0);
    await handler.close();
  } finally {
    if (oldData === undefined) delete process.env.SURFCORE_DATA_DIR;
    else process.env.SURFCORE_DATA_DIR = oldData;
    await rm(dir, { recursive: true, force: true });
  }
});

test('simulated social handlers never persist unread state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'surfcore-social-'));
  const oldData = process.env.SURFCORE_DATA_DIR;
  process.env.SURFCORE_DATA_DIR = dir;
  const stateFile = join(dir, 'unread.jsonl');
  try {
    const { createMessageHandler, sampleEvent } = await import('../plugin/src/bridge.mjs');
    const handler = createMessageHandler({
      owner: '10002', selfId: '10001', groups: ['10004'], simulated: true,
      persistUnread: true, unreadStateFile: stateFile, record: false,
      social: { enabled: true, botName: '知微', probability: 0 }, waitMinMs: 0,
      stateLock: async (work) => work(), scheduleTimer: () => ({ unref() {} }), cancelTimer: () => {},
      generate: async () => JSON.stringify({ action: 'wait', waitMs: 5000 }), deliver: async () => {},
    });
    const base = sampleEvent('稍后回答', 2);
    await handler(sampleEvent('同意群聊', 1));
    assert.equal((await handler({ ...base, user_id: '10003', message_type: 'group', group_id: '10004',
      message: [{ type: 'at', data: { qq: '10001' } }, ...base.message] })).action, 'wait');
    await handler.close();
    await assert.rejects(readFile(stateFile), (error) => error.code === 'ENOENT');
  } finally {
    if (oldData === undefined) delete process.env.SURFCORE_DATA_DIR;
    else process.env.SURFCORE_DATA_DIR = oldData;
    await rm(dir, { recursive: true, force: true });
  }
});

test('revoking group consent clears persisted state even for groups removed from the whitelist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'surfcore-social-'));
  const oldData = process.env.SURFCORE_DATA_DIR;
  process.env.SURFCORE_DATA_DIR = dir;
  const stateFile = join(dir, 'unread.jsonl');
  try {
    const { createMessageHandler, sampleEvent } = await import('../plugin/src/bridge.mjs');
    const options = {
      owner: '10002', selfId: '10001', record: false, persistUnread: true, unreadStateFile: stateFile,
      social: { enabled: true, botName: '知微', probability: 0 }, waitMinMs: 0,
      stateLock: async (work) => work(), scheduleTimer: () => ({ unref() {} }), cancelTimer: () => {},
      generate: async () => JSON.stringify({ action: 'wait', waitMs: 5000 }), deliver: async () => {},
    };
    const base = sampleEvent('稍后回答', 2);
    const first = createMessageHandler({ ...options, groups: ['10004'] });
    await first(sampleEvent('同意群聊', 1));
    await first({ ...base, user_id: '10003', message_type: 'group', group_id: '10004',
      message: [{ type: 'at', data: { qq: '10001' } }, ...base.message] });
    await first.close();

    const second = createMessageHandler({ ...options, groups: ['10005'] });
    await second(sampleEvent('撤销群聊', 3));
    await second.close();
    const snapshot = JSON.parse((await readFile(stateFile, 'utf8')).trim().split('\n').at(-1));
    assert.deepEqual(snapshot.sessions, {});
    assert.deepEqual(snapshot.pending, {});
  } finally {
    if (oldData === undefined) delete process.env.SURFCORE_DATA_DIR;
    else process.env.SURFCORE_DATA_DIR = oldData;
    await rm(dir, { recursive: true, force: true });
  }
});

test('expired lurk survives restart but resumes only after fresh authorization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'surfcore-social-'));
  const oldData = process.env.SURFCORE_DATA_DIR;
  process.env.SURFCORE_DATA_DIR = dir;
  const stateFile = join(dir, 'unread.jsonl');
  try {
    const { createMessageHandler, sampleEvent } = await import('../plugin/src/bridge.mjs');
    const timers = [], calls = [], delivered = [];
    const options = {
      owner: '10002', selfId: '10001', groups: ['10004'], record: false,
      persistUnread: true, unreadStateFile: stateFile,
      social: { enabled: true, botName: '知微', probability: 0 },
      stateLock: async (work) => work(), waitMinMs: 0,
      scheduleTimer: (callback, waitMs) => { const timer = { callback, waitMs, cancelled: false, unref() {} }; timers.push(timer); return timer; },
      cancelTimer: (timer) => { timer.cancelled = true; },
      generate: async ({ message }) => {
        calls.push(JSON.parse(message));
        return calls.length === 1 ? JSON.stringify({ action: 'lurk', waitMs: 5000 }) : JSON.stringify({ action: 'speak', text: '现在可以回答了' });
      },
      deliver: async (contact, reply, kind) => delivered.push({ contact, reply, kind }),
    };
    const group = (text, id, mention = false) => {
      const base = sampleEvent(text, id);
      return { ...base, user_id: '10003', message_type: 'group', group_id: '10004',
        message: [...(mention ? [{ type: 'at', data: { qq: '10001' } }] : []), ...base.message] };
    };

    const first = createMessageHandler(options);
    await first(sampleEvent('同意群聊', 1));
    assert.equal((await first(group('知微，稍后回答？', 2, true))).action, 'lurk');
    await first.close();
    const saved = JSON.parse((await readFile(stateFile, 'utf8')).trim());
    assert.equal(saved.pending['qq-group-10004'].action, 'lurk');
    assert.equal(saved.pending['qq-group-10004'].watermark, '2');
    saved.pending['qq-group-10004'].deadline = Date.now() - 1;
    await writeFile(stateFile, JSON.stringify(saved) + '\n');

    const second = createMessageHandler(options);
    assert.equal(await second(group('未授权群消息', 3, true)), null);
    assert.equal(timers.length, 1);
    await second(sampleEvent('同意群聊', 4));
    assert.equal(timers.length, 2);
    assert.equal(timers[1].waitMs, 0);
    timers[1].callback();
    await second.idle();
    assert.equal(calls.length, 1);
    assert.equal((await second(group('补充一句', 5))).reason, 'no-trigger');
    assert.equal(timers.length, 3);
    assert.equal(timers[2].waitMs, 5000);
    timers[2].callback();
    await second.idle();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].unread.map(({ messageId }) => messageId), ['2', '5']);
    assert.deepEqual(delivered.filter((item) => item.kind === 'group').map(({ reply }) => reply), ['现在可以回答了']);
    await second.close();
  } finally {
    if (oldData === undefined) delete process.env.SURFCORE_DATA_DIR;
    else process.env.SURFCORE_DATA_DIR = oldData;
    await rm(dir, { recursive: true, force: true });
  }
});

test('lurk waits for a new unread message before scheduling another model decision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'surfcore-social-'));
  const oldData = process.env.SURFCORE_DATA_DIR;
  process.env.SURFCORE_DATA_DIR = dir;
  try {
    const { createMessageHandler, sampleEvent } = await import('../plugin/src/bridge.mjs');
    const timers = [], delivered = [], calls = [];
    const handler = createMessageHandler({
      owner: '10002', selfId: '10001', groups: ['10004'], record: false,
      social: { enabled: true, botName: '知微', probability: 0 },
      stateLock: async (work) => work(), waitMinMs: 0,
      scheduleTimer: (callback, waitMs) => { const timer = { callback, waitMs, cancelled: false, unref() {} }; timers.push(timer); return timer; },
      cancelTimer: (timer) => { timer.cancelled = true; },
      generate: async ({ message }) => {
        calls.push(JSON.parse(message));
        return calls.length === 1 ? JSON.stringify({ action: 'lurk', waitMs: 5000 }) : JSON.stringify({ action: 'speak', text: '收到' });
      },
      deliver: async (contact, reply, kind) => delivered.push({ contact, reply, kind }),
    });
    const group = (text, id, mention) => {
      const base = sampleEvent(text, id);
      return { ...base, user_id: '10003', message_type: 'group', group_id: '10004',
        message: [...(mention ? [{ type: 'at', data: { qq: '10001' } }] : []), ...base.message] };
    };
    await handler(sampleEvent('同意群聊', 1));
    assert.equal((await handler(group('知微，稍后回答？', 2, true))).action, 'lurk');
    timers[0].callback();
    await handler.idle();
    assert.equal(calls.length, 1);
    assert.equal((await handler(group('继续补充背景', 3, false))).reason, 'no-trigger');
    assert.equal(timers.length, 2);
    timers[1].callback();
    await handler.idle();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].unread.map(({ text }) => text).join('|'), '知微，稍后回答？|继续补充背景');
    assert.deepEqual(delivered.filter((item) => item.kind === 'group').map(({ reply }) => reply), ['收到']);
    await handler.close();
  } finally {
    if (oldData === undefined) delete process.env.SURFCORE_DATA_DIR;
    else process.env.SURFCORE_DATA_DIR = oldData;
    await rm(dir, { recursive: true, force: true });
  }
});

test('unread backlog survives a new handler but cannot be processed before fresh authorization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'surfcore-social-'));
  const oldData = process.env.SURFCORE_DATA_DIR;
  process.env.SURFCORE_DATA_DIR = dir;
  try {
    const { createMessageHandler, sampleEvent } = await import('../plugin/src/bridge.mjs');
    const calls = [], delivered = [];
    const options = {
      owner: '10002', selfId: '10001', groups: ['10004'], record: false,
      persistUnread: true, unreadStateFile: join(dir, 'unread.jsonl'),
      social: { enabled: true, botName: '知微', probability: 0 },
      stateLock: async (work) => work(), generate: async ({ message }) => {
        calls.push(JSON.parse(message)); return JSON.stringify({ action: 'speak', text: '收到' });
      },
      deliver: async (contact, reply, kind) => delivered.push({ contact, reply, kind }),
    };
    const group = (text, id, mention = false) => {
      const base = sampleEvent(text, id);
      return { ...base, user_id: '10003', message_type: 'group', group_id: '10004',
        message: [...(mention ? [{ type: 'at', data: { qq: '10001' } }] : []), ...base.message] };
    };
    const first = createMessageHandler(options);
    await first(sampleEvent('同意群聊', 1));
    await first(group('断线前的未读', 2));
    await first.close();

    const second = createMessageHandler(options);
    assert.equal(await second(group('未授权时不处理？', 3, true)), null);
    assert.equal(calls.length, 0);
    await second(sampleEvent('同意群聊', 4));
    await second(group('恢复后的新消息？', 5, true));
    assert.deepEqual(calls[0].unread.map(({ text }) => text), ['断线前的未读', '恢复后的新消息？']);
    assert.equal(delivered.filter((item) => item.kind === 'group').length, 1);
    await second.close();
  } finally {
    if (oldData === undefined) delete process.env.SURFCORE_DATA_DIR;
    else process.env.SURFCORE_DATA_DIR = oldData;
    await rm(dir, { recursive: true, force: true });
  }
});
