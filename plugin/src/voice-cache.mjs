import { voiceRoot } from './local-installation.mjs';
import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { snapshotQQMusicDownloads } from './qq-music-download.mjs';

export const SONG_DOWNLOAD_CACHE = 'qq-song-downloads';
const hash = /^[a-f0-9]{64}$/u;
const cachedSource = /^source\.(?:ogg|mp3|wav|flac|m4a|opus|aac)$/u;
const indexFile = /^[a-f0-9]{64}\.json$/u;
const temporaryVoiceAgeMs = 30 * 60_000;
const voiceId = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const voiceUpload = new RegExp('^(?:snowluma-ptt-in-' + voiceId + '|snowluma-ptt-wave-' + voiceId + '\\.wav|' + voiceId + ')$', 'u');
const voiceTranscode = /^[a-f0-9]{16}\.(?:in|mp3|amr|wma|m4a|spx|ogg|wav|flac)$/u;

function optional(error) {
  if (error.code === 'ENOENT') return null;
  throw error;
}

async function entries(directory) {
  const info = await lstat(directory).catch(optional);
  return info?.isDirectory() ? await readdir(directory, { withFileTypes: true }).catch(optional) ?? [] : [];
}

async function collect(directory, files, pattern, subdirectories = () => undefined) {
  for (const entry of await entries(directory)) {
    const path = join(directory, entry.name);
    if (entry.isFile() && pattern?.test(entry.name)) files.push(path);
    if (entry.isDirectory()) {
      const rule = subdirectories(entry.name);
      if (rule) await collect(path, files, ...rule);
    }
  }
}

async function collectSongs(directory, paths) {
  const downloadDirectory = join(directory, 'qqmusic');
  const downloadInfo = await lstat(downloadDirectory).catch(optional);
  const downloads = downloadInfo?.isDirectory() ? await snapshotQQMusicDownloads(downloadDirectory).catch(optional) : null;
  for (const path of downloads?.keys() ?? []) paths.push(path);
  await collect(join(directory, 'qq-song-learned'), paths, /^[a-f0-9]{64}\.wav$/u, (name) =>
    name === 'sources' ? [null, (child) => hash.test(child) ? [/^source\.(json|ogg|mp3|wav|flac|m4a|opus|aac)$/u] : null] : null);
  await collect(join(directory, SONG_DOWNLOAD_CACHE), paths, null, (name) => {
    if (/^track-[a-z0-9]{6}$/iu.test(name)) return [cachedSource];
    if (name === 'index') return [null, (child) => hash.test(child) ? [indexFile] : null];
    return null;
  });
}

export function createVoiceCache({ root = voiceRoot, temporaryRoot, limitBytes = 500_000_000 } = {}) {
  let status = { limitBytes, bytes: null, checkedAt: null, lastCleanup: null, error: null };
  let active = 0;
  let sweep;
  let deferred = false;
  let retry = new Set();

  async function inspect() {
    const directory = await realpath(root).catch(optional);
    const paths = [];
    if (directory) await collectSongs(directory, paths);
    const tempFiles = [];
    const temp = temporaryRoot && await realpath(temporaryRoot).catch(optional);
    if (temp) {
      await collect(join(temp, 'audio-upload'), tempFiles, voiceUpload);
      await collect(join(temp, 'audio-transcode'), tempFiles, voiceTranscode);
    }
    const staleBefore = Date.now() - temporaryVoiceAgeMs;
    const temporary = new Set(tempFiles);
    const files = [];
    for (const path of [...paths, ...temporary]) {
      const parent = dirname(path);
      // Windows junctions can change the resolution of an otherwise local path.
      if (await realpath(parent).catch(optional) !== parent) continue;
      const info = await lstat(path).catch(optional);
      // SnowLuma normally removes these after use. Leave recent files to its active uploads and transcodes.
      if (info?.isFile() && (!temporary.has(path) || info.mtimeMs <= staleBefore)) files.push({ path, parent, info });
    }
    const bytes = files.reduce((total, { info }) => total + info.size, 0);
    const targets = bytes > limitBytes ? files : files.filter(({ path }) => retry.has(path));

    let deleted = 0;
    let count = 0;
    const pending = new Set();
    const empty = new Set();
    const converted = directory && join(directory, SONG_DOWNLOAD_CACHE) + sep;
    const sources = directory && join(directory, 'qq-song-learned', 'sources') + sep;
    for (const { path, parent, info } of targets) {
      try {
        if (await realpath(parent).catch(optional) !== parent) continue;
        const current = await lstat(path).catch(optional);
        if (!current) continue;
        if (!current.isFile() || current.ino !== info.ino || current.size !== info.size || current.mtimeMs !== info.mtimeMs) {
          pending.add(path);
          continue;
        }
        await unlink(path);
        deleted += info.size;
        count++;
        if (directory && (parent.startsWith(converted) || parent.startsWith(sources))) empty.add(parent);
      } catch (error) {
        if (error.code !== 'ENOENT') pending.add(path);
      }
    }
    for (const parent of empty) {
      if (await realpath(parent).catch(() => null) === parent) await rmdir(parent).catch(() => {});
    }
    retry = pending;
    return { bytes: bytes - deleted, deleted, count, skipped: pending.size };
  }

  function check() {
    if (active) {
      deferred = true;
      return Promise.resolve(status);
    }
    if (sweep) return sweep;
    deferred = false;
    sweep = inspect().then(({ bytes, deleted, count, skipped }) => {
      const time = new Date().toISOString();
      status = { ...status, checkedAt: time, bytes,
        lastCleanup: count ? { at: time, count, bytes: deleted } : status.lastCleanup,
        error: skipped ? '有缓存文件正在使用或无法删除，下次检查时重试。' : null };
    }).catch((error) => {
      status = { ...status, checkedAt: new Date().toISOString(), error: '检查语音缓存失败（' + (error.code || error.name) + '）。' };
    }).finally(() => { sweep = undefined; }).then(() => status);
    return sweep;
  }

  return {
    status: () => status,
    check,
    async run(work) {
      active++;
      try {
        await sweep;
        return await work();
      } finally {
        active--;
        if (deferred && active === 0) void check();
      }
    },
  };
}

export const voiceCache = createVoiceCache({ temporaryRoot: tmpdir() });
