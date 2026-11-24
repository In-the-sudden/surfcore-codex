import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('the model can look up a quote and history, keep a seen sticker, send it and delete it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surfcore-qq-tools-'));
  const previous = process.env.SURFCORE_DATA_DIR;
  process.env.SURFCORE_DATA_DIR = directory;
  const { createMessageHandler, sampleEvent } = await import('../plugin/src/bridge.mjs');
  const sticker = { bytes: Buffer.from('original sticker'), extension: 'gif' };
  const reads = [], sent = [], saved = new Map();
  let step = 0;
  const library = {
    list: async (_role, scope) => scope === '10001:qq-10002' ? [...saved.values()] : [],
    save: async (_role, scope, candidate, { canWrite }) => {
      assert.equal(scope, '10001:qq-10002');
      assert.equal(canWrite(), true);
      assert.equal(candidate.bytes, sticker.bytes);
      const entry = { ...candidate, id: 'saved-sticker' };
      saved.set(entry.id, entry);
      return { status: 'saved', id: entry.id, label: entry.label };
    },
    read: async (_role, _scope, id) => saved.get(id) ?? null,
    remove: async (_role, _scope, id, { canWrite }) => canWrite() && saved.delete(id),
  };
  const bridge = createMessageHandler({
    owner: '10002', selfId: '10001', record: false, stickerLibrary: library,
    readConversation: async (incoming, source) => {
      reads.push(source);
      assert.equal(incoming.quotedMessageId, -42);
      return source === 'quoted'
        ? { text: '已找到引用', quotedMedia: { text: '上一条是动图', media: [], messageId: '-42' } }
        : { text: '先前说过要去徒步' };
    },
    resolveMedia: async (incoming) => incoming.messageId === '-42'
      ? { text: '引用动图（完整预览）', images: [{ bytes: Buffer.from('sheet'), extension: 'png' }], stickers: [sticker] }
      : { text: incoming.text, images: [] },
    generate: async ({ conversationTools, message, mediaImages }) => {
      switch (step++) {
        case 0:
          assert.equal(conversationTools.canReadQuote, true);
          return { action: 'lookup', source: 'quoted' };
        case 1:
          assert.match(message, /引用动图（完整预览）/);
          assert.equal(mediaImages.length, 1);
          assert.equal(conversationTools.stickerCount, 1);
          return { action: 'lookup', source: 'history' };
        case 2:
          assert.match(message, /先前说过要去徒步/);
          return { action: 'manage_sticker', saveSticker: { choice: 1, label: '点头同意' } };
        case 3:
          assert.match(message, /已收藏/);
          assert.equal(conversationTools.stickers[0].label, '点头同意');
          return { action: 'speak', text: '同意！', localSticker: 1 };
        case 4:
          return { action: 'manage_sticker', removeSticker: 1 };
        default:
          assert.match(message, /已删除/);
          return { action: 'speak', text: '删掉啦。' };
      }
    },
    sendLocalSticker: async (contact, kind, asset) => sent.push({ contact, kind, bytes: asset.bytes }),
    deliver: async (_contact, text) => sent.push(text),
  });
  try {
    const event = sampleEvent('这个表情挺合适', 1);
    event.message.unshift({ type: 'reply', data: { id: '-42' } });
    await bridge(event);
    assert.deepEqual(reads, ['quoted', 'history']);
    assert.deepEqual(sent, [{ contact: '10002', kind: 'private', bytes: sticker.bytes }]);
    await bridge(sampleEvent('现在不想留这个表情', 2));
    assert.deepEqual(sent, [{ contact: '10002', kind: 'private', bytes: sticker.bytes }, '删掉啦。']);
    assert.equal(saved.size, 0);
    const failures = [];
    const ordinary = createMessageHandler({
      owner: '10002', selfId: '10001', record: false,
      readConversation: async () => ({ text: '同一会话的历史注册成功' }),
      stickerLibrary: { list: async () => { throw new Error('Database not available'); } },
      generate: async ({ conversationTools, message }) => {
        if (!conversationTools) return '临时会话正常回复。';
        assert.equal(conversationTools.canManage, false);
        if (conversationTools.canReadHistory) return { action: 'lookup', source: 'history' };
        assert.match(message, /同一会话的历史注册成功/);
        return { action: 'speak', text: '我看到了。' };
      },
      deliver: async (_contact, text) => failures.push(text),
    });
    try {
      await ordinary(sampleEvent('翻一下', 3));
      const temporary = sampleEvent('这是群临时会话', 4);
      temporary.sub_type = 'group';
      await ordinary(temporary);
      assert.deepEqual(failures, ['我看到了。', '临时会话正常回复。']);
    } finally { await ordinary.close(); }
  } finally {
    await bridge.close();
    if (previous === undefined) delete process.env.SURFCORE_DATA_DIR;
    else process.env.SURFCORE_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
