import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { videoFrames } from '../plugin/src/video-frames.mjs';
import { parseMediaSegments, resolveMessageMedia } from '../plugin/src/qq-media.mjs';

const ffmpeg = process.env.SURFCORE_TEST_FFMPEG || process.env.SURFCORE_FFMPEG || 'ffmpeg';
let available = true;
try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore', windowsHide: true }); } catch { available = false; }

test('short video produces frames and videos exceeding three minutes are refused', { skip: !available, timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surfcore-video-test-'));
  try {
    for (const seconds of [3, 181]) {
      const file = join(directory, seconds + '.mp4');
      execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=red:s=32x32:r=1', '-t', String(seconds), '-c:v', 'mpeg4', '-y', file], { windowsHide: true, timeout: 10000 });
      const result = await videoFrames(await readFile(file), { ffmpeg });
      if (seconds === 3) {
        assert.equal(result.images?.length, 3);
        assert.equal(result.images[0].extension, 'jpg');
        const originalFetch = globalThis.fetch;
        const previous = process.env.SURFCORE_FFMPEG;
        try {
          process.env.SURFCORE_FFMPEG = ffmpeg;
          globalThis.fetch = async () => new Response(await readFile(file));
          const parsed = parseMediaSegments([{ type: 'video', data: { url: 'https://gchat.qpic.cn/video' } }]);
          const resolved = await resolveMessageMedia({ ...parsed, messageId: '1' }, async () => { throw new Error('unexpected action'); });
          assert.equal(resolved.images.length, 3);
          assert.match(resolved.text, /声音未识别/);
          const failedSpeech = await resolveMessageMedia({ ...parsed, messageId: '1' }, async () => {}, { transcribe: async () => { throw new Error('failure'); } });
          assert.equal(failedSpeech.images.length, 3);
          assert.match(failedSpeech.text, /声音未识别/);
        } finally {
          globalThis.fetch = originalFetch;
          if (previous === undefined) delete process.env.SURFCORE_FFMPEG; else process.env.SURFCORE_FFMPEG = previous;
        }
      } else {
        assert.match(result.error, /超过3分钟/);
        const originalFetch = globalThis.fetch;
        let transcribed = false;
        try {
          globalThis.fetch = async () => new Response(await readFile(file));
          const parsed = parseMediaSegments([{ type: 'video', data: { url: 'https://gchat.qpic.cn/video' } }]);
          const resolved = await resolveMessageMedia({ ...parsed, messageId: '1' }, async () => {}, { transcribe: async () => { transcribed = true; } });
          assert.match(resolved.text, /超过3分钟/);
          assert.equal(transcribed, false);
        } finally { globalThis.fetch = originalFetch; }
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unknown video or absent decoder fails closed', async () => {
  assert.ok((await videoFrames(Buffer.from('not video'), { ffmpeg: 'no-such-ffmpeg-executable' })).error);
});
