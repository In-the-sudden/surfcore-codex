import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { prepareSongReply } from '../plugin/src/qq-song-autolearn.mjs';

test('missing learned recording downloads once and converts its timed opening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surfcore-autolearn-test-'));
  const source = Buffer.from('downloaded audio fixture');
  const output = Buffer.from('learned clip fixture');
  const calls = [];
  try {
    const prepared = await prepareSongReply({ title: 'Song', section: 'first30' }, {
      voiceRoot: root,
      resolvePrepared: async (_request, { lookupOnline }) => {
        assert.equal(lookupOnline, false);
        return { text: '本机曲库没有这首歌。' };
      },
      discover: async (request) => {
        calls.push('download');
        assert.deepEqual(request, { title: 'Song', artist: undefined });
        return { title: 'Song', artist: 'Singer', format: 'ogg', audio: source, url: 'https://upload.wikimedia.org/audio.ogg',
          pageUrl: 'https://commons.wikimedia.org/wiki/File:Audio.ogg', provider: 'Wikimedia Commons', license: 'CC BY 4.0',
          licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Singer',
          opening: { vocalStart: 31, phraseEnd: 63 } };
      },
      probeDuration: async (path) => {
        assert.deepEqual(await readFile(path), source);
        return 95;
      },
      learnClip: async ({ sourcePath, start, end }) => {
        calls.push('learn');
        assert.deepEqual(await readFile(sourcePath), source);
        assert.deepEqual([start, end], [30, 63]);
        return { audio: output };
      },
    });
    assert.deepEqual(calls, []);
    assert.equal(typeof prepared.learn, 'function');
    const result = await prepared.learn();
    assert.deepEqual(calls, ['download', 'learn']);
    assert.deepEqual(result.audio, output);
    assert.match(result.credit, /Singer/);
    assert.match(result.credit, /CC BY 4\.0/);
  } finally {
    if (dirname(resolve(root)) === resolve(tmpdir())) await rm(root, { recursive: true, force: true });
  }
});

test('an unmarked opening learns a random thirty-second excerpt when timing is unavailable', async () => {
  const prepared = await prepareSongReply({ title: 'Song', section: 'first30' }, {
    resolvePrepared: async () => ({
      song: { title: 'Song', artist: 'Singer' },
      learningSource: { path: 'source.ogg', sourceStart: 0, chorus: { start: 57, end: 76 } },
    }),
    probeDuration: async () => 120,
    detectOpening: async () => { throw new Error('No reliable vocal timing'); },
    random: () => 0.5,
    learnClip: async ({ start, end }) => {
      assert.deepEqual([start, end], [45, 75]);
      return { audio: Buffer.from('random excerpt') };
    },
  });
  const result = await prepared.learn();
  assert.ok(result.audio);
  assert.match(result.text, /片段/);
});

test('prefers QQ Music when a new recording is needed', async () => {
  const calls = [];
  const resultFile = Buffer.from('validated recording');
  const prepare = await prepareSongReply({ title: 'Song', artist: 'Singer', section: 'first30' }, {
    resolvePrepared: async () => ({}),
    discover: async () => assert.fail('QQ Music should be checked before other online sources'),
    acquireQQMusic: async (request) => {
      calls.push('desktop');
      assert.deepEqual(request, { title: 'Song', artist: 'Singer' });
      return { title: 'Song', artist: 'Singer', source: {
        path: 'from-qqmusic.mp3', sourceStart: 0, opening: { vocalStart: 27, phraseEnd: 55 },
      } };
    },
    probeDuration: async () => 120,
    learnClip: async ({ sourcePath, start, end }) => {
      assert.deepEqual([sourcePath, start, end], ['from-qqmusic.mp3', 26, 55]);
      return { audio: resultFile };
    },
  });
  assert.deepEqual(calls, []);
  assert.equal((await prepare.learn()).audio, resultFile);
  assert.deepEqual(calls, ['desktop']);
});

