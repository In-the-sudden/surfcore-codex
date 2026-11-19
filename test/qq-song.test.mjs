import assert from 'node:assert/strict';
import * as songs from '../plugin/src/qq-song.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { resolveSong } from '../plugin/src/qq-song.mjs';
import { normalizeWav } from '../plugin/src/voice-wav.mjs';

const ffmpeg = process.env.SURFCORE_FFMPEG || 'ffmpeg';
const canDecode = spawnSync(ffmpeg, ['-version'], { windowsHide: true, timeout: 3000 }).status === 0;
const unexpectedFetch = async () => assert.fail('Local song selection should be offline');

async function fixture(t, update = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'surfcore-qq-song-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, 'qq-songs.json');
  const song = {
    title: '小小奇迹',
    aliases: ['小小奇蹟'],
    artist: '知微',
    artistAliases: ['Zhiwei'],
    file: 'song.wav',
    sections: { opening: { start: 0, end: 1 }, chorus: { start: 2, end: 4 } },
    lines: [
      { text: 'You built a world of miracles', section: 'chorus', number: 1, start: 2, end: 3 },
      { text: 'The stream of shimmering daily moments', aliases: ['闪烁的瞬间'], section: 'chorus', number: 2, start: 3, end: 4 },
    ],
  };
  update(song);
  const wav = Buffer.alloc(44 + 4 * 32000);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let offset = 44; offset < wav.length; offset += 2) {
    wav.writeInt16LE(1000 * (1 + Math.floor((offset - 44) / 32000)), offset);
  }
  await Promise.all([writeFile(catalogPath, JSON.stringify([song])), writeFile(join(dir, 'song.wav'), wav)]);
  return { catalogPath, importRoot: dir, ffmpeg, fetchImpl: unexpectedFetch };
}

function inspectAudio(result) {
  const info = normalizeWav(result.audio);
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  return { duration: info.durationMs, firstSample: info.audio.readInt16LE(info.dataOffset) };
}

test('imports a recording for offline learning and retains only its confirmed chorus range', { skip: !canDecode }, async (t) => {
  const options = await fixture(t);
  const root = dirname(options.catalogPath);
  const input = { title: '导入测试曲', artist: '歌手', path: join(root, 'song.wav'), chorusStart: 2, chorusEnd: 4 };
  await assert.rejects(async () => songs.importSongRecording({ ...input, chorusEnd: 5 }, { root, ffmpeg }), /副歌时间/);
  await assert.rejects(async () => songs.importSongRecording({ ...input, openingVocalStart: 1, openingEnd: 5 }, { root, ffmpeg }), /开头/);
  await songs.importSongRecording({ ...input, openingVocalStart: 1.25, openingEnd: 3.8 }, { root, ffmpeg });
  const result = await resolveSong({ title: input.title, artist: input.artist, section: 'chorus' }, { ...options, lookupOnline: false });
  assert.equal(result.song.artist, input.artist);
  assert.notEqual(result.learningSource.path, input.path);
  assert.deepEqual(result.learningSource.chorus, { start: 2, end: 4 });
  assert.deepEqual(result.learningSource.opening, { vocalStart: 1.25, phraseEnd: 3.8 });
});

test('automatic imports can be recalled and evicted without losing manual imports', { skip: !canDecode }, async (t) => {
  const options = { ...await fixture(t), lookupOnline: false };
  const root = options.importRoot;
  const input = { title: '本地曲目', artist: '歌手', path: join(root, 'song.wav') };
  const downloaded = { ...input, title: '下载曲目' };
  await songs.importSongRecording(input, { root, ffmpeg });
  await songs.importSongRecording(downloaded, { root, ffmpeg, keepExisting: true, automatic: true });
  assert.ok((await resolveSong(downloaded, options)).learningSource);

  const { createVoiceCache } = await import('../plugin/src/voice-cache.mjs');
  await createVoiceCache({ root, limitBytes: 1 }).check();
  assert.equal((await resolveSong(downloaded, options)).learningSource, undefined);
  assert.ok((await resolveSong(input, options)).learningSource);
});

test('unspecified local portions use an equal opening/chorus split', { skip: !canDecode }, async (t) => {
  const options = await fixture(t);
  const request = { title: '《小小奇蹟》', artist: 'Zhiwei' };
  const opening = await resolveSong(request, { ...options, random: () => 0.499 });
  assert.equal(opening.section, 'opening');
  assert.deepEqual(inspectAudio(opening), { duration: 1000, firstSample: 1000 });
  const chorus = await resolveSong(request, { ...options, random: () => 0.5 });
  assert.equal(chorus.section, 'chorus');
  assert.deepEqual(inspectAudio(chorus), { duration: 2000, firstSample: 3000 });
});

