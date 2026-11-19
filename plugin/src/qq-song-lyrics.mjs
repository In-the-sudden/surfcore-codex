import { voiceRoot as defaultVoiceRoot } from './local-installation.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { findQQMusicDownload } from './qq-music-download.mjs';

const maxLyricBytes = 256 * 1024;
const maxAudioBytes = 256 * 1024 * 1024;
const timeTag = /\[(\d{1,4}):([0-5]\d)(?:[.:](\d{1,3}))?\]/gu;
const wordTag = /<\d{1,4}:[0-5]\d(?:[.:]\d{1,3})?>/gu;
const metadataTag = /\[(?:ar|ti|al|by|offset|re|ve|id):[^\]]*\]/giu;
const creditLine = /^(?:作词|作曲|词曲|编曲|编配|词|曲|演唱|原唱|翻唱|歌手|艺人|人声|和声|合声|录音(?:师|室)?|錄音(?:師|室)?|混音(?:师)?|母带(?:工程师)?|制作(?:人|统筹)?|製作(?:人)?|监制|監製|策划|统筹|出品(?:人)?|发行|發行|版权|版权所有|音乐制作|配唱制作人|吉他|贝斯|鼓|钢琴|弦乐|written by|lyrics(?: by)?|compos(?:er|ed by)|arrang(?:er|ed by)|vocal(?:s)?|singer|producer|record(?:ed|ing)(?: by)?|mix(?:ed|ing)(?: by)?|master(?:ed|ing)(?: by)?|copyright)\s*(?:[:：]|\s)\s*\S/iu;
const localPath = /(?:\b[a-z]:[\\/]|\\\\[^\\\s]+\\|file:\/\/|\/(?:[^/\s]+\/)+[^\s]+)/iu;

class Unavailable extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

function contains(root, path) {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep));
}

function localAbsolute(path) {
  return typeof path === 'string' && isAbsolute(path) && !/^[\\/]{2}/u.test(path) && !path.includes('\0');
}

async function trustedFile(path, root, maxBytes, signal) {
  signal?.throwIfAborted();
  if (!localAbsolute(path) || !contains(root, resolve(path))) throw new Unavailable('untrusted-path');
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > BigInt(maxBytes)) {
    throw new Unavailable('invalid-file');
  }
  const canonical = await realpath(path);
  signal?.throwIfAborted();
  if (!localAbsolute(canonical) || !contains(root, canonical)) throw new Unavailable('untrusted-path');
  return { path: canonical, signature: [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':') };
}

async function audioHash(path, root, signal) {
  const before = await trustedFile(path, root, maxAudioBytes, signal);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(before.path, { signal })) {
    signal?.throwIfAborted();
    digest.update(chunk);
  }
  const after = await trustedFile(path, root, maxAudioBytes, signal);
  if (before.signature !== after.signature) throw new Unavailable('source-changed');
  return digest.digest('hex');
}

function decodeLyrics(bytes) {
  let encoding;
  let body = bytes;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    encoding = 'utf-8'; body = bytes.subarray(3);
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le'; body = bytes.subarray(2);
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be'; body = bytes.subarray(2);
  }
  let text;
  try {
    if (encoding) text = new TextDecoder(encoding, { fatal: true }).decode(body);
    else {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); encoding = 'utf-8'; }
      catch { text = new TextDecoder('gb18030', { fatal: true }).decode(body); encoding = 'gb18030'; }
    }
  } catch { throw new Unavailable('invalid-encoding'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(text)) throw new Unavailable('invalid-encoding');
  return { text, encoding };
}

const textKey = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function lyricText(value, title, artist, timed) {
  const text = value.replace(wordTag, '').replace(metadataTag, '').trim();
  if (!text || creditLine.test(text) || localPath.test(text) || /https?:\/\/|www\./iu.test(text)) return '';
  const key = textKey(text), titleKey = textKey(title), artistKey = textKey(artist);
  if ((!timed && ((titleKey && key === titleKey) || (artistKey && key === artistKey))) ||
      (titleKey && artistKey && [titleKey + artistKey, artistKey + titleKey].includes(key))) return '';
  return text;
}

function parseLyrics(text, title, artist) {
  const offset = [...text.matchAll(/\[offset:\s*([+-]?\d+)\s*\]/giu)].at(-1);
  const offsetMs = offset ? Number(offset[1]) : 0;
  if (!Number.isSafeInteger(offsetMs)) throw new Unavailable('invalid-timing');
  const timed = [], untimed = [];
  for (const raw of text.split(/\r?\n|\r/u)) {
    const tags = [...raw.matchAll(timeTag)];
    const body = lyricText(raw.replace(timeTag, ''), title, artist, tags.length > 0);
    if (tags.length) {
      for (const tag of tags) {
        const time = Number(tag[1]) * 60 + Number(tag[2]) + Number('0.' + (tag[3] || '0')) - offsetMs / 1000;
        timed.push({ time: Math.round(time * 1000) / 1000, text: body });
      }
    } else if (body && !/^\[[^\]]*\]$/u.test(body)) untimed.push(body);
  }
  timed.sort((a, b) => a.time - b.time);
  return { timed, untimed, offsetMs };
}

