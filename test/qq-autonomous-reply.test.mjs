import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

test('short replies are synthesized before the model chooses the format, with text on a missed deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surfcore-autonomous-reply-'));
  const previous = process.env.SURFCORE_DATA_DIR;
  process.env.SURFCORE_DATA_DIR = directory;
  const { createMessageHandler, sampleEvent } = await import('../plugin/src/bridge.mjs');
  const audio = Buffer.from('candidate audio');
  const calls = [], sent = [];
  let reply = '我在呢。', format = 'voice', timedOut = false, song;
  const handle = createMessageHandler({
    owner: '10002', selfId: '10001', record: false, simulated: true,
    generate: async ({ mediaPlan }) => {
      assert.equal(mediaPlan, true);
      calls.push('write');
      return JSON.stringify(song ? { action: 'sing', song } : { action: 'speak', text: reply });
    },
    prepareReplyVoice: async (_roleId, spokenText, timeoutMs) => {
      assert.equal(spokenText, reply);
      assert.equal(timeoutMs, 4000);
      calls.push('synthesize');
      return timedOut ? null : audio;
    },
    chooseReplyFormat: async ({ reply: candidate }) => {
      assert.equal(candidate, reply);
      calls.push('choose');
      return format;
    },
    resolveReplySong: async (request) => {
      assert.deepEqual(request, song);
      calls.push('song');
      return { text: '来唱这一句。', audio };
    },
    deliver: async (_contact, text, _kind, wav) => sent.push({ text, wav }),
  });
  try {
    await handle(sampleEvent('有点累', 1));
    assert.deepEqual(calls.splice(0), ['write', 'synthesize', 'choose']);
    assert.deepEqual(sent.at(-1), { text: reply, wav: audio });

    format = 'text';
    await handle(sampleEvent('那就聊几句吧', 2));
    assert.deepEqual(calls.splice(0), ['write', 'synthesize', 'choose']);
    assert.deepEqual(sent.at(-1), { text: reply, wav: undefined });

    timedOut = true;
    await handle(sampleEvent('你在吗', 3));
    assert.deepEqual(calls.splice(0), ['write', 'synthesize']);
    assert.deepEqual(sent.at(-1), { text: reply, wav: undefined });

    timedOut = false;
    reply = '一二三四五六七八九十一二三四五六';
    await handle(sampleEvent('说长一点', 4));
    assert.deepEqual(calls.splice(0), ['write']);
    assert.deepEqual(sent.at(-1), { text: reply, wav: undefined });

    song = { title: '小小奇迹', line: '指定句子' };
    await handle(sampleEvent('唱小小奇迹的指定句子', 5));
    assert.deepEqual(calls.splice(0), ['write', 'song']);
    assert.deepEqual(sent.at(-1), { text: '来唱这一句。', wav: audio });

    await tGroupBurst(createMessageHandler, sampleEvent);
    await testBackgroundSong(createMessageHandler, sampleEvent);
    await testRevokedSong(createMessageHandler, sampleEvent);
    await testSelectedFaces(createMessageHandler, sampleEvent);
  } finally {
    await handle.close();
    if (previous === undefined) delete process.env.SURFCORE_DATA_DIR;
    else process.env.SURFCORE_DATA_DIR = previous;
    if (dirname(resolve(directory)) === resolve(tmpdir())) await rm(directory, { recursive: true, force: true });
  }
});

async function testSelectedFaces(createMessageHandler, sampleEvent) {
  let face = 1, enabled = true;
  const sent = [];
  const handle = createMessageHandler({
    owner: '10002', selfId: '10001', record: false,
    loadReplyFaces: async () => enabled ? [{ id: 'private-resource-id', label: '贴贴' }] : [],
    generate: async ({ faceOptions }) => {
      assert.deepEqual(faceOptions, [{ choice: 1, label: '贴贴' }]);
      if (face === 1 && sent.length === 2) enabled = false;
      return { action: 'speak', text: '贴贴。', face };
    },
    sendReplyFace: async (contact, kind, id) => { sent.push({ contact, kind, id }); },
    deliver: async (_contact, text) => sent.push({ text }),
  });
  try {
    await handle(sampleEvent('抱抱', 1));
    assert.deepEqual(sent.at(-1), { contact: '10002', kind: 'private', id: 'private-resource-id' });
    face = 2;
    await handle(sampleEvent('抱抱', 2));
    assert.deepEqual(sent.at(-1), { text: '贴贴。' });
    face = 1;
    await handle(sampleEvent('抱抱', 3));
    assert.deepEqual(sent.at(-1), { text: '贴贴。' });
  } finally { await handle.close(); }
}