test('title-only learning prefers a marked female recording and skips a known male recording', { skip: !canDecode }, async (t) => {
  const options = { ...await fixture(t), lookupOnline: false, preferFemale: true };
  const title = '同名曲';
  const root = options.importRoot;
  const path = join(root, 'song.wav');
  await songs.importSongRecording({ title, artist: '男声录音', path, vocal: 'male' }, { root, ffmpeg });
  const onlyMale = await resolveSong({ title }, options);
  assert.equal(onlyMale.learningSource, undefined);
  assert.deepEqual(onlyMale.avoidedArtists, ['男声录音']);

  await songs.importSongRecording({ title, artist: '未标注录音', path }, { root, ffmpeg });
  const unknown = await resolveSong({ title }, options);
  assert.equal(unknown.song.artist, '未标注录音');
  await songs.importSongRecording({ title, artist: '女声录音', path, vocal: 'female' }, { root, ffmpeg });
  const preferred = await resolveSong({ title }, options);
  assert.equal(preferred.song.artist, '女声录音');
  assert.ok(preferred.learningSource.path);
  const explicit = await resolveSong({ title, artist: '男声录音' }, options);
  assert.equal(explicit.song.artist, '男声录音');
  assert.ok(explicit.learningSource.path);
});

test('an indexed first-30-second export is distinct from the existing opening', { skip: !canDecode }, async (t) => {
  const options = await fixture(t, (song) => { song.sections.first30 = { start: 0, end: 4 }; });
  const result = await resolveSong({ title: '小小奇迹', section: '前 ３０ 秒' }, { ...options, lookupOnline: false });
  assert.equal(result.section, 'first30');
  assert.deepEqual(inspectAudio(result), { duration: 4000, firstSample: 1000 });
  assert.match(result.text, /前30秒/);
});

test('offline resolution exposes a validated raw source from a catalog entry without a rendered file', async (t) => {
  const options = await fixture(t, (song) => {
    delete song.file;
    delete song.sections;
    song.source = { file: 'song.wav', sourceStart: 60, chorus: { start: 61, end: 63 } };
  });
  const result = await resolveSong({ title: '小小奇迹', section: 'chorus' }, { ...options, lookupOnline: false });
  assert.deepEqual(result.song, { title: '小小奇迹', artist: '知微' });
  assert.deepEqual(result.learningSource, {
    path: await realpath(join(dirname(options.catalogPath), 'song.wav')),
    sourceStart: 60,
    chorus: { start: 61, end: 63 },
  });
  assert.equal(result.audio, undefined);
});

test('offline resolution excludes unusable source timing without losing the source path', async (t) => {
  const options = await fixture(t, (song) => {
    song.source = { file: 'song.wav', sourceStart: -1, chorus: { start: 3, end: 2 } };
  });
  const result = await resolveSong({ title: '小小奇迹', section: 'first30' }, { ...options, lookupOnline: false });
  assert.deepEqual(result.learningSource, { path: await realpath(join(dirname(options.catalogPath), 'song.wav')) });
  assert.equal(result.audio, undefined);
});

test('an existing raw source outside the catalog root is unavailable', async (t) => {
  const outsideDir = await mkdtemp(join(tmpdir(), 'surfcore-qq-song-outside-'));
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  const outsideFile = join(outsideDir, 'source.wav');
  await writeFile(outsideFile, 'existing outside the catalog');
  const options = await fixture(t);
  await writeFile(options.catalogPath, JSON.stringify([{
    title: '新歌', artist: '原唱', source: { file: relative(dirname(options.catalogPath), outsideFile), sourceStart: 0 },
  }]));
  const result = await resolveSong({ title: '新歌', section: 'first30' }, { ...options, lookupOnline: false });
  assert.equal(result.learningSource, undefined);
  assert.equal(result.song.title, '新歌');
});

test('offline resolution never queries metadata for a song missing from the local catalog', async (t) => {
  const options = await fixture(t);
  let calls = 0;
  const result = await resolveSong({ title: '新歌', section: 'first30' }, {
    ...options, lookupOnline: false, fetchImpl: async () => { calls++; return Response.json({ results: [] }); },
  });
  assert.equal(calls, 0);
  assert.match(result.text, /本地没有找到/);
});

test('an explicit lyric fragment overrides a named section and renders only its indexed line', { skip: !canDecode }, async (t) => {
  const options = await fixture(t);
  const result = await resolveSong({
    title: '小小奇迹', section: 'opening', line: 'shimmering daily moments',
  }, { ...options, random: () => assert.fail('Explicit request should not be randomized') });
  assert.equal(result.section, 'chorus');
  assert.deepEqual(inspectAudio(result), { duration: 1000, firstSample: 4000 });
  assert.deepEqual(result.performance, { title: '小小奇迹', artist: '知微', portion: '指定歌词', start: 3, end: 4,
    lyrics: { status: 'aligned', alignment: 'indexed', truncated: false,
      lines: [{ time: 3, text: 'The stream of shimmering daily moments' }], text: 'The stream of shimmering daily moments' } });
});

