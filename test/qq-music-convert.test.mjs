import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { convertQQMusicDownload as convert } from '../plugin/src/qq-music-convert.mjs';

const ffmpeg = process.env.SURFCORE_FFMPEG || 'ffmpeg';

function wav() {
  const data = Buffer.alloc(44 + 1600);
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

async function fixture(t, filename, contents) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, 'surfcore-qq-music-convert-'));
  t.after(async () => {
    const target = await realpath(root);
    if (dirname(target) === parent && basename(target).startsWith('surfcore-qq-music-convert-')) {
      await rm(target, { recursive: true, force: true });
    }
  });
  const path = join(root, filename);
  await writeFile(path, contents);
  return { path, root };
}

test('playable downloads are decoded and returned in place', async (t) => {
  const contents = wav();
  const { path } = await fixture(t, '歌名 - 歌手.wav', contents);
  const result = await convert({ path, ffmpeg });
  assert.deepEqual(result, { path: await realpath(path), format: 'wav' });
  assert.deepEqual(await readFile(path), contents);
});

test('the decoder rejects a download whose audio data is truncated after a valid header', async (t) => {
  const contents = wav().subarray(0, 845);
  const { path } = await fixture(t, 'truncated.wav', contents);
  await assert.rejects(convert({ path, ffmpeg }), /解码/);
  assert.deepEqual(await readFile(path), contents);
});

test('the converter receives just the requested .mgg and publishes audio inside fresh staging', async (t) => {
  const contents = Buffer.from('source MGG fixture');
  const { path, root } = await fixture(t, '歌名 - 歌手.mgg', contents);
  const sibling = join(root, 'existing.wav');
  await writeFile(sibling, contents);
  const um = join(root, 'fixture-converter.exe');
  const actualExec = childProcess.execFile;
  const stub = t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
    if (command !== um) return actualExec(command, args, options, callback);
    const out = args[3];
    assert.deepEqual(args, ['-i', path, '-o', out]);
    assert.notEqual(out, root);
    assert.equal(dirname(out), root);
    assert.ok(options.timeout < 120_000);
    writeFile(join(out, '歌名 - 歌手.wav'), wav()).then(() => callback(null, '', ''), callback);
  });
  syncBuiltinESMExports();
  try {
    const result = await convert({ path, workDirectory: root, ffmpeg, um });
    assert.equal(result.format, 'wav');
    assert.equal(dirname(dirname(result.path)), root);
    assert.deepEqual(await readdir(dirname(result.path)), ['歌名 - 歌手.wav']);
    assert.deepEqual(await readFile(result.path), wav());
    assert.deepEqual(await readFile(path), contents);
    assert.deepEqual(await readFile(sibling), contents);
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
  }
});

async function encodeMp3(t) {
  const { path, root } = await fixture(t, 'fixture.wav', wav());
  const output = join(root, 'fixture.mp3');
  const result = childProcess.spawnSync(ffmpeg, [
    '-nostdin', '-v', 'error', '-i', path, '-c:a', 'libmp3lame', '-write_xing', '0', output,
  ], { windowsHide: true });
  assert.equal(result.status, 0, result.stderr?.toString());
  return { root, bytes: await readFile(output) };
}

function appendQQTags(audio) {
  const tagItem = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 0]), Buffer.from('Title\0Sample')]);
  const footer = Buffer.alloc(32);
  footer.write('APETAGEX');
  footer.writeUInt32LE(2000, 8);
  footer.writeUInt32LE(tagItem.length + 32, 12);
  footer.writeUInt32LE(1, 16);
  footer.writeUInt32LE(0x80000000, 20);
  const header = Buffer.from(footer);
  header.writeUInt32LE(0xa0000000, 20);
  const id3 = Buffer.alloc(128);
  id3.write('TAG');
  id3.write('Sample', 3);
  return Buffer.concat([audio, header, tagItem, footer, id3]);
}

function simulateUnrecognizedTrailingTags(t, originalPath) {
  const actualExec = childProcess.execFile;
  const stub = t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
    if (args[args.indexOf('-i') + 1] !== originalPath) return actualExec(command, args, options, callback);
    queueMicrotask(() => callback(new Error('mp3float: Header missing')));
  });
  syncBuiltinESMExports();
  t.after(() => {
    stub.mock.restore();
    syncBuiltinESMExports();
  });
}

test('recovers a strict MP3 decode by copying just the audio and initial metadata of a QQ download', async (t) => {
  const { root, bytes } = await encodeMp3(t);
  const path = join(root, 'qq-download.mp3');
  const original = appendQQTags(bytes);
  await writeFile(path, original);
  simulateUnrecognizedTrailingTags(t, path);
  const result = await convert({ path, workDirectory: root, ffmpeg });
  assert.notEqual(result.path, path);
  assert.equal(result.format, 'mp3');
  assert.deepEqual(await readFile(result.path), bytes);
  assert.deepEqual(await readFile(path), original);
});

test('rejects unknown trailing data when APE item lengths do not account for the entire tag', async (t) => {
  const { root, bytes } = await encodeMp3(t);
  const path = join(root, 'malformed-ape.mp3');
  const original = appendQQTags(bytes);
  original.writeUInt32LE(7, bytes.length + 32);
  await writeFile(path, original);
  simulateUnrecognizedTrailingTags(t, path);
  await assert.rejects(convert({ path, workDirectory: root, ffmpeg }), /解码/);
});

test('rejects a tagged MP3 whose remaining payload does not decode', async (t) => {
  const { path, root } = await fixture(t, 'invalid.mp3', appendQQTags(Buffer.alloc(1024)));
  simulateUnrecognizedTrailingTags(t, path);
  await assert.rejects(convert({ path, workDirectory: root, ffmpeg }), /解码/);
});
