import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSongTimingDetector } from '../plugin/src/qq-song-timing.mjs';
import { runSongModelJob } from '../plugin/src/qq-song-model-queue.mjs';
import { wavDataOffset } from '../plugin/src/voice-wav.mjs';

const ffmpeg = process.env.SURFCORE_FFMPEG || 'ffmpeg';
const skip = spawnSync(ffmpeg, ['-version'], { windowsHide: true, timeout: 3000 }).status !== 0;

function wav(seconds, sample = 6000) {
  const rate = 8000;
  const samples = Math.round(rate * seconds);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) buffer.writeInt16LE(sample, 44 + index * 2);
  return buffer;
}

async function fixture(t, duration = 5) {
  const base = tmpdir();
  const voiceRoot = await mkdtemp(join(base, 'qq-song-timing-test-'));
  t.after(() => rm(voiceRoot, { recursive: true, force: true }));
  const sourcePath = join(voiceRoot, 'source.wav');
  await writeFile(sourcePath, wav(duration));
  return { voiceRoot, sourcePath, duration };
}

function report(overrides = {}) {
  return { status: 'detected', confidence: { level: 'supported', asrProbability: 0.9, vocalSupport: 0.9 },
    analysisVersion: 'test-model-v1', opening: { vocalStart: 1, phraseEnd: 4 }, ...overrides };
}

function candidate(overrides = {}) {
  return { start: 12, end: 42, vocalSupport: 0.8, startGap: 0.5, endGap: 0.5, ...overrides };
}

function partialReport(fallbackSegments = [candidate()]) {
  return { status: 'partial', analysisVersion: 'test-model-v1', fallbackSegments };
}

test('bounds the model scan and reuses successful timing concurrently and from cache', { skip }, async (t) => {
  const { voiceRoot, sourcePath, duration } = await fixture(t, 105);
  let analyzed = 0;
  const detect = createSongTimingDetector({ voiceRoot, ffmpeg, analyze: async ({ clipPath, workDir, voiceRoot: root }) => {
    analyzed++;
    assert.equal(root, voiceRoot);
    assert.equal(join(workDir, 'opening.wav'), clipPath);
    const clip = await readFile(clipPath);
    assert.equal(clip.toString('ascii', 12, 16), 'fmt ');
    assert.equal(clip.readUInt16LE(22), 2);
    assert.equal(clip.readUInt32LE(24), 44100);
    assert.equal((clip.length - wavDataOffset(clip)) / clip.readUInt32LE(28), 100);
    return report();
  } });
  const [first, second] = await Promise.all([
    detect({ sourcePath, duration }),
    detect({ sourcePath, duration }),
  ]);
  assert.equal(analyzed, 1);
  assert.deepEqual([first.cached, second.cached].sort(), [false, true]);
  assert.deepEqual(first.opening, { vocalStart: 1, phraseEnd: 4 });
  assert.equal(first.sourceSha256, second.sourceSha256);
  assert.equal(first.sourceDuration, 105);
  assert.equal((await detect({ sourcePath, duration })).cached, true);
  assert.equal(analyzed, 1);
  const entries = await readdir(join(voiceRoot, 'qq-song-timing'));
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^[a-f0-9]{64}\.json$/);
});

test('invalidates cached timing when source bytes change at the same path', { skip }, async (t) => {
  const { voiceRoot, sourcePath, duration } = await fixture(t);
  let analyzed = 0;
  const detect = createSongTimingDetector({ voiceRoot, ffmpeg, analyze: async () => {
    analyzed++;
    return report();
  } });
  const first = await detect({ sourcePath, duration });
  await writeFile(sourcePath, wav(duration, 3000));
  const second = await detect({ sourcePath, duration });
  assert.equal(second.cached, false);
  assert.notEqual(first.sourceSha256, second.sourceSha256);
  assert.equal(analyzed, 2);
  assert.equal((await detect({ sourcePath, duration })).cached, true);
});

test('rejects uncertain timing without publishing a cache and can retry', { skip }, async (t) => {
  const { voiceRoot, sourcePath, duration } = await fixture(t);
  let analyzed = 0;
  const detect = createSongTimingDetector({ voiceRoot, ffmpeg, analyze: async () => {
    analyzed++;
    return report({ confidence: { level: 'supported', asrProbability: analyzed === 1 ? 0.24 : 0.9, vocalSupport: 0.9 } });
  } });
  await assert.rejects(detect({ sourcePath, duration }), { phase: 'timing' });
  assert.deepEqual(await readdir(join(voiceRoot, 'qq-song-timing')), []);
  assert.equal((await detect({ sourcePath, duration })).cached, false);
  assert.equal((await detect({ sourcePath, duration })).cached, true);
  assert.equal(analyzed, 2);
});