test('title-only local ambiguity proceeds to the first QQ Music female search result', async () => {
  const calls = [];
  const prepared = await prepareSongReply({ title: 'Song', section: 'first30' }, {
    resolvePrepared: async () => ({ text: '本地有多份同名录音，请告诉我歌手。', needsArtist: true }),
    discover: async () => assert.fail('An available QQ Music result should be used'),
    acquireQQMusic: async (request, options) => {
      calls.push('desktop');
      assert.deepEqual(request, { title: 'Song', artist: undefined });
      assert.deepEqual(options.avoidedArtists, []);
      return { title: 'Song (female cover)', artist: 'First Singer', source: {
        path: 'first-result.mp3', sourceStart: 0, opening: { vocalStart: 2, phraseEnd: 31 },
      } };
    },
    probeDuration: async () => 120,
    learnClip: async ({ sourcePath }) => {
      assert.equal(sourcePath, 'first-result.mp3');
      calls.push('learn');
      return { audio: Buffer.from('first female clip') };
    },
  });
  const result = await prepared.learn();
  assert.deepEqual(calls, ['desktop', 'learn']);
  assert.ok(result.audio);
});

test('unavailable QQ Music falls back to other audio sources', async () => {
  const calls = [];
  const prepared = await prepareSongReply({ title: 'Song', section: 'opening' }, {
    resolvePrepared: async () => ({}),
    acquireQQMusic: async () => { calls.push('desktop'); },
    discover: async () => { calls.push('online'); },
  });
  const result = await prepared.learn();
  assert.deepEqual(calls, ['desktop', 'online']);
  assert.equal(result.audio, undefined);
});

test('losing the QQ Music foreground window still allows learning from an alternate recording', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'surfcore-autolearn-foreground-'));
  t.after(async () => {
    if (dirname(resolve(root)) === resolve(tmpdir())) await rm(root, { recursive: true, force: true });
  });
  const message = 'QQ 音乐前台窗口不可用，或用户切换了窗口。';
  const foregroundError = Object.assign(new Error(message), { phase: 'qq-music-desktop', userMessage: message });
  const input = Buffer.from('alternate recording');
  const output = Buffer.from('learned audio');
  const prepared = await prepareSongReply({ title: 'Song', artist: 'Singer', section: 'opening' }, {
    voiceRoot: root,
    resolvePrepared: async () => ({}),
    acquireQQMusic: async () => { throw foregroundError; },
    discover: async (request) => {
      assert.deepEqual(request, { title: 'Song', artist: 'Singer' });
      return { title: 'Song', artist: 'Singer', audio: input, format: 'ogg', opening: { vocalStart: 2, phraseEnd: 31 } };
    },
    probeDuration: async () => 95,
    learnClip: async ({ sourcePath, start, end }) => {
      assert.deepEqual(await readFile(sourcePath), input);
      assert.deepEqual([start, end], [1, 31]);
      return { audio: output };
    },
    readLyrics: async () => ({ status: 'unavailable', lines: [], text: '' }),
  });
  assert.equal((await prepared.learn()).audio, output);
});

test('when desktop and alternate sources fail, preserve the desktop error', async () => {
  const failure = Object.assign(new Error('QQ Music window unavailable.'), { phase: 'qq-music-desktop' });
  const calls = [];
  const prepared = await prepareSongReply({ title: 'Song', section: 'opening' }, {
    resolvePrepared: async () => ({}),
    acquireQQMusic: async () => { throw failure; },
    discover: async () => { calls.push('online'); },
  });
  await assert.rejects(prepared.learn(), (error) => error === failure);
  assert.deepEqual(calls, ['online']);
});

test('learning reads lyrics for the actual source interval and returns grounded performance context', async () => {
  const lyrics = { status: 'aligned', lines: [{ time: 62, text: 'A remembered promise' }], text: 'A remembered promise' };
  const prepared = await prepareSongReply({ title: 'Song', section: 'opening' }, {
    resolvePrepared: async () => ({ song: { title: 'Song', artist: 'Singer' }, learningSource: {
      path: 'source.mp3', lyricPath: 'source.lrc', sourceStart: 60, opening: { vocalStart: 62, phraseEnd: 90 },
    } }),
    probeDuration: async () => 120,
    readLyrics: async (input) => {
      assert.equal(input.sourcePath, 'source.mp3');
      assert.equal(input.lyricPath, 'source.lrc');
      assert.deepEqual([input.start, input.end], [61, 90]);
      return lyrics;
    },
    learnClip: async (input) => {
      assert.deepEqual([input.start, input.end], [1, 30]);
      return { audio: Buffer.from('voice') };
    },
  });
  const song = await prepared.learn();
  assert.deepEqual(song.performance, { title: 'Song', artist: 'Singer', portion: '开头', start: 61, end: 90, lyrics });
  assert.doesNotMatch(JSON.stringify(song.performance), /source\.mp3|source\.lrc/);
});

