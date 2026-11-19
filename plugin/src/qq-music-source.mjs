import { voiceRoot as VOICE_ROOT } from './local-installation.mjs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { convertQQMusicDownload } from './qq-music-convert.mjs';
import { findQQMusicDownload, snapshotQQMusicDownloads, waitForQQMusicDownload } from './qq-music-download.mjs';
import { hasSongVersion, importSongRecording, matchesSongArtist, resolveSong } from './qq-song.mjs';
import { probeSongDuration } from './qq-song-learn.mjs';

const run = promisify(execFile);
const QQ_MUSIC = process.env.SURFCORE_QQ_MUSIC_EXE;
const DESKTOP_SOURCE = fileURLToPath(new URL('./qq-music-desktop.cs', import.meta.url));
let active = false;

function userError(userMessage, { phase, cause } = {}) {
  return Object.assign(new Error(userMessage, { cause }), { userMessage, ...(phase && { phase }) });
}

const encode = (value) => Buffer.from(value || '', 'utf8').toString('base64');

async function getDesktopHelper(directory, signal) {
  const source = await readFile(DESKTOP_SOURCE, { signal });
  const version = createHash('sha256').update(source).digest('hex');
  const runtime = join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const executable = join(directory, 'desktop-' + version + '.exe');
  if (await access(executable).then(() => true, () => false)) return executable;
  const build = await mkdtemp(join(directory, 'build-'));
  try {
    const output = join(build, 'desktop.exe');
    await run(join(runtime, 'csc.exe'), [
      '/nologo', '/target:exe', '/platform:x64', '/codepage:65001', '/out:' + output,
      '/r:' + join(runtime, 'WPF', 'UIAutomationClient.dll'),
      '/r:' + join(runtime, 'WPF', 'UIAutomationTypes.dll'),
      '/r:' + join(runtime, 'WPF', 'WindowsBase.dll'),
      '/r:System.Web.Extensions.dll', DESKTOP_SOURCE,
    ], { signal, timeout: 30_000, windowsHide: true, maxBuffer: 64 * 1024 });
    signal?.throwIfAborted();
    await rename(output, executable);
    return executable;
  } finally {
    await rm(build, { recursive: true, force: true });
  }
}