function selectedLyrics(parsed, range) {
  const timestamps = [...new Set(parsed.timed.map(({ time }) => time))];
  const nextTimes = new Map(timestamps.map((time, index) => [time, timestamps[index + 1]]));
  const selected = [], seen = new Set();
  let uncertainLastLine = false;
  for (const line of parsed.timed) {
    const next = nextTimes.get(line.time);
    if (!line.text || line.time >= range.end || (next ?? range.end) <= range.start) continue;
    const key = line.time + '\0' + line.text;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(line);
    if (next === undefined) uncertainLastLine = true;
  }
  const lines = [];
  let length = 0, truncated = false;
  for (const line of selected) {
    const remaining = 1600 - length - (lines.length ? 1 : 0);
    if (lines.length >= 24 || remaining <= 0) { truncated = true; break; }
    const text = line.text.slice(0, remaining);
    lines.push({ time: line.time, text });
    length += text.length + (lines.length > 1 ? 1 : 0);
    if (text.length < line.text.length) { truncated = true; break; }
  }
  return { lines, text: lines.map(({ text }) => text).join('\n'), uncertainLastLine, truncated };
}

async function loadFile(path, root, signal) {
  const before = await trustedFile(path, root, maxLyricBytes, signal);
  const bytes = await readFile(before.path, { signal });
  const after = await trustedFile(path, root, maxLyricBytes, signal);
  if (bytes.length > maxLyricBytes || before.signature !== after.signature) throw new Unavailable('lyrics-changed');
  return { bytes, ...decodeLyrics(bytes) };
}

async function cacheLyrics(root, hash, bytes, signal) {
  let directory = root;
  for (const part of ['qq-song-lyrics', hash]) {
    directory = join(directory, part);
    await mkdir(directory).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !contains(root, await realpath(directory))) {
      throw new Unavailable('untrusted-path');
    }
  }
  const temporary = join(directory, 'lyrics-' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, bytes, { flag: 'wx', signal });
    signal?.throwIfAborted();
    await rename(temporary, join(directory, 'lyrics.lrc'));
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

function unavailable(reason) {
  return { status: 'unavailable', text: '', lines: [], reason,
    note: '未获取到可用歌词，不能确认片段唱出的歌词。' };
}

// start/end are clip-relative; callers with absolute source times must leave sourceStart at zero.
export async function readSongLyrics({ sourcePath, lyricPath, title, artist, start, end, sourceStart = 0,
  voiceRoot = defaultVoiceRoot, signal } = {}) {
  signal?.throwIfAborted();
  try {
    if (![start, end, sourceStart].every(Number.isFinite) || start < 0 || end <= start || sourceStart < 0) {
      return unavailable('invalid-range');
    }
    if (!localAbsolute(voiceRoot)) return unavailable('untrusted-path');
    const root = await realpath(voiceRoot);
    const hash = await audioHash(sourcePath, root, signal);
    const candidates = [
      ...(lyricPath ? [{ path: lyricPath, source: 'explicit' }] : []),
      { path: join(root, 'qq-song-lyrics', hash, 'lyrics.lrc'), source: 'cache' },
      { path: sourcePath.slice(0, -extname(sourcePath).length) + '.lrc', source: 'sidecar' },
    ];
    let loaded, source;
    for (const candidate of candidates) {
      try { loaded = await loadFile(candidate.path, root, signal); source = candidate.source; break; }
      catch (error) { signal?.throwIfAborted(); if (error.code !== 'ENOENT') throw error; }
    }
    if (!loaded && title && artist) {
      const download = await findQQMusicDownload({ directory: join(root, 'qqmusic'), title, artist })
        .catch((error) => { if (error.code === 'ENOENT') return undefined; throw error; });
      signal?.throwIfAborted();
      if (download?.lyricPath) {
        if (await audioHash(download.path, root, signal) !== hash) return unavailable('recording-mismatch');
        loaded = await loadFile(download.lyricPath, root, signal);
        source = 'qqmusic';
      }
    }
    if (!loaded) return unavailable('missing-lyrics');
    const parsed = parseLyrics(loaded.text, title, artist);
    if (!parsed.timed.some(({ text }) => text) && !parsed.untimed.length) return unavailable('empty-lyrics');
    if (source !== 'cache') {
      try { await cacheLyrics(root, hash, loaded.bytes, signal); }
      catch { signal?.throwIfAborted(); }
    }
    const range = { start: start + sourceStart, end: end + sourceStart };
    const metadata = { source, encoding: loaded.encoding, sourceSha256: hash, offsetMs: parsed.offsetMs, range };
    let result;
    if (parsed.timed.length) {
      const selection = selectedLyrics(parsed, range);
      if (!selection.lines.length) return unavailable('no-overlap');
      result = { status: 'aligned', ...metadata, ...selection, alignment: 'timestamp-only',
        note: '歌词按 LRC 时间区间对应，未逐词确认实际演唱内容。' +
          (selection.uncertainLastLine ? '末行没有下一时间点，仅可能对应片段剩余部分。' : '') };
    } else {
      const fullText = parsed.untimed.join('\n');
      if (!fullText) return unavailable('empty-lyrics');
      result = { status: 'untimed', ...metadata, text: fullText.slice(0, 1600), lines: [],
        truncated: fullText.length > 1600, alignment: 'unconfirmed',
        note: '歌词没有可用时间轴，仅作为全曲参考，不能确认片段唱出的词。' };
    }
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    return unavailable(error instanceof Unavailable ? error.reason : 'lyrics-unavailable');
  }
}
