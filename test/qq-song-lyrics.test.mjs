import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readSongLyrics } from '../plugin/src/qq-song-lyrics.mjs';


async function fixture(t) {
  const base = tmpdir();
  const voiceRoot = await mkdtemp(join(base, 'qq-song-lyrics-test-'));
  t.after(() => rm(voiceRoot, { recursive: true, force: true }));
  const sourcePath = join(voiceRoot, 'source.mp3');
  const audio = Buffer.from('A fixed exact recording fixture.');
  await writeFile(sourcePath, audio);
  return { voiceRoot, sourcePath, audio, start: 0, end: 10, title: 'Song', artist: 'Singer' };
}

test('reads GB18030 lyrics and caches the original bytes without changing audio or manual indexes', async (t) => {
  const input = await fixture(t);
  const lyricPath = join(input.voiceRoot, 'original.lrc');
  const bytes = Buffer.concat([Buffer.from('[00:00.00]'), Buffer.from('c4e3bac3', 'hex'),
    Buffer.from('\r\n[00:10.00]'), Buffer.from('cac0bde7', 'hex'), Buffer.from('\r\n[00:20.00]')]);
  const indexDirectory = join(input.voiceRoot, 'qq-song-imported', 'index');
  await mkdir(indexDirectory, { recursive: true });
  const indexPath = join(indexDirectory, 'approved.json');
  const index = '{"opening":{"vocalStart":1.25,"phraseEnd":9.5}}';
  await writeFile(indexPath, index);
  await writeFile(lyricPath, bytes);
  const result = await readSongLyrics({ ...input, lyricPath });
  assert.equal(result.status, 'aligned');
  assert.equal(result.encoding, 'gb18030');
  assert.equal(result.source, 'explicit');
  assert.equal(result.text, '你好');
  assert.deepEqual(result.lines, [{ time: 0, text: '你好' }]);
  assert.equal(result.alignment, 'timestamp-only');
  assert.match(result.note, /未逐词确认/);
  const hash = createHash('sha256').update(input.audio).digest('hex');
  assert.equal(result.sourceSha256, hash);
  assert.deepEqual(await readFile(join(input.voiceRoot, 'qq-song-lyrics', hash, 'lyrics.lrc')), bytes);
  assert.deepEqual(await readFile(lyricPath), bytes);
  assert.deepEqual(await readFile(input.sourcePath), input.audio);
  assert.equal(await readFile(indexPath, 'utf8'), index);
  assert.doesNotMatch(JSON.stringify(result), /[A-Za-z]:[\\/]|original\.lrc|source\.mp3/);
  await rm(lyricPath);
  const cached = await readSongLyrics(input);
  assert.equal(cached.source, 'cache');
  assert.equal(cached.text, '你好');
});

test('decodes UTF-8 and both UTF-16 BOM forms', async (t) => {
  for (const encoding of ['utf-8', 'utf-16le', 'utf-16be']) {
    await t.test(encoding, async (subtest) => {
      const input = await fixture(subtest);
      const text = '[00:00.00]星光\n[00:10.00]';
      const body = Buffer.from(text, encoding === 'utf-8' ? 'utf8' : 'utf16le');
      if (encoding === 'utf-16be') body.swap16();
      const bom = encoding === 'utf-8' ? [0xef, 0xbb, 0xbf] : encoding === 'utf-16le' ? [0xff, 0xfe] : [0xfe, 0xff];
      const lyricPath = join(input.voiceRoot, 'source.lrc');
      await writeFile(lyricPath, Buffer.concat([Buffer.from(bom), body]));
      const result = await readSongLyrics(input);
      assert.equal(result.status, 'aligned');
      assert.equal(result.encoding, encoding);
      assert.equal(result.source, 'sidecar');
      assert.equal(result.text, '星光');
    });
  }
});