async function downloadWithDesktop({ title, artist }, { workspace, signal, avoidedArtists }) {
  try {
    const helper = await getDesktopHelper(workspace, signal);
    const { stdout } = await run(helper, [encode(title), encode(artist), encode(JSON.stringify(avoidedArtists))], {
      signal, timeout: 55_000, windowsHide: true, maxBuffer: 16 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 2) {
      const reason = error.stderr?.trim().slice(0, 130);
      if (reason) throw userError(reason, { phase: 'qq-music-desktop', cause: error });
    }
    throw userError('QQ 音乐未能开始下载，请检查客户端窗口、登录状态和该录音的下载权限。',
      { phase: 'qq-music-desktop', cause: error });
  }
}

export function createQQMusicSource({
  voiceRoot = VOICE_ROOT,
  downloadDirectory = join(voiceRoot, 'qqmusic'),
  startDownload = downloadWithDesktop,
  desktopAvailable = async () => true,
  snapshot = snapshotQQMusicDownloads,
  findDownload = findQQMusicDownload,
  waitForDownload = waitForQQMusicDownload,
  convert = convertQQMusicDownload,
  importRecording = importSongRecording,
  resolveRecording = resolveSong,
} = {}) {
  return async function acquire({ title, artist }, { signal, avoidedArtists = [] } = {}) {
    signal?.throwIfAborted();
    if (active) throw userError('QQ 音乐正在下载另一首歌，请稍后再试。');
    // A single interactive QQ Music window and one download directory are shared by all jobs.
    active = true;
    try {
      const request = { title, artist };
      const preferFemale = !artist && !hasSongVersion(title);
      if (!preferFemale) avoidedArtists = [];
      const library = { signal, importRoot: voiceRoot, catalogPath: join(voiceRoot, 'qq-songs.json'), lookupOnline: false, preferFemale };
      if (artist) {
        const existing = await resolveRecording(request, library);
        if (existing.learningSource) return { ...existing.song, source: existing.learningSource };
        if (existing.needsArtist) throw userError(existing.text);
      }
      let downloaded = artist || !preferFemale ? await findDownload({ directory: downloadDirectory, title, artist,
        ...(!artist && { allowAnyArtist: true }),
      }).catch(() => undefined) : undefined;
      if (!downloaded && !(await desktopAvailable())) return undefined;
      signal?.throwIfAborted();
      const workspace = resolve(voiceRoot, 'qq-music-automation');
      await mkdir(workspace, { recursive: true });
      const acquisitionDeadline = AbortSignal.timeout(120_000);
      const acquisition = signal ? AbortSignal.any([signal, acquisitionDeadline]) : acquisitionDeadline;
      let names = downloaded?.artist ? { title, artist: downloaded.artist } : request;
      let expectedDuration;
      let before;
      if (!downloaded) {
        before = await snapshot(downloadDirectory).catch((cause) => {
          throw userError('找不到 QQ 音乐的下载目录，请检查客户端的下载设置。', { phase: 'qq-music-download', cause });
        });
        const selected = await startDownload(request, { workspace, signal: acquisition, avoidedArtists });
        if (typeof selected?.title !== 'string' || typeof selected?.artist !== 'string' ||
            !selected.title.trim() || !selected.artist.trim() ||
            (artist && !matchesSongArtist(selected.artist, [artist])) ||
            (!artist && matchesSongArtist(selected.artist, avoidedArtists))) {
          throw userError('QQ 音乐没有找到能确认版本的下载结果，可以点名歌手。');
        }
        names = { title: selected.title, artist: selected.artist };
        expectedDuration = selected.durationSeconds;
      }
      const libraryKey = { title, artist: names.artist };
      let previous = await resolveRecording(libraryKey, library);
      if (!previous.learningSource && names.title !== title) previous = await resolveRecording(names, library);
      if (previous.learningSource) return { ...names, source: previous.learningSource };
      if (!downloaded) {
        const existing = await findDownload({ directory: downloadDirectory, ...names });
        if (existing && before.has(existing.path)) {
          const current = await snapshot(downloadDirectory);
          // An unchanged selected recording may already be downloaded; growing files still need to settle.
          if (current.get(existing.path)?.signature === before.get(existing.path).signature) downloaded = existing;
        }
      }
      if (!downloaded) {
        try { downloaded = await waitForDownload({ directory: downloadDirectory, before, ...names, signal: acquisition }); }
        catch (error) {
          signal?.throwIfAborted();
          const detail = { phase: 'qq-music-download', cause: error };
          if (/^发现多份匹配的/u.test(error.message)) throw userError('QQ 音乐出现多份同名下载，无法确认录音版本。', detail);
          throw userError('未找到这首歌的已完成下载，请检查 QQ 音乐的下载状态。', detail);
        }
      }
      const job = await mkdtemp(join(workspace, 'download-'));
      try {
        let playable;
        try { playable = await convert({ path: downloaded.path, workDirectory: job, signal }); }
        catch (error) {
          signal?.throwIfAborted();
          throw userError('QQ 音乐已下载这份录音，但音频转换或完整解码校验失败。',
            { phase: 'qq-music-conversion', cause: error });
        }
        signal?.throwIfAborted();
        if (Number.isFinite(expectedDuration)) {
          const duration = await probeSongDuration(playable.path, { signal });
          if (Math.abs(duration - expectedDuration) > 2) {
            throw userError('QQ 音乐下载的音频时长和所选版本不符，请检查下载是否完整。', { phase: 'qq-music-validation' });
          }
        }
        await importRecording({ ...libraryKey, path: playable.path }, { root: voiceRoot, signal, keepExisting: true, automatic: true });
        const imported = await resolveRecording(libraryKey, library);
        if (!imported.learningSource) throw userError('QQ 音乐录音已下载，但曲库暂未读回该版本。');
        return { ...names, source: { ...imported.learningSource, ...(downloaded.lyricPath && { lyricPath: downloaded.lyricPath }) } };
      } finally {
        await rm(job, { recursive: true, force: true });
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw userError('QQ 音乐未在限定时间内完成下载。', { phase: 'qq-music-download', cause: error });
      }
      throw error;
    } finally {
      active = false;
    }
  };
}

const acquire = createQQMusicSource({
  desktopAvailable: async () => process.platform === 'win32' && Boolean(QQ_MUSIC) && await access(QQ_MUSIC).then(() => true, () => false),
});
export async function acquireQQMusic(request, options) {
  if (process.env.SURFCORE_QQ_MUSIC === 'off') return undefined;
  return acquire(request, options);
}
