import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { findQQMusicDownload, snapshotQQMusicDownloads, waitForQQMusicDownload } from '../plugin/src/qq-music-download.mjs';

const fixture = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'surfcore-qq-music-download-'));
  t.after(async () => {
    if (dirname(resolve(directory)) === resolve(tmpdir())) await rm(directory, { recursive: true, force: true });
  });
  const vip = join(directory, 'VipSongsDownload');
  await mkdir(vip);
  return { directory, vip };
};

const title = '17さいのうた。';
const artist = 'ユイカ';
const name = '17さいのうた。 (17岁的歌。) - 『ユイカ』';
const timing = { pollMs: 10, settleMs: 30, timeoutMs: 1_000 };

test('takes the newly downloaded recording and its exact lyric sidecar', async (t) => {
  const { directory, vip } = await fixture(t);
  await writeFile(join(directory, name + '.mp3'), 'older complete download');
  const before = await snapshotQQMusicDownloads(directory);
  const path = join(vip, name + '.mgg');
  const lyricPath = join(vip, name + '.lrc');
  await Promise.all([
    writeFile(path, 'new complete download'),
    writeFile(lyricPath, '[00:31.00] lyrics'),
    writeFile(join(vip, '17さいのうた。 - 别的歌手.mgg'), 'different singer'),
    writeFile(join(vip, '17さいのうた。 (现场版) - 『ユイカ』.mgg'), 'different recording'),
    writeFile(join(vip, name + '.ogg.part'), 'an unfinished download'),
  ]);
  assert.deepEqual(await waitForQQMusicDownload({ directory, before, title, artist, ...timing }), { path, lyricPath });
});

test('rejects ambiguous new matching recordings', async (t) => {
  const { directory, vip } = await fixture(t);
  const before = await snapshotQQMusicDownloads(directory);
  await writeFile(join(vip, name + '.mgg'), 'new recording');
  await writeFile(join(directory, name + '.mp3'), 'another new recording');
  await assert.rejects(waitForQQMusicDownload({ directory, before, title, artist, ...timing }), /多份/u);
});

test('ignores an unchanged file and a zero-byte download', async (t) => {
  const { directory, vip } = await fixture(t);
  await writeFile(join(directory, name + '.mp3'), 'old recording');
  const before = await snapshotQQMusicDownloads(directory);
  await writeFile(join(vip, name + '.mgg'), '');
  await assert.rejects(waitForQQMusicDownload({ directory, before, title, artist, ...timing, timeoutMs: 60 }), /超时/u);
});

test('detects replacement at the same path without adopting stale lyrics', async (t) => {
  const { directory } = await fixture(t);
  const path = join(directory, name + '.mgg');
  await writeFile(path, 'old');
  await writeFile(join(directory, name + '.lrc'), 'old lyrics');
  const before = await snapshotQQMusicDownloads(directory);
  await writeFile(path, 'updated download');
  assert.deepEqual(await waitForQQMusicDownload({ directory, before, title, artist, ...timing }), { path, lyricPath: undefined });
});

test('matches QQ Music multi-artist filename separators without losing singer order or membership', async (t) => {
  const { directory } = await fixture(t);
  const before = await snapshotQQMusicDownloads(directory);
  const songTitle = '酣梦于彼岸深红';
  const songArtist = '鸣潮先约电台,jixwang,VISION SOUND';
  const stem = join(directory, songTitle + ' - 鸣潮先约电台 _ jixwang _ VISION SOUND');
  const path = stem + '.mp3';
  const lyricPath = stem + '.lrc';
  await writeFile(path, 'completed multi-artist recording');
  await writeFile(lyricPath, '[00:15.00] lyrics');
  assert.deepEqual(await waitForQQMusicDownload({ directory, before, title: songTitle, artist: songArtist, ...timing }), { path, lyricPath });
  assert.deepEqual(await findQQMusicDownload({ directory, title: songTitle, artist: songArtist }), { path, lyricPath });
  for (const wrong of ['鸣潮先约电台', 'jixwang,鸣潮先约电台,VISION SOUND', '鸣潮先约电台,jixwang,Other Artist']) {
    assert.equal(await findQQMusicDownload({ directory, title: songTitle, artist: wrong }), undefined);
  }
});

test('underscores inside an artist name remain significant', async (t) => {
  const { directory } = await fixture(t);
  const path = join(directory, 'Song - Artist_Name.wav');
  await writeFile(path, 'completed recording');
  assert.deepEqual(await findQQMusicDownload({ directory, title: 'Song', artist: 'Artist_Name' }), { path, lyricPath: undefined });
  assert.equal(await findQQMusicDownload({ directory, title: 'Song', artist: 'Artist,Name' }), undefined);
});

test('equates version bracket spacing without dropping the version', async (t) => {
  const { directory } = await fixture(t);
  const stem = join(directory, '可不可以 (女声版) - 季彦霖');
  await writeFile(stem + '.mp3', 'exact version');
  await writeFile(stem + '.lrc', '[00:15]Same version lyrics');
  assert.deepEqual(await findQQMusicDownload({ directory, title: '可不可以（女声版）', artist: '季彦霖' }),
    { path: stem + '.mp3', lyricPath: stem + '.lrc' });
  for (const wrong of ['可不可以', '可不可以（现场版）', '可不可以（男声版）']) {
    assert.equal(await findQQMusicDownload({ directory, title: wrong, artist: '季彦霖' }), undefined);
  }
});
