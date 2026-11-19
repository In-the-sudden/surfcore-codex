import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createQQMusicSource } from '../plugin/src/qq-music-source.mjs';
import { waitForQQMusicDownload } from '../plugin/src/qq-music-download.mjs';
import { importSongRecording, resolveSong } from '../plugin/src/qq-song.mjs';

function pcmWav() {
  const data = Buffer.alloc(16044);
  data.write('RIFF', 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24);
  data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(data.length - 44, 40);
  return data;
}

test('a completed desktop download is validated, imported under the requested title and reused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surfcore-qq-music-source-'));
  const downloads = join(root, 'qqmusic');
  const original = join(downloads, 'Song (display title) - Singer.wav');
  const bytes = pcmWav();
  let downloadsStarted = 0;
  try {
    await mkdir(downloads);
    const acquire = createQQMusicSource({
      voiceRoot: root,
      startDownload: async () => {
        downloadsStarted++;
        await writeFile(original, bytes, { flag: 'wx' });
        return { title: 'Song (display title)', artist: 'Singer' };
      },
      waitForDownload: (options) => waitForQQMusicDownload({ ...options, pollMs: 5, settleMs: 10 }),
    });
    const request = { title: 'Song', artist: 'Singer' };
    const first = await acquire(request);
    const second = await acquire(request);
    assert.equal(downloadsStarted, 1);
    assert.equal(first.source.path, second.source.path);
    assert.deepEqual(await readFile(first.source.path), bytes);
    assert.deepEqual(await readFile(original), bytes);
    assert.equal(first.source.opening, undefined);
  } finally {
    if (dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true });
  }
});

test('automatic import cannot replace a recording that already has an approved timing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surfcore-qq-music-adopt-'));
  try {
    const path = join(root, 'original.wav');
    const replacement = join(root, 'replacement.wav');
    const different = pcmWav();
    different.writeInt16LE(10, 44);
    await writeFile(path, pcmWav());
    await writeFile(replacement, different);
    const song = { title: 'Song', artist: 'Singer' };
    const options = { root };
    await importSongRecording({ ...song, path, openingVocalStart: 0.1, openingEnd: 0.8 }, options);
    const attempt = await importSongRecording({ ...song, path: replacement }, { ...options, keepExisting: true });
    assert.equal(attempt.existing, true);
    const resolved = await resolveSong(song, { importRoot: root, catalogPath: join(root, 'qq-songs.json'), lookupOnline: false });
    assert.deepEqual(resolved.learningSource.opening, { vocalStart: 0.1, phraseEnd: 0.8 });
    assert.deepEqual(await readFile(resolved.learningSource.path), pcmWav());
  } finally {
    if (dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true });
  }
});

test('title-only desktop search selects its first result despite ambiguous local versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surfcore-qq-music-first-'));
  const downloads = join(root, 'qqmusic');
  const original = join(downloads, 'Song (female cover) - First Singer.wav');
  const calls = [];
  try {
    await mkdir(downloads);
    const acquire = createQQMusicSource({
      voiceRoot: root,
      resolveRecording: async (request) => {
        if (!request.artist) return { needsArtist: true, text: 'Local versions are ambiguous' };
        assert.equal(request.artist, 'First Singer');
        calls.push('selected-version');
        return { learningSource: { path: 'approved-first.wav', opening: { vocalStart: 1, phraseEnd: 30 } } };
      },
      startDownload: async (request, options) => {
        assert.equal(request.artist, undefined);
        assert.deepEqual(options.avoidedArtists, ['Known Male']);
        calls.push('search');
        await writeFile(original, pcmWav());
        return { title: 'Song (female cover)', artist: 'First Singer' };
      },
      waitForDownload: (options) => waitForQQMusicDownload({ ...options, pollMs: 5, settleMs: 10 }),
      importRecording: async () => assert.fail('Approved selected version should be reused'),
    });
    const result = await acquire({ title: 'Song' }, { avoidedArtists: ['Known Male'] });
    assert.deepEqual(calls, ['search', 'selected-version']);
    assert.equal(result.artist, 'First Singer');
    assert.equal(result.source.path, 'approved-first.wav');
  } finally {
    if (dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true });
  }
});

test('a decodable but incomplete desktop download is not indexed as the selected recording', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surfcore-qq-music-incomplete-'));
  const downloads = join(root, 'qqmusic');
  const request = { title: 'Song', artist: 'Singer' };
  try {
    await mkdir(downloads);
    const acquire = createQQMusicSource({
      voiceRoot: root,
      startDownload: async () => {
        await writeFile(join(downloads, 'Song - Singer.wav'), pcmWav());
        return { ...request, durationSeconds: 60 };
      },
      waitForDownload: (options) => waitForQQMusicDownload({ ...options, pollMs: 5, settleMs: 10 }),
    });
    await assert.rejects(acquire(request), /时长.*不符/);
    const result = await resolveSong(request, { importRoot: root, catalogPath: join(root, 'qq-songs.json'), lookupOnline: false });
    assert.equal(result.learningSource, undefined);
  } finally {
    if (dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true });
  }
});

