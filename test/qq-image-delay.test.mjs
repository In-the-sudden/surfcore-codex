import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'surfcore-image-delay-'));
process.env.SURFCORE_DATA_DIR = directory;
const { createMessageHandler, sampleEvent } = await import('../plugin/src/bridge.mjs');
const { activateCharacter } = await import('../plugin/src/store.mjs');
after(() => rm(directory, { recursive: true, force: true }));

const picture = { bytes: Buffer.from('fixture'), extension: 'png' };
const resolved = { text: '你觉得呢[图片1（附件1）]', images: [picture] };
function imageEvent(id = 1, groupId) {
  const event = sampleEvent('你觉得呢', id);
  event.message.push({ type: 'image', data: {} });
  if (groupId) {
    Object.assign(event, { message_type: 'group', group_id: groupId, user_id: 10003 });
    event.message.unshift({ type: 'at', data: { qq: '10001' } });
  }
  return event;
}
function setup(t, options = {}) {
  const media = Promise.withResolvers();
  const sent = [];
  const firstSent = Promise.withResolvers();
  const handle = createMessageHandler({
    owner: '10002', selfId: '10001', record: false, imageReplyDelayMs: 1,
    resolveMedia: () => media.promise,
    generate: async ({ imageReplyPhase }) => ({ action: 'speak', text: imageReplyPhase === 'initial' ? '我先说说。' : '看到了。' }),
    deliver: async (_contact, reply, kind, audio) => {
      sent.push({ reply, kind, audio });
      if (reply.includes('我先说说。')) firstSent.resolve();
    },
    ...options,
  });
  t.after(async () => { media.resolve(resolved); await handle.close(); });
  return { handle, media, sent, firstSent: firstSent.promise };
}

test('a slow image produces a text provisional reply before a grounded correction', { timeout: 3000 }, async (t) => {
  const { handle, media, sent, firstSent } = setup(t, {
    generate: async ({ imageReplyPhase, message, mediaImages, songPlan, conversationTools }) => {
      if (imageReplyPhase === 'initial') {
        assert.deepEqual(mediaImages, []);
        assert.match(message, /加载中/);
        assert.ok(!songPlan && !conversationTools?.canManage);
        return { action: 'speak', text: '我先说说。', localSticker: 1 };
      }
      if (imageReplyPhase === 'followup') {
        assert.deepEqual(mediaImages, [picture]);
        assert.match(message, /我先说说。/);
        assert.match(message, /附件1/);
        return { action: 'speak', text: '看到了。' };
      }
      return '完整回复';
    },
    prepareReplyVoice: () => assert.fail('staged replies must be text'),
  });
  const turn = handle(imageEvent());
  await firstSent;
  assert.match(sent[0].reply, /图片仍在加载/);
  assert.equal(sent[0].audio, undefined);
  media.resolve(resolved);
  await turn;
  assert.deepEqual(sent.map(({ reply }) => reply), [sent[0].reply, '看到了。']);
});

test('fast images and disabled staging each follow the ordinary reply path once', { timeout: 3000 }, async (t) => {
  for (const enabled of [true, false]) {
    const { handle, media, sent } = setup(t, { imageDelayCompensation: enabled,
      generate: async ({ imageReplyPhase, mediaImages }) => {
        assert.equal(imageReplyPhase, undefined);
        assert.deepEqual(mediaImages, [picture]);
        return '完整回复';
      },
    });
    const turn = handle(imageEvent());
    if (!enabled) await new Promise((done) => setTimeout(done, 20));
    media.resolve(resolved);
    await turn;
    assert.deepEqual(sent.map(({ reply }) => reply), ['完整回复']);
  }
});

test('an image finishing during provisional generation takes the ordinary path', { timeout: 3000 }, async (t) => {
  const entered = Promise.withResolvers();
  const abandoned = Promise.withResolvers();
  const { handle, media, sent } = setup(t, {
    generate: async ({ imageReplyPhase, signal }) => {
      if (imageReplyPhase !== 'initial') return '完整回复';
      entered.resolve();
      signal.addEventListener('abort', () => abandoned.resolve(), { once: true });
      await abandoned.promise;
      return { action: 'speak', text: '我先说说。' };
    },
  });
  const turn = handle(imageEvent());
  await entered.promise;
  media.resolve(resolved);
  await turn;
  assert.deepEqual(sent.map(({ reply }) => reply), ['完整回复']);
});

test('slow non-image processing does not trigger a provisional reply once all images are ready', { timeout: 3000 }, async (t) => {
  const otherMedia = Promise.withResolvers();
  const phases = [];
  const { handle, sent } = setup(t, {
    resolveMedia: async (_event, { onImagesReady } = {}) => {
      onImagesReady?.();
      await otherMedia.promise;
      return resolved;
    },
    generate: async ({ imageReplyPhase }) => {
      phases.push(imageReplyPhase);
      return '完整回复';
    },
  });
  const turn = handle(imageEvent());
  await new Promise((done) => setTimeout(done, 150));
  otherMedia.resolve();
  await turn;
  assert.deepEqual(phases, [undefined]);
  assert.deepEqual(sent.map(({ reply }) => reply), ['完整回复']);
});

test('an authorized white-listed group gets both stages and revocation stops a pending followup', { timeout: 3000 }, async (t) => {
  for (const revoke of [false, true]) {
    const { handle, media, sent, firstSent } = setup(t, { groups: ['10004'], social: { enabled: true } });
    assert.equal(await handle(imageEvent(1, 10004)), null);
    await handle(sampleEvent('同意群聊', 2));
    assert.equal(await handle(imageEvent(3, 10005)), null);
    const turn = handle(imageEvent(4, 10004));
    await firstSent;
    const revocation = revoke && handle(sampleEvent('撤销群聊', 5));
    await Promise.resolve();
    media.resolve(resolved);
    await turn;
    await revocation;
    assert.deepEqual(sent.filter(({ kind }) => kind === 'group').map(({ reply }) => reply),
      revoke ? [sent[1].reply] : [sent[1].reply, '看到了。']);
  }
});

test('a failed image can be acknowledged and an unnecessary followup can be skipped', { timeout: 3000 }, async (t) => {
  for (const available of [false, true]) {
    const { handle, media, sent, firstSent } = setup(t, {
      generate: async ({ imageReplyPhase, message, mediaImages }) => {
        if (imageReplyPhase === 'initial') return { action: 'speak', text: '我先说说。' };
        if (!available) {
          assert.match(message, /获取失败/);
          assert.deepEqual(mediaImages, []);
          return { action: 'speak', text: '这张图没加载出来。' };
        }
        return { action: 'skip' };
      },
    });
    const turn = handle(imageEvent());
    await firstSent;
    media.resolve(available ? resolved : { text: '你觉得呢[图片1获取失败]', images: [] });
    await turn;
    assert.equal(sent.length, available ? 1 : 2);
    if (!available) assert.equal(sent[1].reply, '这张图没加载出来。');
  }
});

test('a pause and resume, or a character change, invalidates pending followups', { timeout: 3000 }, async (t) => {
  for (const changeCharacter of [false, true]) {
    let generation = 0;
    const { handle, media, sent, firstSent } = setup(t, { generationToken: () => generation });
    const turn = handle(imageEvent());
    await firstSent;
    if (changeCharacter) {
      await activateCharacter('ming');
      t.after(() => activateCharacter('lin'));
    } else generation++;
    media.resolve(resolved);
    assert.equal(await turn, null);
    assert.equal(sent.length, 1);
  }
});