test('missing lyrics never prevent audio delivery or invent the words sung', async () => {
  const prepared = await prepareSongReply({ title: 'Song', section: 'opening' }, {
    resolvePrepared: async () => ({ song: { title: 'Song', artist: 'Singer' }, learningSource: {
      path: 'source.mp3', sourceStart: 0, opening: { vocalStart: 2, phraseEnd: 30 },
    } }),
    probeDuration: async () => 120,
    readLyrics: async () => { throw new Error('Lyrics not available'); },
    learnClip: async () => ({ audio: Buffer.from('voice') }),
  });
  const song = await prepared.learn();
  assert.ok(song.audio);
  assert.deepEqual(song.performance.lyrics, { status: 'unavailable', lines: [], text: '' });
});

test('a failed voice conversion waits for the pending lyrics read before releasing the recording', async () => {
  const lyricsStarted = Promise.withResolvers();
  const lyrics = Promise.withResolvers();
  const failure = new Error('Voice conversion failed.');
  const prepared = await prepareSongReply({ title: 'Song', section: 'opening' }, {
    resolvePrepared: async () => ({ song: { title: 'Song', artist: 'Singer' }, learningSource: {
      path: 'source.mp3', sourceStart: 0, opening: { vocalStart: 2, phraseEnd: 30 },
    } }),
    probeDuration: async () => 120,
    learnClip: async () => { throw failure; },
    readLyrics: async () => {
      lyricsStarted.resolve();
      return lyrics.promise;
    },
  });
  let rejected;
  const completion = prepared.learn().catch((error) => { rejected = error; });
  await lyricsStarted.promise;
  await new Promise(setImmediate);
  lyrics.resolve({ status: 'unavailable', lines: [], text: '' });
  assert.equal(rejected, undefined);
  await completion;
  assert.equal(rejected, failure);
});