test('a prepared audio excerpt reads its sidecar lyrics for only the selected interval', { skip: !canDecode }, async (t) => {
  const options = await fixture(t, (song) => { delete song.lines; });
  await writeFile(join(options.importRoot, 'song.lrc'), '[00:00]Opening lyric\n[00:01]\n[00:02]Chorus lyric\n[00:04]');
  const result = await resolveSong({ title: '小小奇迹', section: 'chorus' }, options);
  assert.deepEqual(inspectAudio(result), { duration: 2000, firstSample: 3000 });
  assert.equal(result.performance.lyrics.status, 'aligned');
  assert.equal(result.performance.lyrics.text, 'Chorus lyric');
  assert.deepEqual(result.performance.lyrics.lines, [{ time: 2, text: 'Chorus lyric' }]);
  assert.doesNotMatch(JSON.stringify(result.performance), /song\.lrc|song\.wav|[A-Z]:[\\/]/);
});

test('a numbered line or a range of numbered lines is cropped to its verified interval', { skip: !canDecode }, async (t) => {
  const options = await fixture(t);
  const first = await resolveSong({ title: '小小奇迹', section: 'chorus', lineNumber: 1 }, options);
  assert.deepEqual(inspectAudio(first), { duration: 1000, firstSample: 3000 });
  const firstTwo = await resolveSong({ title: '小小奇迹', section: 'chorus', lineCount: 2 }, options);
  assert.deepEqual(inspectAudio(firstTwo), { duration: 2000, firstSample: 3000 });
  const missing = await resolveSong({ title: '小小奇迹', section: 'chorus', lineNumber: 3 }, options);
  assert.equal(missing.audio, undefined);
  assert.match(missing.text, /指定段落/);
});

test('a requested lyric or section without a verified interval returns an explicit fallback', async (t) => {
  const options = await fixture(t);
  const missingLine = await resolveSong({ title: '小小奇迹', section: 'chorus', line: 'another song' }, options);
  assert.equal(missingLine.audio, undefined);
  assert.match(missingLine.text, /指定歌词/);
  const missingSection = await resolveSong({ title: '小小奇迹', section: 'bridge' }, options);
  assert.equal(missingSection.audio, undefined);
  assert.match(missingSection.text, /指定段落/);
});

test('a source outside the local catalog directory is unavailable', async (t) => {
  const options = await fixture(t, (song) => { song.file = '../song.wav'; });
  const result = await resolveSong({ title: '小小奇迹', section: 'opening' }, options);
  assert.equal(result.audio, undefined);
  assert.match(result.text, /片段/);
});

test('online lookup sends only bounded title and artist metadata and ignores previews', async (t) => {
  const options = await fixture(t);
  const fetchImpl = async (url, request) => {
    assert.equal(url.origin, 'https://itunes.apple.com');
    assert.equal(url.pathname, '/search');
    assert.equal(url.searchParams.get('term'), '稻香 周杰倫');
    assert.equal(url.searchParams.get('entity'), 'song');
    assert.ok(Number(url.searchParams.get('limit')) <= 10);
    assert.equal(request.redirect, 'error');
    return Response.json({ results: [
      { kind: 'song', trackName: '稻香', artistName: '其他歌手' },
      { kind: 'song', trackName: '稻香 (Live)', artistName: '周杰倫' },
      { kind: 'song', trackName: '稻香', artistName: '周杰倫', trackViewUrl: 'https://music.apple.com/hk/album/rice-field/123?i=456', previewUrl: 'https://example.com/preview' },
    ] });
  };
  const result = await resolveSong({ title: '稻香', artist: '周杰倫', line: 'private lyric', chat: 'private chat' }, { ...options, fetchImpl });
  assert.deepEqual(result.song, { title: '稻香', artist: '周杰倫', url: 'https://music.apple.com/hk/album/rice-field/123?i=456' });
  assert.equal(result.audio, undefined);
  assert.match(result.text, /本地.*片段/);
});

test('online lookup does not claim unrelated results as the requested song', async (t) => {
  const options = await fixture(t);
  const fetchImpl = async () => Response.json({ results: [
    { kind: 'song', trackName: 'Other Track', artistName: 'Another Artist' },
    { kind: 'song', trackName: 'Desired Track', artistName: 'Wrong Artist' },
  ] });
  const result = await resolveSong({ title: 'Desired Track', artist: 'Right Artist' }, { ...options, fetchImpl });
  assert.equal(result.song, undefined);
  assert.match(result.text, /没有找到/);
});

test('a same-title result with a different artist spelling is identified as unconfirmed', async (t) => {
  const options = await fixture(t);
  const fetchImpl = async () => Response.json({ results: [
    { kind: 'song', trackName: '稻香', artistName: '周杰倫' },
    { kind: 'song', trackName: '稻香', artistName: '周杰倫' },
  ] });
  const result = await resolveSong({ title: '稻香', artist: '周杰伦' }, { ...options, fetchImpl });
  assert.equal(result.song, undefined);
  assert.match(result.text, /周杰倫.*无法确认/);
});

test('an aborted song request never starts the online lookup', async (t) => {
  const options = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(resolveSong({ title: '稻香' }, { ...options, signal: controller.signal }), { name: 'AbortError' });
});