test('honors multiple timestamps, offsets, enhanced word tags, blank boundaries, and source offsets', async (t) => {
  const input = await fixture(t);
  const lyricPath = join(input.voiceRoot, 'source.lrc');
  await writeFile(lyricPath, '[offset:+500]\n[00:00.00][00:20.00]<00:00.00>First <00:01.00>line\n' +
    '[00:05.00]\n[00:10.00]Second line\n[00:15.00]\n[00:25.00]Last line');
  const result = await readSongLyrics({ ...input, start: 0, end: 4.5, sourceStart: 10 });
  assert.equal(result.status, 'aligned');
  assert.deepEqual(result.range, { start: 10, end: 14.5 });
  assert.deepEqual(result.lines, [{ time: 9.5, text: 'Second line' }]);
  assert.equal(result.uncertainLastLine, false);
  const repeated = await readSongLyrics({ ...input, start: 19.5, end: 24.5 });
  assert.deepEqual(repeated.lines, [{ time: 19.5, text: 'First line' }]);
  const partial = await readSongLyrics({ ...input, start: 3, end: 4 });
  assert.deepEqual(partial.lines, [{ time: -0.5, text: 'First line' }]);
  const empty = await readSongLyrics({ ...input, start: 4.5, end: 9.5 });
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.reason, 'no-overlap');
  const last = await readSongLyrics({ ...input, start: 30, end: 40 });
  assert.deepEqual(last.lines, [{ time: 24.5, text: 'Last line' }]);
  assert.equal(last.uncertainLastLine, true);
  assert.match(last.note, /末行没有下一时间点/);
});

test('negative offsets delay lyrics and preserve exact half-open boundaries', async (t) => {
  const input = await fixture(t);
  await writeFile(join(input.voiceRoot, 'source.lrc'), '[offset:-500]\n[00:10]Delayed line\n[00:11]');
  assert.equal((await readSongLyrics({ ...input, start: 9, end: 10.5 })).status, 'unavailable');
  const result = await readSongLyrics({ ...input, start: 10.5, end: 11.5 });
  assert.deepEqual(result.lines, [{ time: 10.5, text: 'Delayed line' }]);
  assert.equal((await readSongLyrics({ ...input, start: 11.5, end: 12 })).status, 'unavailable');
});

test('retains timed sung lines that equal the song title', async (t) => {
  const input = await fixture(t);
  await writeFile(join(input.voiceRoot, 'source.lrc'), '[ti:Song]\n[00:00]Song - Singer\n' +
    '[00:10]A lyric\n[00:20]Song\n[00:25]');
  const result = await readSongLyrics({ ...input, start: 20, end: 25 });
  assert.deepEqual(result.lines, [{ time: 20, text: 'Song' }]);
});

test('filters title, production credits, and local paths while retaining lyric interval boundaries', async (t) => {
  const input = await fixture(t);
  await writeFile(join(input.voiceRoot, 'source.lrc'), '[ti:Song]\n[ar:Singer]\n' +
    '[00:00]Song - Singer\n[00:01]作词：甲\n[00:02]演唱：Singer\n[00:03]制作人 乙\n' +
    '[00:04]我在星光下等你\n[00:06]录音室：Somewhere\n[00:07]D:\\private\\secret.txt\n[00:08]');
  const result = await readSongLyrics({ ...input, start: 0, end: 8 });
  assert.equal(result.status, 'aligned');
  assert.deepEqual(result.lines, [{ time: 4, text: '我在星光下等你' }]);
  assert.equal(result.text, '我在星光下等你');
  const creditsOnly = await readSongLyrics({ ...input, start: 6, end: 8 });
  assert.equal(creditsOnly.status, 'unavailable');
});

test('returns bounded untimed lyrics as unconfirmed whole-song reference', async (t) => {
  const input = await fixture(t);
  const lyricPath = join(input.voiceRoot, 'source.lrc');
  await writeFile(lyricPath, 'Song\n作曲：甲\n' + '没有时间轴的歌词\n'.repeat(300));
  const result = await readSongLyrics(input);
  assert.equal(result.status, 'untimed');
  assert.equal(result.alignment, 'unconfirmed');
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 1600);
  assert.deepEqual(result.lines, []);
  assert.match(result.note, /不能确认片段唱出的词/);
  assert.doesNotMatch(result.text, /Song|作曲/);
});

test('limits aligned output to twenty-four lines and sixteen hundred characters', async (t) => {
  const input = await fixture(t);
  await writeFile(join(input.voiceRoot, 'source.lrc'), Array.from({ length: 40 }, (_, index) =>
    '[00:' + String(index).padStart(2, '0') + ']' + '长歌词'.repeat(40)).join('\n'));
  const result = await readSongLyrics({ ...input, end: 39 });
  assert.equal(result.status, 'aligned');
  assert.ok(result.text.length <= 1600);
  assert.ok(result.lines.length <= 24);
  assert.equal(result.truncated, true);
  await writeFile(join(input.voiceRoot, 'short.lrc'), Array.from({ length: 40 }, (_, index) =>
    '[00:' + String(index).padStart(2, '0') + ']Line ' + index).join('\n'));
  const short = await readSongLyrics({ ...input, lyricPath: join(input.voiceRoot, 'short.lrc'), end: 39 });
  assert.equal(short.lines.length, 24);
  assert.equal(short.truncated, true);
});