test('the selected display-title recording is reused before waiting for any new download', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surfcore-qq-music-existing-index-'));
  try {
    await mkdir(join(root, 'qqmusic'));
    const original = join(root, 'approved.wav');
    await writeFile(original, pcmWav());
    const selected = { title: 'Song (female cover)', artist: 'First Singer' };
    await importSongRecording({ ...selected, path: original, openingVocalStart: 0.1, openingEnd: 0.8 }, { root });
    const acquire = createQQMusicSource({
      voiceRoot: root,
      startDownload: async () => selected,
      waitForDownload: async () => assert.fail('An indexed selected recording should not wait for another download'),
      importRecording: async () => assert.fail('The approved recording should not be imported again'),
    });
    const result = await acquire({ title: 'Song' });
    assert.equal(result.artist, selected.artist);
    assert.deepEqual(result.source.opening, { vocalStart: 0.1, phraseEnd: 0.8 });
    assert.deepEqual(await readFile(result.source.path), pcmWav());
  } finally {
    if (dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true });
  }
});

test('an unchanged completed download for the selected first singer is imported without timing out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surfcore-qq-music-existing-download-'));
  const downloads = join(root, 'qqmusic');
  try {
    await mkdir(downloads);
    const selected = { title: 'Song (female cover)', artist: 'First Singer', durationSeconds: 1 };
    const original = join(downloads, 'Song (female cover) - First Singer.wav');
    const other = pcmWav();
    other.writeInt16LE(23, 44);
    await writeFile(original, pcmWav());
    await writeFile(join(downloads, 'Song (female cover) - Other Singer.wav'), other);
    const acquire = createQQMusicSource({
      voiceRoot: root,
      startDownload: async () => selected,
      waitForDownload: async () => assert.fail('QQ Music may leave an already completed file unchanged'),
    });
    const result = await acquire({ title: 'Song' });
    assert.equal(result.artist, selected.artist);
    assert.deepEqual(await readFile(result.source.path), pcmWav());
    assert.deepEqual(await readFile(original), pcmWav());
  } finally {
    if (dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true });
  }
});

test('a pre-existing file changed by the new download must settle before conversion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surfcore-qq-music-growing-download-'));
  const downloads = join(root, 'qqmusic');
  let waited = false;
  try {
    await mkdir(downloads);
    const original = join(downloads, 'Song - Singer.wav');
    await writeFile(original, 'incomplete');
    const acquire = createQQMusicSource({
      voiceRoot: root,
      startDownload: async () => {
        await writeFile(original, pcmWav());
        return { title: 'Song', artist: 'Singer', durationSeconds: 1 };
      },
      waitForDownload: async (options) => {
        waited = true;
        return waitForQQMusicDownload({ ...options, pollMs: 5, settleMs: 10 });
      },
    });
    const result = await acquire({ title: 'Song' });
    assert.equal(waited, true);
    assert.deepEqual(await readFile(result.source.path), pcmWav());
  } finally {
    if (dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true });
  }
});

test('a download wait failure retains its original cause and phase for owner diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surfcore-qq-music-wait-failure-'));
  const cause = new Error('Waiting for the selected recording timed out');
  try {
    await mkdir(join(root, 'qqmusic'));
    const acquire = createQQMusicSource({
      voiceRoot: root,
      startDownload: async () => ({ title: 'Song', artist: 'Singer' }),
      waitForDownload: async () => { throw cause; },
    });
    await assert.rejects(acquire({ title: 'Song' }), (error) => {
      assert.equal(error.cause, cause);
      assert.equal(error.phase, 'qq-music-download');
      assert.match(error.userMessage, /已完成下载/);
      return true;
    });
  } finally {
    if (dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true });
  }
});

test('one exact artist and title is available without a QQ Music desktop executable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'surfcore-qq-music-local-'));
  t.after(async () => {
    if (dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true });
  });
  const downloads = join(root, 'qqmusic');
  await mkdir(downloads);
  await writeFile(join(downloads, 'Song - Singer.wav'), pcmWav());
  await writeFile(join(downloads, 'Song - Other Singer.wav'), 'wrong recording');
  const acquire = createQQMusicSource({
    voiceRoot: root,
    desktopAvailable: async () => false,
    startDownload: async () => assert.fail('The unavailable desktop must not be invoked'),
  });
  assert.equal(await acquire({ title: 'Song', artist: 'Missing Singer' }), undefined);
  const result = await acquire({ title: 'Song', artist: 'Singer' });
  assert.equal(result.artist, 'Singer');
  assert.deepEqual(await readFile(result.source.path), pcmWav());
  assert.equal(result.source.opening, undefined);
});

test('an explicitly versioned title can use one exact download without an artist', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'surfcore-qq-music-local-version-'));
  t.after(async () => {
    if (dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true });
  });
  const downloads = join(root, 'qqmusic');
  await mkdir(downloads);
  const lyricPath = join(downloads, 'Song (Live) - Artist Name.lrc');
  await writeFile(lyricPath, '[00:00.10]Lyrics for this recording');
  await writeFile(join(downloads, 'Song (Live) - Artist Name.wav'), pcmWav());
  await writeFile(join(downloads, 'Song - Other Singer.wav'), 'wrong recording');
  const acquire = createQQMusicSource({
    voiceRoot: root,
    desktopAvailable: async () => false,
    startDownload: async () => assert.fail('The unavailable desktop must not be invoked'),
  });
  assert.equal(await acquire({ title: 'Song' }), undefined);
  assert.equal(await acquire({ title: 'Song (Studio Version)' }), undefined);
  await writeFile(join(downloads, 'Song (Live) - Another Artist.wav'), pcmWav());
  assert.equal(await acquire({ title: 'Song（Live）' }), undefined);
  await rm(join(downloads, 'Song (Live) - Another Artist.wav'));
  const result = await acquire({ title: 'Song（Live）' });
  assert.equal(result.artist, 'Artist Name');
  assert.deepEqual(await readFile(result.source.path), pcmWav());
  assert.equal(result.source.lyricPath, lyricPath);
});
