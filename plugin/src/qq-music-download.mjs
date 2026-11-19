import { lstat, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const audioExtensions = new Set(['.mgg', '.ogg', '.mp3', '.flac', '.wav', '.m4a', '.opus', '.aac']);
const lyricExtension = '.lrc';
const maxAudioBytes = 256 * 1024 * 1024;

function extension(path) {
  return extname(path).toLowerCase();
}

function displayName(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : '';
}

function nameKey(value) {
  return displayName(value).toLowerCase();
}

function artistName(value) {
  return displayName(value).replace(/^『(.+)』$|^「(.+)」$/u, '$1$2').trim();
}

function artistKey(value) {
  return artistName(value).toLowerCase()
    .split(/\s*,\s*|\s+_\s+/u).map((artist) => artist.trim()).join(',');
}

function matchesTitle(candidate, title) {
  if (candidate === title) return true;
  const versionSpacing = (value) => value.replace(/\s*\(\s*/gu, '(').replace(/\s*\)/gu, ')');
  if (versionSpacing(candidate) === versionSpacing(title)) return true;
  const suffix = candidate.startsWith(title + ' ') && candidate.slice(title.length).match(/^ \(([^()]+)\)$/u)?.[1];
  const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
  return Boolean(suffix && kana.test(title) && !kana.test(suffix) && /\p{Script=Han}/u.test(suffix)
    && !/(?:版|现场|現場|演唱会|演唱會|演奏|伴奏|翻唱|改编|改編|重制|重製|重录|重錄|录音|錄音|混音|纯音乐|純音樂|原声|原聲|剪辑|剪輯)/u.test(suffix));
}

function recordingArtist(name, title, artist) {
  const stem = displayName(name.slice(0, -extname(name).length));
  for (let end = stem.indexOf(' - '); end !== -1; end = stem.indexOf(' - ', end + 3)) {
    const label = stem.slice(end + 3);
    const candidate = artistKey(label);
    if (candidate && (!artist || candidate === artist) && matchesTitle(nameKey(stem.slice(0, end)), title)) {
      return artistName(label).replace(/\s+_\s+/gu, ', ');
    }
  }
}

async function readDownloadFolder(folder, { optional = false } = {}) {
  const directory = await lstat(folder).catch((error) => {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!directory?.isDirectory()) {
    if (optional) return [];
    throw new Error('找不到 QQ 音乐下载目录。');
  }
  const files = await readdir(folder, { withFileTypes: true });
  const candidates = files.filter((file) => file.isFile()
    && (audioExtensions.has(extension(file.name)) || extension(file.name) === lyricExtension));
  return (await Promise.all(candidates.map(async ({ name }) => {
    const path = join(folder, name);
    const info = await lstat(path, { bigint: true }).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info?.isFile()) return null;
    return { name, path, size: Number(info.size), signature: [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':') };
  }))).filter(Boolean);
}

export async function snapshotQQMusicDownloads(directory) {
  const root = resolve(directory);
  const files = await Promise.all([readDownloadFolder(root), readDownloadFolder(join(root, 'VipSongsDownload'), { optional: true })]);
  return new Map(files.flat().map((file) => [file.path, file]));
}

export async function findQQMusicDownload({ directory, title, artist, allowAnyArtist = false }) {
  const targetTitle = nameKey(title);
  const targetArtist = artistKey(artist);
  if (!targetTitle || (!targetArtist && !allowAnyArtist)) return undefined;
  const files = await snapshotQQMusicDownloads(directory);
  let path, matchedArtist;
  for (const file of files.values()) {
    if (!audioExtensions.has(extension(file.name)) || file.size <= 0 || file.size > maxAudioBytes) continue;
    const candidate = recordingArtist(file.name, targetTitle, targetArtist);
    if (!candidate) continue;
    if (path) return undefined;
    path = file.path;
    matchedArtist = candidate;
  }
  if (!path) return undefined;
  const stem = path.slice(0, -extname(path).length);
  const lyrics = [...files.values()].filter((file) => extension(file.name) === lyricExtension &&
    file.path.slice(0, -extname(file.path).length) === stem && file.size > 0);
  return { path, lyricPath: lyrics.length === 1 ? lyrics[0].path : undefined,
    ...(!targetArtist && { artist: matchedArtist }) };
}

export async function waitForQQMusicDownload({
  directory, before, title, artist, signal, timeoutMs = 90_000, pollMs = 500, settleMs = 2_000,
} = {}) {
  const targetTitle = nameKey(title);
  const targetArtist = artistKey(artist);
  if (!(before instanceof Map) || !targetTitle || !targetArtist) throw new Error('请提供下载前快照和选定的歌名、歌手。');
  if (![timeoutMs, pollMs, settleMs].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('QQ 音乐下载等待时间无效。');
  }
  const deadline = performance.now() + timeoutMs;
  let previous, unchangedSince;
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    const files = await snapshotQQMusicDownloads(directory);
    signal?.throwIfAborted();
    const isNew = (file) => before.get(file.path)?.signature !== file.signature;
    const matches = [...files.values()].filter((file) => audioExtensions.has(extension(file.name))
      && recordingArtist(file.name, targetTitle, targetArtist) && isNew(file));
    if (matches.length > 1) throw new Error('发现多份匹配的 QQ 音乐新下载，无法确认录音版本。');
    const file = matches[0];
    const now = performance.now();
    if (file?.size > maxAudioBytes) throw new Error('QQ 音乐下载超过 256 MB。');
    if (file?.size > 0) {
      if (file.path !== previous?.path || file.signature !== previous?.signature) unchangedSince = now;
      if (now < deadline && now - unchangedSince >= settleMs) {
        const stem = file.path.slice(0, -extname(file.path).length);
        const lyrics = [...files.values()].filter((item) => extension(item.name) === lyricExtension
          && item.path.slice(0, -extname(item.path).length) === stem && item.size > 0 && isNew(item));
        return { path: file.path, lyricPath: lyrics.length === 1 ? lyrics[0].path : undefined };
      }
    }
    previous = file?.size > 0 ? file : undefined;
    if (now < deadline) await delay(Math.min(pollMs, deadline - now), undefined, { signal });
  }
  signal?.throwIfAborted();
  throw new Error('等待匹配的 QQ 音乐下载完成超时。');
}
