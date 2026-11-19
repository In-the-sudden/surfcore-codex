import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSongLearner, probeSongDuration } from '../plugin/src/qq-song-learn.mjs';
import { normalizeWav } from '../plugin/src/voice-wav.mjs';

const ffmpeg = process.env.SURFCORE_FFMPEG || 'ffmpeg';
const skip = spawnSync(ffmpeg, ['-version'], { windowsHide: true, timeout: 3000 }).status !== 0;

function wav(seconds, { rate = 16000, channels = 1, sample = () => 6000 } = {}) {
  const samples = Math.round(rate * seconds) * channels;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    buffer.writeInt16LE(sample(index / channels / rate), 44 + index * 2);
  }
  return buffer;
}

async function fixture(t) {
  const base = tmpdir();
  const voiceRoot = await mkdtemp(join(base, 'qq-song-learn-test-'));
  t.after(() => rm(voiceRoot, { recursive: true, force: true }));
  const sourcePath = join(voiceRoot, '源音频.wav');
  const source = wav(4, { rate: 44100, channels: 2, sample: (seconds) => 1000 * (1 + Math.floor(seconds)) });
  await writeFile(sourcePath, source);
  return { voiceRoot, sourcePath, source };
}

test('probes the duration of a bounded local audio file', { skip }, async (t) => {
  const { sourcePath } = await fixture(t);
  assert.equal(await probeSongDuration(sourcePath, { ffmpeg }), 4);
  await assert.rejects(probeSongDuration('https://example.com/track.wav', { ffmpeg }), { phase: 'source' });
});

test('extracts only the requested clip and reuses successful identical audio concurrently', { skip }, async (t) => {
  const { voiceRoot, sourcePath, source } = await fixture(t);
  const duplicate = join(voiceRoot, 'copy.wav');
  await writeFile(duplicate, source);
  const learn = createSongLearner({ voiceRoot, ffmpeg, render: async ({ clipPath, outputPath }) => {
    const clip = normalizeWav(await readFile(clipPath));
    assert.equal(clip.durationMs, 2000);
    assert.equal(clip.channels, 2);
    assert.equal(clip.sampleRate, 44100);
    assert.equal(clip.audio.readInt16LE(clip.dataOffset), 3000);
    assert.equal(clip.audio.readInt16LE(clip.audio.length - 2), 4000);
    await writeFile(outputPath, wav(2));
  } });
  const [first, second] = await Promise.all([
    learn({ sourcePath, start: 2, end: 4 }),
    learn({ sourcePath: duplicate, start: 2, end: 4 }),
  ]);
  assert.deepEqual([first.cached, second.cached], [false, true]);
  assert.equal(first.durationSeconds, 2);
  assert.deepEqual(first.audio, second.audio);
  assert.equal(normalizeWav(second.audio).audio.readInt16LE(44), 6000);
  assert.deepEqual(await readFile(sourcePath), source);
});

test('rejects overlong and truncated intervals before conversion', { skip }, async (t) => {
  const { voiceRoot, sourcePath } = await fixture(t);
  const learn = createSongLearner({ voiceRoot, ffmpeg, render: async () => assert.fail('Invalid source should never reach models') });
  await assert.rejects(learn({ sourcePath, start: 0, end: 41 }), { phase: 'clip' });
  await assert.rejects(learn({ sourcePath, start: 2, end: 5 }), { phase: 'clip' });
});

test('an aborted render does not publish partial audio and can be retried', { skip }, async (t) => {
  const { voiceRoot, sourcePath } = await fixture(t);
  const controller = new AbortController();
  const reason = new Error('cancel learning');
  const learn = createSongLearner({ voiceRoot, ffmpeg, render: async ({ outputPath, signal }) => {
    await writeFile(outputPath, wav(1));
    if (signal) controller.abort(reason);
  } });
  const clip = { sourcePath, start: 0, end: 1 };
  await assert.rejects(learn(clip, { signal: controller.signal }), (error) => error === reason);
  assert.deepEqual(await readdir(join(voiceRoot, 'qq-song-learned')), []);
  assert.equal((await learn(clip)).cached, false);
});

