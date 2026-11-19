import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const cacheModule = new URL('../plugin/src/voice-cache.mjs', import.meta.url);
const hash = 'a'.repeat(64);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'surfcore-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'voice');
  async function file(relative, size = 5) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(size));
    return path;
  }
  return { directory, root, file };
}

test('voice cache keeps the exact limit and clears disposable audio after crossing it', async (t) => {
  const { directory, root, file } = await fixture(t);
  const download = await file('qqmusic/VipSongsDownload/test.mgg', 10);
  const learned = await file('qq-song-learned/' + hash + '.wav', 10);
  const source = await file('qq-song-learned/sources/' + hash + '/source.ogg', 10);
  const converted = await file('qq-song-downloads/track-abcdef/source.mp3', 10);
  const index = await file('qq-song-downloads/index/' + hash + '/' + hash + '.json', 2);
  const manual = await file('qq-song-imported/track-abcdef/source.mp3', 30);
  const working = await file('qq-song-learned/job-abcdef/result.wav', 30);
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'ignore.mp3'), 'keep');
  await symlink(outside, join(root, 'qq-song-downloads', 'track-ghijkl'), 'junction');

  const { createVoiceCache } = await import(cacheModule);
  const cache = createVoiceCache({ root, limitBytes: 42 });
  assert.equal((await cache.check()).bytes, 42);
  assert.equal((await readFile(download)).length, 10);
  const latest = await file('qqmusic/new.mp3', 1);
  const cleanup = await cache.check();
  assert.equal(cleanup.bytes, 0);
  assert.equal(cleanup.lastCleanup.bytes, 43);
  for (const path of [download, learned, source, converted, index, latest]) {
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
  assert.equal((await readFile(manual)).length, 30);
  assert.equal((await readFile(working)).length, 30);
  assert.equal(await readFile(join(outside, 'ignore.mp3'), 'utf8'), 'keep');
});

test('voice cache waits until ongoing audio work has released its files', async (t) => {
  const { root, file } = await fixture(t);
  const downloaded = await file('qqmusic/song.mp3', 20);
  const { createVoiceCache } = await import(cacheModule);
  const cache = createVoiceCache({ root, limitBytes: 10 });
  await cache.run(async () => {
    await cache.check();
    assert.equal((await readFile(downloaded)).length, 20);
  });
  await cache.check();
  await assert.rejects(readFile(downloaded), { code: 'ENOENT' });
});

test('the default audio budget is 500 MB', async () => {
  const { voiceCache } = await import(cacheModule);
  assert.equal(voiceCache.status().limitBytes, 500_000_000);
});

test('stale voice uploads and transcodes share the song budget while fresh files stay available', async (t) => {
  const { root, file } = await fixture(t);
  const uuid = '5f374b6c-9111-4ee0-96cc-cb3dcb779b82';
  const song = await file('qqmusic/song.mp3', 10);
  const speech = await file('audio-upload/snowluma-ptt-in-' + uuid, 10);
  const silk = await file('audio-upload/' + uuid, 10);
  const transcode = await file('audio-transcode/0123456789abcdef.wav', 10);
  const fresh = await file('audio-upload/snowluma-ptt-wave-' + uuid + '.wav', 20);
  const unmanaged = await file('audio-upload/keep.wav', 20);
  const stale = new Date(Date.now() - 60 * 60_000);
  for (const path of [speech, silk, transcode, unmanaged]) await utimes(path, stale, stale);
  const { createVoiceCache } = await import(cacheModule);
  const cache = createVoiceCache({ root, temporaryRoot: root, limitBytes: 35 });
  const result = await cache.check();
  assert.equal(result.lastCleanup?.bytes, 40);
  for (const path of [song, speech, silk, transcode]) await assert.rejects(readFile(path), { code: 'ENOENT' });
  assert.equal((await readFile(fresh)).length, 20);
  assert.equal((await readFile(unmanaged)).length, 20);
});