test('rejects an opening over the clip limit without poisoning a retry', { skip }, async (t) => {
  const { voiceRoot, sourcePath, duration } = await fixture(t, 70);
  let analyzed = 0;
  const detect = createSongTimingDetector({ voiceRoot, ffmpeg, analyze: async () => {
    analyzed++;
    return analyzed === 1 ? report({ opening: { vocalStart: 1, phraseEnd: 43 } }) : report();
  } });
  await assert.rejects(detect({ sourcePath, duration }), { phase: 'timing' });
  assert.deepEqual(await readdir(join(voiceRoot, 'qq-song-timing')), []);
  assert.equal((await detect({ sourcePath, duration })).cached, false);
  assert.equal(analyzed, 2);
});

test('rejects analysis if its source changed before publication', { skip }, async (t) => {
  const { voiceRoot, sourcePath, duration } = await fixture(t);
  let analyzed = 0;
  const detect = createSongTimingDetector({ voiceRoot, ffmpeg, analyze: async () => {
    if (++analyzed === 1) await writeFile(sourcePath, wav(duration, 3000));
    return report();
  } });
  await assert.rejects(detect({ sourcePath, duration }), { phase: 'timing', message: /Source changed/ });
  assert.deepEqual(await readdir(join(voiceRoot, 'qq-song-timing')), []);
  assert.equal((await detect({ sourcePath, duration })).cached, false);
  assert.equal(analyzed, 2);
});

test('reuses partial local-vocal excerpt evidence without requiring an opening or ASR confidence', { skip }, async (t) => {
  const { voiceRoot, sourcePath, duration } = await fixture(t, 70);
  const expected = [candidate(), candidate({ start: 36, end: 68 })];
  let analyzed = 0;
  const detect = createSongTimingDetector({ voiceRoot, ffmpeg, analyze: async () => {
    analyzed++;
    return partialReport(expected);
  } });
  const [first, second] = await Promise.all([
    detect({ sourcePath, duration }),
    detect({ sourcePath, duration }),
  ]);
  assert.deepEqual([first.cached, second.cached].sort(), [false, true]);
  assert.equal(first.status, 'partial');
  assert.equal(first.opening, undefined);
  assert.deepEqual(first.fallbackSegments, expected);
  const cached = await detect({ sourcePath, duration });
  assert.equal(cached.cached, true);
  assert.deepEqual(cached.fallbackSegments, expected);
  assert.equal(analyzed, 1);
});

test('rejects partial evidence outside local vocal, pause, scan, or clip bounds and allows retry', { skip }, async (t) => {
  const cases = [
    ['no candidates', []],
    ['nonfinite start', [candidate({ start: NaN })]],
    ['negative start', [candidate({ start: -1 })]],
    ['too short', [candidate({ end: 31 })]],
    ['too long', [candidate({ end: 53 })]],
    ['outside scan window', [candidate({ start: 80, end: 110 })]],
    ['insufficient vocals', [candidate({ vocalSupport: 0.39 })]],
    ['missing vocal evidence', [{ start: 12, end: 42, startGap: 0.2, endGap: 0.3 }]],
    ['missing boundary evidence', [{ start: 12, end: 42, vocalSupport: 0.8 }]],
    ['insufficient start pause', [candidate({ startGap: 0.17 })]],
    ['insufficient end pause', [candidate({ endGap: 0.17 })]],
  ];
  for (const [name, fallbackSegments] of cases) {
    await t.test(name, async (subtest) => {
      const { voiceRoot, sourcePath, duration } = await fixture(subtest, 105);
      let analyzed = 0;
      const detect = createSongTimingDetector({ voiceRoot, ffmpeg, analyze: async () =>
        ++analyzed === 1 ? partialReport(fallbackSegments) : partialReport() });
      await assert.rejects(detect({ sourcePath, duration }), { phase: 'timing' });
      assert.deepEqual(await readdir(join(voiceRoot, 'qq-song-timing')), []);
      assert.equal((await detect({ sourcePath, duration })).cached, false);
      assert.equal((await detect({ sourcePath, duration })).cached, true);
      assert.equal(analyzed, 2);
    });
  }
});

test('cancels queued model work promptly and continues the queue afterward', async () => {
  const started = Promise.withResolvers();
  const running = Promise.withResolvers();
  const calls = [];
  const first = runSongModelJob(async () => {
    calls.push('first');
    started.resolve();
    await running.promise;
  });
  await started.promise;
  const controller = new AbortController();
  const reason = new Error('cancel queued timing');
  const queued = runSongModelJob(async () => assert.fail('Cancelled work cannot run'), { signal: controller.signal });
  controller.abort(reason);
  let timer;
  try {
    await assert.rejects(Promise.race([queued, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Queued cancellation stalled')), 1000);
    })]), (error) => error === reason);
    assert.deepEqual(calls, ['first']);
  } finally {
    clearTimeout(timer);
    running.resolve();
    await first;
  }
  assert.equal(await runSongModelJob(async () => {
    calls.push('next');
    return 'completed';
  }), 'completed');
  assert.deepEqual(calls, ['first', 'next']);
});