test('QQ Music failures preserve the original error, phase, and cause for the bridge', async () => {
  let attemptedAlternate = false;
  const cause = new Error('Download remained unchanged.');
  const failure = Object.assign(new Error('QQ Music download failed.', { cause }), {
    phase: 'qq-music-download', userMessage: 'Download is unavailable.',
  });
  const prepared = await prepareSongReply({ title: 'Song', section: 'opening' }, {
    resolvePrepared: async () => ({}),
    acquireQQMusic: async () => { throw failure; },
    discover: async () => { attemptedAlternate = true; },
    probeDuration: async () => assert.fail('A failed acquisition cannot reach audio analysis'),
    learnClip: async () => assert.fail('A failed acquisition cannot reach conversion'),
  });
  await assert.rejects(prepared.learn(), (error) => {
    assert.equal(error, failure);
    assert.equal(error.phase, 'qq-music-download');
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(attemptedAlternate, false);
});

test('an explicit version is not replaced by a female search preference', async () => {
  const prepared = await prepareSongReply({ title: 'Song (Live)', section: 'opening' }, {
    resolvePrepared: async (_request, options) => {
      assert.equal(options.preferFemale, false);
      return { avoidedArtists: ['Requested Singer'] };
    },
    acquireQQMusic: async (request, options) => {
      assert.equal(request.title, 'Song (Live)');
      assert.deepEqual(options.avoidedArtists, []);
      return { title: 'Song (Live)', artist: 'Requested Singer', source: {
        path: 'live.mp3', sourceStart: 0, opening: { vocalStart: 2, phraseEnd: 31 },
      } };
    },
    probeDuration: async () => 120,
    learnClip: async () => ({ audio: Buffer.from('live clip') }),
  });
  assert.ok((await prepared.learn()).audio);
});

test('an imported QQ Music recording with missing phrase markers learns a bounded random excerpt', async () => {
  const prepare = await prepareSongReply({ title: 'Song', section: 'first30' }, {
    resolvePrepared: async () => ({}),
    discover: async () => undefined,
    acquireQQMusic: async () => ({ title: 'Song', artist: 'Singer', source: { path: 'stored.mp3', sourceStart: 0 } }),
    probeDuration: async () => 120,
    detectOpening: async () => { throw new Error('No complete phrase end'); },
    random: () => 0.25,
    learnClip: async ({ sourcePath, start, end }) => {
      assert.deepEqual([sourcePath, start, end], ['stored.mp3', 22.5, 52.5]);
      return { audio: Buffer.from('imported random excerpt') };
    },
  });
  const result = await prepare.learn();
  assert.ok(result.audio);
  assert.match(result.text, /片段/);
});

test('detects an unmarked local opening before learning its complete phrase', async () => {
  const calls = [];
  const prepared = await prepareSongReply({ title: 'Song', section: 'opening' }, {
    resolvePrepared: async () => ({
      song: { title: 'Song', artist: 'Singer' },
      learningSource: { path: 'source.wav', sourceStart: 20 },
    }),
    probeDuration: async () => 120,
    detectOpening: async (source, { signal }) => {
      calls.push('detect');
      assert.deepEqual(source, { sourcePath: 'source.wav', duration: 120 });
      assert.ok(signal instanceof AbortSignal);
      return { opening: { vocalStart: 31, phraseEnd: 63 } };
    },
    learnClip: async ({ sourcePath, start, end }) => {
      calls.push('learn');
      assert.deepEqual([sourcePath, start, end], ['source.wav', 30, 63]);
      return { audio: Buffer.from('detected opening') };
    },
  });
  const result = await prepared.learn();
  assert.deepEqual(calls, ['detect', 'learn']);
  assert.deepEqual(result.audio, Buffer.from('detected opening'));
});

test('keeps a valid manual opening cue without running automatic timing', async () => {
  const prepared = await prepareSongReply({ title: 'Song', section: 'opening' }, {
    resolvePrepared: async () => ({
      song: { title: 'Song', artist: 'Singer' },
      learningSource: { path: 'source.wav', sourceStart: 10, opening: { vocalStart: 17, phraseEnd: 40 } },
    }),
    probeDuration: async () => 120,
    detectOpening: async () => assert.fail('A valid manual cue should take precedence'),
    learnClip: async ({ start, end }) => {
      assert.deepEqual([start, end], [6, 30]);
      return { audio: Buffer.from('manual opening') };
    },
  });
  assert.ok((await prepared.learn()).audio);
});

test('uses a bounded random excerpt when automatic opening boundaries are invalid', async () => {
  const prepared = await prepareSongReply({ title: 'Song', section: 'opening' }, {
    resolvePrepared: async () => ({ learningSource: { path: 'source.wav', sourceStart: 0 } }),
    probeDuration: async () => 120,
    detectOpening: async () => ({ opening: { vocalStart: 31, phraseEnd: 90 } }),
    random: () => 0.5,
    learnClip: async ({ start, end }) => {
      assert.deepEqual([start, end], [45, 75]);
      return { audio: Buffer.from('random excerpt') };
    },
  });
  const result = await prepared.learn();
  assert.ok(result.audio);
  assert.match(result.text, /片段/);
});

test('prefers a random locally evidenced excerpt before choosing an arbitrary file position', async () => {
  const prepared = await prepareSongReply({ title: 'Song', section: 'opening' }, {
    resolvePrepared: async () => ({ learningSource: { path: 'source.wav', sourceStart: 25 } }),
    probeDuration: async () => 120,
    detectOpening: async () => ({ status: 'partial', fallbackSegments: [
      { start: 15, end: 45, vocalSupport: 0.8, startGap: 0.2, endGap: 0.3 },
      { start: 64, end: 94, vocalSupport: 0.9, startGap: 0.4, endGap: 0.2 },
    ] }),
    random: () => 0.75,
    learnClip: async ({ start, end }) => {
      assert.deepEqual([start, end], [64, 94]);
      return { audio: Buffer.from('evidenced excerpt') };
    },
  });
  assert.match((await prepared.learn()).text, /片段/);
});

test('excludes invalid candidate intervals before selecting an evidenced excerpt', async () => {
  const prepared = await prepareSongReply({ title: 'Song', section: 'opening' }, {
    resolvePrepared: async () => ({ learningSource: { path: 'source.wav', sourceStart: 0 } }),
    probeDuration: async () => 120,
    detectOpening: async () => ({ fallbackSegments: [
      null,
      { start: NaN, end: 30 },
      { start: 20, end: Infinity },
      { start: -1, end: 29 },
      { start: 10, end: 29 },
      { start: 10, end: 51 },
      { start: 95, end: 125 },
      { start: 50, end: 20 },
      { start: 35, end: 66, vocalSupport: 0.8, startGap: 0.2, endGap: 0.2 },
    ] }),
    random: () => 0.25,
    learnClip: async ({ start, end }) => {
      assert.deepEqual([start, end], [35, 66]);
      return { audio: Buffer.from('only valid excerpt') };
    },
  });
  assert.ok((await prepared.learn()).audio);
});

test('keeps arbitrary random fallback inside long and short files for edge random values', async (t) => {
  for (const [duration, value, expected] of [
    [120, -1, [0, 30]],
    [120, 1, [89.999, 119.999]],
    [120, NaN, [45, 75]],
    [17.25, 0.8, [0, 17.25]],
    [30, 0.5, [0, 30]],
  ]) {
    await t.test('duration ' + duration + ', random ' + value, async () => {
      const prepared = await prepareSongReply({ title: 'Song', section: 'opening' }, {
        resolvePrepared: async () => ({ learningSource: { path: 'source.wav', sourceStart: 0 } }),
        probeDuration: async () => duration,
        detectOpening: async () => ({ status: 'partial', fallbackSegments: [] }),
        random: () => value,
        learnClip: async ({ start, end }) => {
          assert.deepEqual([start, end], expected);
          assert.ok(start >= 0 && end <= duration && end > start);
          assert.ok(end - start <= 30);
          return { audio: Buffer.from('bounded excerpt') };
        },
      });
      assert.ok((await prepared.learn()).audio);
    });
  }
});

test('propagates cancellation during automatic timing without learning', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel timing');
  const prepared = await prepareSongReply({ title: 'Song', section: 'opening' }, {
    resolvePrepared: async () => ({ learningSource: { path: 'source.wav', sourceStart: 0 } }),
    probeDuration: async () => 120,
    detectOpening: async (_source, { signal }) => {
      controller.abort(reason);
      signal.throwIfAborted();
    },
    random: () => assert.fail('Cancelled timing cannot select a fallback'),
    learnClip: async () => assert.fail('Cancelled timing cannot reach learning'),
  });
  await assert.rejects(prepared.learn(controller.signal), (error) => error === reason);
});

test('uses a matching local chorus cue and leaves explicit missing cues unresolved', async () => {
  const calls = [];
  const options = {
    resolvePrepared: async () => ({
      song: { title: 'Song', artist: 'Singer' },
      learningSource: { path: 'source.flac', sourceStart: 0, chorus: { start: 57, end: 97 } },
    }),
    discover: async () => assert.fail('local source should not download'),
    probeDuration: async () => 120,
    detectOpening: async () => assert.fail('An explicit chorus cannot use opening timing'),
    learnClip: async ({ start, end }) => {
      calls.push([start, end]);
      return { audio: Buffer.from('chorus') };
    },
  };
  const request = { title: 'Song', section: 'chorus' };
  const prepared = await prepareSongReply(request, options);
  const chorus = await prepared.learn();
  assert.deepEqual(calls, [[57, 87]]);
  assert.ok(chorus.audio);
  const unknown = await prepareSongReply(request, { ...options, resolvePrepared: async () => ({
    song: { title: 'Song', artist: 'Singer' }, learningSource: { path: 'source.flac', sourceStart: 0 },
  }) });
  const result = await unknown.learn();
  assert.equal(result.audio, undefined);
  assert.match(result.text, /副歌/);
  assert.deepEqual(calls, [[57, 87]]);
});

test('does not learn the skipped male recording when an online lookup returns it again', async () => {
  const prepared = await prepareSongReply({ title: 'Song' }, {
    resolvePrepared: async (_request, options) => {
      assert.equal(options.preferFemale, true);
      return { avoidedArtists: ['Some Artist'] };
    },
    discover: async () => ({ title: 'Song', artist: 'SOME ARTIST', format: 'ogg', audio: Buffer.from('fixture') }),
    learnClip: async () => assert.fail('A known male recording should not be learned by default'),
  });
  const result = await prepared.learn();
  assert.equal(result.audio, undefined);
  assert.match(result.text, /女声/);
});
