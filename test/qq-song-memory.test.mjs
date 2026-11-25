import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

test('sent songs enter only their role and conversation memory with grounded lyrics', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'surfcore-song-memory-'));
  const previous = process.env.SURFCORE_DATA_DIR;
  process.env.SURFCORE_DATA_DIR = directory;
  const { createMessageHandler, sampleEvent } = await import('../plugin/src/bridge.mjs');
  const { activateCharacter, characterContext, listMemoryPage } = await import('../plugin/src/store.mjs');
  const { conversationInput, runCodex } = await import('../plugin/src/codex.mjs');
  let nextId = 1;
  const request = { title: 'Memory Song', section: 'opening' };
  const performance = (title, status = 'aligned') => ({ title, artist: 'Singer', portion: '开头',
    start: 31.125, end: 62.5, lyrics: { status, text: 'A promise remembered in the rain',
      lines: [{ time: 32, text: 'A promise remembered in the rain' }] } });
  const event = (kind = 'private', text = '唱 Memory Song') => {
    const item = sampleEvent(text, nextId++);
    return kind === 'private' ? item : { ...item, user_id: 10003, message_type: 'group', group_id: 10004,
      message: [{ type: 'at', data: { qq: '10001' } }, ...item.message] };
  };
  const create = (options) => createMessageHandler({ owner: '10002', selfId: '10001', admins: ['10003'],
    groups: ['10004', '10005'], social: { enabled: true },
    generate: async ({ operationReplyMode }) => operationReplyMode ? '我先准备一下。' : { action: 'sing', song: request },
    ...options });
  const notes = async (scope = 'qq-10002') => (await listMemoryPage('lin', { scope, limit: 200 })).items
    .filter((item) => item.note?.startsWith('演唱记录：')).map((item) => item.note);
  const result = (title, status) => ({ text: '给你唱这一段。', audio: Buffer.from('song audio'),
    performance: performance(title, status) });
  async function bounded(promise) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Song delivery did not finish')), 2_000);
      })]);
    } finally { clearTimeout(timer); }
  }
  try {
    for (const mode of ['immediate', 'background']) {
      await t.test(mode + ' remembers only after audio delivery and adds no public message', async () => {
        const title = mode + ' success';
        const sent = [], errors = [];
        const delivered = Promise.withResolvers();
        const song = result(title);
        const handle = create({
          resolveReplySong: async () => mode === 'immediate' ? song : { text: '准备中。', learn: async () => song },
          deliver: async (_contact, text, _kind, audio) => {
            sent.push({ text, audio });
            if (audio) {
              assert.equal((await notes()).some((note) => note.includes(title)), false);
              delivered.resolve();
            }
            return { verified: true };
          }, onError: (error) => errors.push(error),
        });
        try {
          await handle(event());
          await bounded(delivered.promise);
          await handle.idle();
          const saved = (await notes()).filter((note) => note.includes(title));
          assert.equal(saved.length, 1);
          assert.match(saved[0], /Singer.*的开头/);
          assert.match(saved[0], /31\.13–62\.5 秒/);
          assert.match(saved[0], /对应片段的时间轴歌词.*未逐词确认实际唱词/);
          assert.match(saved[0], /A promise remembered in the rain/);
          assert.equal(sent.length, mode === 'immediate' ? 1 : 2);
          assert.equal(sent.filter(({ audio }) => audio).length, 1);
          assert.deepEqual(errors, []);
          const input = JSON.parse(conversationInput(await characterContext('qq-10002'), '刚才唱了什么情感？'));
          assert.ok(input.narrativeMemory.some(({ text }) => text.includes(saved[0])));
        } finally { await handle.close(); }
      });

      await t.test(mode + ' failed audio delivery records no song', async () => {
        const title = mode + ' failed delivery';
        const errors = [];
        const failed = Promise.withResolvers();
        const song = result(title);
        const handle = create({
          resolveReplySong: async () => mode === 'immediate' ? song : { text: '准备中。', learn: async () => song },
          deliver: async (_contact, _text, _kind, audio) => { if (audio) throw new Error('Delivery rejected'); },
          onError: (error) => { errors.push(error); failed.resolve(); },
        });
        try {
          if (mode === 'immediate') await assert.rejects(handle(event()), /Delivery rejected/);
          else { await handle(event()); await bounded(failed.promise); await handle.idle(); }
          assert.equal((await notes()).some((note) => note.includes(title)), false);
          assert.equal(errors.length, 1);
        } finally { await handle.close(); }
      });

      for (const receipt of [undefined, { verified: false }]) {
        await t.test(mode + ' unresolved readback records no successful performance ' + JSON.stringify(receipt), async () => {
          const title = mode + ' unconfirmed ' + JSON.stringify(receipt);
          const delivered = Promise.withResolvers();
          const song = result(title);
          const handle = create({
            resolveReplySong: async () => mode === 'immediate' ? song : { text: '准备中。', learn: async () => song },
            deliver: async (_contact, _text, _kind, audio) => {
              if (audio) delivered.resolve();
              return receipt;
            },
          });
          try {
            await handle(event());
            await bounded(delivered.promise);
            await handle.idle();
            assert.equal((await notes()).some((note) => note.includes(title)), false);
          } finally { await handle.close(); }
        });
      }

      for (const invalidation of ['cancel', 'generation', 'role', 'authorization']) {
        await t.test(mode + ' ' + invalidation + ' during audio delivery prevents song memory', async () => {
          const title = mode + ' invalidated ' + invalidation;
          const delivered = Promise.withResolvers();
          const song = result(title);
          let keepGoing = true, generation = 0, revocation;
          let handle;
          handle = create({ shouldContinue: () => keepGoing, generationToken: () => generation,
            resolveReplySong: async () => mode === 'immediate' ? song : { text: '准备中。', learn: async () => song },
            deliver: async (_contact, _text, _kind, audio) => {
              if (!audio) return;
              if (invalidation === 'cancel') keepGoing = false;
              if (invalidation === 'generation') generation++;
              if (invalidation === 'role') await activateCharacter('ming');
              if (invalidation === 'authorization') revocation = handle(event('private', '撤销群聊'));
              delivered.resolve();
              return { verified: true };
            },
          });
          try {
            if (invalidation === 'authorization') await handle(event('private', '同意群聊'));
            await handle(event(invalidation === 'authorization' ? 'group' : 'private'));
            await bounded(delivered.promise);
            await revocation;
            await handle.idle();
            assert.equal((await notes(invalidation === 'authorization' ? 'qq-group-10004' : 'qq-10002'))
              .some((note) => note.includes(title)), false);
            assert.equal((await listMemoryPage('ming', { limit: 200 })).items.some(({ note }) => note?.includes(title)), false);
          } finally { await handle.close(); await activateCharacter('lin'); }
        });
      }

      for (const options of [{ record: false }, { simulated: true }]) {
        await t.test(mode + ' ' + Object.keys(options)[0] + ' suppresses song memory', async () => {
          const title = mode + ' no record ' + Object.keys(options)[0];
          const delivered = Promise.withResolvers();
          const song = result(title);
          const handle = create({ ...options,
            resolveReplySong: async () => mode === 'immediate' ? song : { text: '准备中。', learn: async () => song },
            deliver: async (_contact, _text, _kind, audio) => { if (audio) delivered.resolve(); return { verified: true }; },
          });
          try {
            await handle(event());
            await bounded(delivered.promise);
            await handle.idle();
            assert.equal((await listMemoryPage('lin', { limit: 200 })).items.some(({ note }) => note?.includes(title)), false);
          } finally { await handle.close(); }
        });
      }
    }

    await t.test('group lyrics remain in that conversation', async () => {
      const title = 'Only this group song';
      const handle = create({ resolveReplySong: async () => result(title), deliver: async () => ({ verified: true }) });
      try {
        await handle(event('private', '同意群聊'));
        await handle(event('group'));
        for (const scope of ['qq-group-10004', 'qq-10002', 'qq-group-10005']) {
          const input = conversationInput(await characterContext(scope), '唱过什么？');
          assert.equal(input.includes(title), scope === 'qq-group-10004');
        }
      } finally { await handle.close(); }
    });

    await t.test('lyric confidence and bounded whitelisted metadata survive into memory', async () => {
      for (const status of ['aligned', 'untimed', 'unavailable', 'unknown']) {
        const title = 'Lyric state ' + status;
        const song = result(title, status);
        const secret = 'private-account-token D:/private/audio.wav';
        song.performance.file = secret;
        song.performance.account = secret;
        song.performance.lyrics.extra = secret;
        if (status === 'aligned') song.performance.lyrics.text += 'x'.repeat(100_000);
        const handle = create({ resolveReplySong: async () => song, deliver: async () => ({ verified: true }) });
        try {
          await handle(event());
          const saved = (await notes()).find((note) => note.includes(title));
          assert.ok(saved);
          assert.ok(saved.length < 4_000);
          assert.doesNotMatch(saved, /private-account-token|private\/audio/);
          if (status === 'aligned') assert.match(saved, /对应片段的时间轴歌词/);
          else if (status === 'untimed') assert.match(saved, /不能确认本次片段唱了其中哪些句子/);
          else {
            assert.match(saved, /没有可确认的对应歌词/);
            assert.doesNotMatch(saved, /A promise remembered/);
          }
        } finally { await handle.close(); }
      }
    });

    await t.test('missing last-line boundary and truncated lyrics keep their uncertainty', async () => {
      const song = result('Uncertain song');
      song.performance.lyrics.uncertainLastLine = true;
      song.performance.lyrics.truncated = true;
      song.performance.lyrics.note = 'D:/private/diagnostic.txt';
      const handle = create({ resolveReplySong: async () => song, deliver: async () => ({ verified: true }) });
      try {
        await handle(event());
        const saved = (await notes()).find((note) => note.includes('Uncertain song'));
        assert.match(saved, /末行没有下一时间点/);
        assert.match(saved, /不能确认末行实际唱出/);
        assert.match(saved, /歌词资料已截短/);
        assert.doesNotMatch(saved, /diagnostic\.txt|private/);
      } finally { await handle.close(); }
    });

    await t.test('allowed text fields also reject local paths and credential diagnostics', async () => {
      const song = result('Path fixture');
      song.performance.title = 'D:/private/song.wav';
      song.performance.artist = '\\\\private-server\\music\\singer';
      song.performance.portion = 'file:///D:/private/config';
      song.performance.lyrics.text = 'Clean lyric\nD:\\private\\audio.wav\n/home/private/song.lrc\naccess_token=private-token\nuser_id=10002';
      const before = (await notes()).length;
      const handle = create({ resolveReplySong: async () => song, deliver: async () => ({ verified: true }) });
      try {
        await handle(event());
        const saved = (await notes()).find((note) => note.includes('Clean lyric'));
        assert.equal((await notes()).length, before + 1);
        assert.match(saved, /歌名不详/);
        assert.doesNotMatch(saved, /private|10002|D:|file:|access_token/);
      } finally { await handle.close(); }
    });

    await t.test('memory write failure reports once without sending audio again', async () => {
      const journal = join(directory, 'characters', 'lin', 'qq-10002.jsonl');
      const failed = Promise.withResolvers();
      const errors = [];
      let sent = 0;
      const handle = create({ resolveReplySong: async () => ({ text: '准备中。', learn: async () => result('Failed memory') }),
        deliver: async (_contact, _text, _kind, audio) => {
          if (!audio) return;
          sent++;
          await rm(journal);
          await mkdir(journal);
          return { verified: true };
        },
        onError: (error) => { errors.push(error); failed.resolve(); },
      });
      try {
        await handle(event());
        await bounded(failed.promise);
        await handle.idle();
        assert.equal(sent, 1);
        assert.equal(errors.length, 1);
      } finally {
        await handle.close();
        await rm(journal, { recursive: true, force: true });
      }
    });

    await t.test('explicit spoken replies create no song note', async () => {
      const before = (await notes()).length;
      let audios = 0;
      const handle = create({ generate: async () => ({ action: 'speak', text: '你好。', voiceRequested: true }), resolveReplySong: null,
        prepareReplyVoice: async () => Buffer.from('speech'),
        deliver: async (_contact, _text, _kind, audio) => { if (audio) audios++; },
      });
      try {
        await handle(event('private', '/语音 你好'));
        assert.equal(audios, 1);
        assert.equal((await notes()).length, before);
      } finally { await handle.close(); }
    });

    await t.test('role instructions ground emotional interpretation in the actual lyric evidence', async () => {
      let instructions;
      await runCodex({ role: await characterContext('qq-10002'), message: '唱了什么、什么情感？',
        launch: () => ({ initialize: async () => {},
          start: async (_path, prompt) => { instructions = prompt; return 'song-memory'; },
          turn: async () => '从歌词看，这一段写的是怀念。', close: () => {},
        }),
      });
      assert.match(instructions, /对应片段的时间轴歌词.*主题和情感/);
      assert.match(instructions, /未逐词确认实际唱词.*须保留这些局限/);
      assert.match(instructions, /不是角色自己的现实经历/);
      assert.match(instructions, /未对齐歌词只能作为歌曲资料/);
      assert.match(instructions, /歌词缺失时不要编造内容或情感/);
      assert.match(instructions, /不能把片段说成整首或声称自己听过音频/);
    });
  } finally {
    if (previous === undefined) delete process.env.SURFCORE_DATA_DIR;
    else process.env.SURFCORE_DATA_DIR = previous;
    if (dirname(resolve(directory)) === resolve(tmpdir())) await rm(directory, { recursive: true, force: true });
  }
});
