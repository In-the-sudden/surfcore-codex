import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
const QQ_MUSIC_CONVERTER = process.env.SURFCORE_QQ_MUSIC_CONVERTER;
const MAX_AUDIO_BYTES = 256 * 1024 * 1024;
const AUDIO_DEMUXERS = new Map([
  ['.ogg', 'ogg'],
  ['.mp3', 'mp3'],
  ['.flac', 'flac'],
  ['.wav', 'wav'],
  ['.m4a', 'mov'],
  ['.opus', 'ogg'],
  ['.aac', 'aac'],
]);

function isLocalPath(path) {
  return typeof path === 'string' && isAbsolute(path) && !/^[\\/]{2}/u.test(path);
}

async function localAudioPath(path) {
  if (!isLocalPath(path)) throw new Error('QQ 音乐下载文件必须是本机绝对路径。');
  const file = await realpath(path);
  if (!isLocalPath(file)) throw new Error('QQ 音乐下载文件必须位于本机。');
  const info = await stat(file);
  if (!info.isFile() || !info.size || info.size > MAX_AUDIO_BYTES) {
    throw new Error('QQ 音乐下载文件为空、超出 256 MB 或不在本机。');
  }
  return file;
}

async function runChecked(program, args, { cwd, signal, errorMessage }) {
  signal?.throwIfAborted();
  try {
    await new Promise((resolve, reject) => {
      execFile(program, args, {
        cwd, signal, timeout: 60_000, maxBuffer: 256 * 1024, windowsHide: true,
      }, (error) => error ? reject(error) : resolve());
    });
  } catch (cause) {
    signal?.throwIfAborted();
    throw new Error(errorMessage, { cause });
  }
  signal?.throwIfAborted();
}

async function createStaging(workDirectory) {
  if (!isLocalPath(workDirectory)) throw new Error('QQ 音乐转换需要本机任务目录。');
  const parent = await realpath(workDirectory);
  if (!isLocalPath(parent)) throw new Error('QQ 音乐转换需要本机任务目录。');
  return mkdtemp(join(parent, 'qq-music-'));
}

async function convertMgg(file, { workDirectory, signal, um }) {
  if (!um) throw new Error('请配置 QQ 音乐转换程序或手动导入可播放音频。');
  const staging = await createStaging(workDirectory);
  await runChecked(um, ['-i', file, '-o', staging], {
    cwd: staging, signal,
    errorMessage: 'QQ 音乐这份 MGG 下载无法使用本机转换工具转换。',
  });
  const entries = await readdir(staging, { withFileTypes: true });
  const audio = entries.filter((entry) =>
    entry.isFile() && AUDIO_DEMUXERS.has(extname(entry.name).toLowerCase()));
  if (audio.length !== 1) throw new Error('QQ 音乐转换结果应包含一份可播放音频。');

  const output = await localAudioPath(join(staging, audio[0].name));
  if (dirname(output) !== staging) throw new Error('QQ 音乐转换音频不在本次任务目录。');
  return output;
}

function trailingQQTagStart(tail) {
  const id3 = tail.length - 128;
  const footer = id3 - 32;
  if (footer < 32 || tail.toString('ascii', id3, id3 + 3) !== 'TAG' ||
      tail.toString('ascii', footer, footer + 8) !== 'APETAGEX') return;

  const tagSize = tail.readUInt32LE(footer + 12);
  const entries = tail.readUInt32LE(footer + 16);
  const header = id3 - tagSize - 32;
  if (header < 0 || tagSize < 32 || entries < 1 || entries > (tagSize - 32) / 11 ||
      tail.readUInt32LE(footer + 8) !== 2000 ||
      tail.readUInt32LE(footer + 20) !== 0x80000000 ||
      tail.readBigUInt64LE(footer + 24) !== 0n ||
      !tail.subarray(header, header + 20).equals(tail.subarray(footer, footer + 20)) ||
      tail.readUInt32LE(header + 20) !== 0xa0000000 ||
      tail.readBigUInt64LE(header + 24) !== 0n) return;

  let item = header + 32;
  for (let index = 0; index < entries; index++) {
    if (item + 11 > footer) return;
    const valueSize = tail.readUInt32LE(item);
    const flags = tail.readUInt32LE(item + 4);
    const key = tail.subarray(item + 8, Math.min(footer, item + 8 + 256));
    const keyLength = key.indexOf(0);
    if (flags > 5 || keyLength < 2 || key.subarray(0, keyLength).some((byte) => byte < 0x20 || byte > 0x7e)) return;
    item += 8 + keyLength + 1 + valueSize;
  }
  if (item === footer) return header;
}

async function copyMp3WithoutQQTags(audio, { workDirectory, signal }) {
  const source = await open(audio, 'r');
  let end;
  try {
    const { size } = await source.stat();
    const tail = Buffer.alloc(Math.min(size, 1024 * 1024));
    const offset = size - tail.length;
    const { bytesRead } = await source.read(tail, 0, tail.length, offset);
    if (bytesRead !== tail.length) return;
    const start = trailingQQTagStart(tail);
    if (start === undefined || offset + start === 0) return;
    end = offset + start;
  } finally {
    await source.close();
  }

  signal?.throwIfAborted();
  const path = join(await createStaging(workDirectory), 'audio.mp3');
  await pipeline(createReadStream(audio, { end: end - 1 }), createWriteStream(path, { flags: 'wx' }), { signal });
  return path;
}

function decodeAudio(audio, demuxer, ffmpeg, signal) {
  return runChecked(ffmpeg, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror',
    '-abort_on', 'empty_output_stream', '-format_whitelist', demuxer, '-protocol_whitelist', 'file,pipe',
    '-i', audio, '-map', '0:a:0', '-f', 'null', '-',
  ], { signal, errorMessage: 'QQ 音乐下载的音频未通过完整解码校验。' });
}

export async function convertQQMusicDownload({
  path,
  workDirectory,
  signal,
  um = QQ_MUSIC_CONVERTER,
  ffmpeg = process.env.SURFCORE_FFMPEG || 'ffmpeg',
} = {}) {
  signal?.throwIfAborted();
  const source = await localAudioPath(path);
  let audio = extname(source).toLowerCase() === '.mgg'
    ? await convertMgg(source, { workDirectory, signal, um }) : source;
  const extension = extname(audio).toLowerCase();
  const demuxer = AUDIO_DEMUXERS.get(extension);
  if (!demuxer) throw new Error('QQ 音乐下载的文件格式暂不支持。');

  try {
    await decodeAudio(audio, demuxer, ffmpeg, signal);
  } catch (error) {
    signal?.throwIfAborted();
    // Some QQ Music MP3s cause FFmpeg to read trailing APEv2 and ID3v1 tags as audio.
    if (extension !== '.mp3' || !isLocalPath(workDirectory) || !error.cause?.message.includes('Header missing')) throw error;
    const stripped = await copyMp3WithoutQQTags(audio, { workDirectory, signal });
    if (!stripped) throw error;
    await decodeAudio(stripped, demuxer, ffmpeg, signal);
    audio = stripped;
  }
  return { path: audio, format: extension.slice(1) };
}