test('explicit lyrics override a cached sidecar and are retained even when a clip has no overlap', async (t) => {
  const input = await fixture(t);
  await writeFile(join(input.voiceRoot, 'source.lrc'), '[00:00]Older text\n[00:10]');
  assert.equal((await readSongLyrics(input)).text, 'Older text');
  const lyricPath = join(input.voiceRoot, 'explicit.lrc');
  await writeFile(lyricPath, '[00:20]Corrected text\n[00:30]');
  const empty = await readSongLyrics({ ...input, lyricPath });
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.reason, 'no-overlap');
  const later = await readSongLyrics({ ...input, start: 20, end: 30 });
  assert.equal(later.source, 'cache');
  assert.equal(later.text, 'Corrected text');
});

test('links a QQ Music lyric only when its audio bytes match the imported recording exactly', async (t) => {
  const input = await fixture(t);
  const downloadDirectory = join(input.voiceRoot, 'qqmusic');
  await mkdir(downloadDirectory);
  const audioPath = join(downloadDirectory, 'Song - Singer.mp3');
  const lyricPath = join(downloadDirectory, 'Song - Singer.lrc');
  await writeFile(audioPath, input.audio);
  await writeFile(lyricPath, '[00:00]Same recording\n[00:10]');
  const result = await readSongLyrics(input);
  assert.equal(result.status, 'aligned');
  assert.equal(result.source, 'qqmusic');
  assert.equal(result.text, 'Same recording');
  const other = await fixture(t);
  await mkdir(join(other.voiceRoot, 'qqmusic'));
  await writeFile(join(other.voiceRoot, 'qqmusic', 'Song - Singer.mp3'), 'A different recording.');
  await writeFile(join(other.voiceRoot, 'qqmusic', 'Song - Singer.lrc'), '[00:00]Wrong recording');
  const mismatch = await readSongLyrics(other);
  assert.equal(mismatch.status, 'unavailable');
  assert.equal(mismatch.reason, 'recording-mismatch');
  assert.equal(mismatch.text, '');
  assert.equal((await readdir(other.voiceRoot)).includes('qq-song-lyrics'), false);
});

test('returns unavailable for missing, malformed, oversized, or untrusted lyrics without leaking paths', async (t) => {
  const cases = [
    ['missing', undefined],
    ['malformed', Buffer.from([0xff, 0xff, 0xff])],
    ['oversized', Buffer.alloc(256 * 1024 + 1, 0x61)],
    ['binary', Buffer.from([0x00, 0x01, 0x02])],
    ['broken BOM encoding', Buffer.from([0xef, 0xbb, 0xbf, 0xff])],
  ];
  for (const [label, bytes] of cases) {
    await t.test(label, async (subtest) => {
      const input = await fixture(subtest);
      if (bytes) await writeFile(join(input.voiceRoot, 'source.lrc'), bytes);
      const result = await readSongLyrics(input);
      assert.equal(result.status, 'unavailable');
      assert.equal(result.text, '');
      assert.deepEqual(result.lines, []);
      assert.doesNotMatch(JSON.stringify(result), /[A-Za-z]:[\\/]|source\.mp3|source\.lrc/);
    });
  }
  const input = await fixture(t);
  for (const lyricPath of ['relative.lrc', '\\\\server\\share\\lyrics.lrc', join(input.voiceRoot, '..', 'outside.lrc')]) {
    const result = await readSongLyrics({ ...input, lyricPath });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'untrusted-path');
  }
});

test('propagates cancellation instead of turning it into missing lyrics', async (t) => {
  const input = await fixture(t);
  const controller = new AbortController();
  const reason = new Error('Cancelled lyric read.');
  controller.abort(reason);
  await assert.rejects(readSongLyrics({ ...input, signal: controller.signal }), (error) => error === reason);
  const active = new AbortController();
  await writeFile(input.sourcePath, Buffer.alloc(8 * 1024 * 1024, 0x61));
  const work = readSongLyrics({ ...input, signal: active.signal });
  active.abort(reason);
  await assert.rejects(work, (error) => error === reason);
});