test('rejects invalid model output before caching so the same clip can be repaired', { skip }, async (t) => {
  const { voiceRoot, sourcePath } = await fixture(t);
  let rendered = wav(2);
  const learn = createSongLearner({ voiceRoot, ffmpeg, render: async ({ outputPath }) => writeFile(outputPath, rendered) });
  const clip = { sourcePath, start: 0, end: 1 };
  await assert.rejects(learn(clip), { phase: 'mix' });
  rendered = wav(1);
  assert.equal((await learn(clip)).cached, false);
  assert.equal((await learn(clip)).cached, true);
});

test('renders a longer opening as a bounded QQ WAV', { skip }, async (t) => {
  const { voiceRoot, sourcePath } = await fixture(t);
  await writeFile(sourcePath, wav(36, { rate: 44100, channels: 2 }));
  const learn = createSongLearner({ voiceRoot, ffmpeg, render: async ({ clipPath, outputPath }) => {
    assert.equal((await readFile(clipPath)).readUInt32LE(40), 6350400);
    await writeFile(outputPath, wav(36));
  } });
  const result = await learn({ sourcePath, start: 0, end: 36 });
  assert.equal(result.durationSeconds, 36);
  assert.equal(result.audio.length, 1152044);
});

test('a queued request can be cancelled while another model job is running', { skip }, async (t) => {
  const { voiceRoot, sourcePath } = await fixture(t);
  const started = Promise.withResolvers();
  const running = Promise.withResolvers();
  const learn = createSongLearner({ voiceRoot, ffmpeg, render: async ({ outputPath }) => {
    started.resolve();
    await running.promise;
    await writeFile(outputPath, wav(1));
  } });
  const first = learn({ sourcePath, start: 0, end: 1 });
  await started.promise;
  const controller = new AbortController();
  const queued = learn({ sourcePath, start: 1, end: 2 }, { signal: controller.signal });
  controller.abort();
  try {
    await assert.rejects(Promise.race([queued, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Queued cancellation stalled')), 1000);
      timer.unref();
    })]), { name: 'AbortError' });
  } finally {
    running.resolve();
    await first;
  }
});

const python = process.env.SURFCORE_TEST_PYTHON;
const helper = fileURLToPath(new URL('../plugin/src/qq-song-learn-audio.py', import.meta.url));

test('mixes converted lead with the original signal after removing the estimated old lead', { skip: skip || !python }, async (t) => {
  const { voiceRoot, sourcePath } = await fixture(t);
  const leadPath = join(voiceRoot, 'old-lead.wav');
  const convertedPath = join(voiceRoot, 'new-lead.wav');
  const mixPath = join(voiceRoot, 'mixed.wav');
  const stereo = { rate: 44100, channels: 2 };
  await Promise.all([
    writeFile(sourcePath, wav(1, { ...stereo, sample: (time) => time < 0.5 ? 10000 : 6000 })),
    writeFile(leadPath, wav(1, { ...stereo, sample: (time) => time < 0.5 ? 2000 : -2000 })),
    writeFile(convertedPath, wav(1, { rate: 44100, sample: (time) => time < 0.5 ? -1000 : 1000 })),
  ]);
  const mixed = spawnSync(python, [helper, 'mix', sourcePath, leadPath, convertedPath, mixPath], {
    cwd: voiceRoot, windowsHide: true, timeout: 10_000,
  });
  assert.equal(mixed.status, 0, mixed.stderr?.toString());
  const decoded = spawnSync(ffmpeg, ['-loglevel', 'error', '-i', mixPath, '-f', 's16le', 'pipe:1'], {
    windowsHide: true, timeout: 10_000,
  });
  assert.equal(decoded.status, 0, decoded.stderr?.toString());
  assert.equal(decoded.stdout.length, 88200);
  assert.equal(decoded.stdout.readInt16LE(8820), 6000);
  assert.equal(decoded.stdout.readInt16LE(44100), 10000);
});

test('the real stem helper accepts an opening beyond 30 seconds', { skip: skip || !python }, async (t) => {
  const { voiceRoot, sourcePath } = await fixture(t);
  const output = join(voiceRoot, 'prepared.wav');
  await writeFile(sourcePath, wav(36, { rate: 44100, channels: 2 }));
  const prepared = spawnSync(python, [helper, 'prepare', sourcePath, sourcePath, output], {
    cwd: voiceRoot, windowsHide: true, timeout: 10_000,
  });
  assert.equal(prepared.status, 0, prepared.stderr?.toString());
  assert.equal((await readFile(output)).readUInt32LE(40), 6350400);
});