async function testRevokedSong(createMessageHandler, sampleEvent) {
  const entered = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const sent = [];
  const handle = createMessageHandler({
    owner: '10002', selfId: '10001', groups: ['10004'], social: { enabled: true },
    record: false, simulated: true,
    generate: async () => ({ action: 'sing', song: { title: '新歌' } }),
    resolveReplySong: async () => ({
      text: '我先找音源。',
      learn: async (signal) => {
        entered.resolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        cancelled.resolve();
        return { audio: Buffer.from('late song'), text: '唱给你听。' };
      },
    }),
    deliver: async (_contact, text, _kind, audio) => sent.push({ text, audio }),
  });
  try {
    await handle(sampleEvent('同意群聊', 30));
    const event = sampleEvent('唱新歌', 31);
    event.message.unshift({ type: 'at', data: { qq: '10001' } });
    await handle({ ...event, message_type: 'group', group_id: 10004, user_id: 10003 });
    await entered.promise;
    await handle(sampleEvent('撤销群聊', 32));
    let timer;
    try {
      await Promise.race([cancelled.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Revocation did not cancel the song job')), 500);
      })]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await handle.close();
  }
  assert.equal(sent.filter(({ audio }) => audio).length, 0);
}

async function testBackgroundSong(createMessageHandler, sampleEvent) {
  let started = false;
  const complete = Promise.withResolvers();
  const delivered = Promise.withResolvers();
  const audio = Buffer.from('learned song');
  const sent = [];
  const handle = createMessageHandler({
    owner: '10002', selfId: '10001', record: false, simulated: true,
    generate: async ({ message }) => message === '唱新歌'
      ? { action: 'sing', song: { title: '新歌', section: 'first30' } }
      : { action: 'speak', text: '还在。' },
    resolveReplySong: async () => ({
      text: '我先找音源。',
      learn: async () => { started = true; return complete.promise; },
    }),
    deliver: async (contact, text, _kind, clip) => {
      sent.push({ contact, text, clip });
      if (clip) delivered.resolve();
    },
  });
  try {
    await handle(sampleEvent('唱新歌', 10));
    assert.equal(started, true);
    await handle(sampleEvent('你还在吗', 11));
    assert.deepEqual(sent.map(({ text }) => text), ['我先找音源。', '还在。']);
    complete.resolve({ audio, text: '唱给你听。', credit: '原唱和授权来源' });
    const timeout = setTimeout(() => delivered.reject(new Error('learned song was never delivered')), 1000);
    try { await delivered.promise; } finally { clearTimeout(timeout); }
    assert.deepEqual(sent.slice(2), [
      { contact: '10002', text: '原唱和授权来源', clip: undefined },
      { contact: '10002', text: '唱给你听。', clip: audio },
    ]);
  } finally {
    complete.resolve({});
    await handle.close();
  }
}

async function tGroupBurst(createMessageHandler, sampleEvent) {
  const prompts = [];
  const handle = createMessageHandler({
    owner: '10002', selfId: '10001', groups: ['10004'], social: { enabled: true }, groupBursts: true,
    record: false, simulated: true, deliver: async () => {},
    generate: async ({ message }) => {
      prompts.push(JSON.parse(message));
      return { action: 'speak', text: '收到。' };
    },
  });
  try {
    await handle(sampleEvent('同意群聊', 20));
    const messages = [
      [{ type: 'at', data: { qq: '10001' } }],
      [{ type: 'text', data: { text: '唱小小奇迹' } }],
      [{ type: 'text', data: { text: '只唱副歌第一句' } }],
    ];
    const pending = messages.map((message, index) => handle({
      post_type: 'message', message_type: 'group', self_id: 10001, group_id: 10004, user_id: 10003,
      message_id: 21 + index, message,
    }));
    await new Promise(setImmediate);
    await handle.idle();
    await Promise.all(pending);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].wakeReason, 'atMention');
    assert.equal(prompts[0].unread.length, 1);
    assert.deepEqual(prompts[0].unread[0].messageIds, ['21', '22', '23']);
    assert.match(prompts[0].unread[0].text, /唱小小奇迹\n只唱副歌第一句/);
  } finally {
    await handle.close();
  }
}
