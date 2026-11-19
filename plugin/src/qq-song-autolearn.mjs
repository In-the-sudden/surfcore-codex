import { voiceRoot as voiceDirectory } from './local-installation.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasSongVersion, matchesSongArtist, resolveSong, sectionKey } from './qq-song.mjs';
import { selectSongSegment } from './qq-song-chorus.mjs';

const formats = new Set(['ogg', 'mp3', 'wav', 'flac', 'm4a', 'opus', 'aac']);

function requestedPortion(section) {
  if (section == null || (typeof section === 'string' && !section.trim())) return undefined;
  const key = sectionKey(section);
  return key === 'first30' ? 'opening' : key ?? null;
}

const digest = (audio) => createHash('sha256').update(audio).digest('hex');

function randomExcerpt(duration, candidates, random) {
  if (!Number.isFinite(duration) || duration <= 0) return undefined;
  const value = random();
  const position = Number.isFinite(value) ? Math.max(0, Math.min(1 - Number.EPSILON, value)) : 0.5;
  const usable = Array.isArray(candidates) ? candidates.filter((clip) =>
    Number.isFinite(clip?.start) && Number.isFinite(clip?.end) && clip.start >= 0 &&
    clip.end <= duration && clip.end - clip.start >= 20 && clip.end - clip.start <= 40) : [];
  if (usable.length) {
    const { start, end } = usable[Math.floor(position * usable.length)];
    return { start, end };
  }
  const seconds = Math.min(30, duration);
  const start = Math.floor(position * (duration - seconds) * 1000) / 1000;
  return { start, end: Math.min(duration, start + seconds) };
}

async function saveRecording(recording, root, signal) {
  if (!Buffer.isBuffer(recording.audio) || !recording.audio.length || !formats.has(recording.format)) {
    throw new Error('可下载音源的格式不受支持。');
  }
  const sha256 = digest(recording.audio);
  const directory = join(root, 'qq-song-learned', 'sources', sha256);
  const path = join(directory, 'source.' + recording.format);
  await mkdir(directory, { recursive: true });
  const existing = await readFile(path, { signal }).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!existing || digest(existing) !== sha256) {
    const temporary = join(directory, randomUUID() + '.part');
    try {
      await writeFile(temporary, recording.audio, { flag: 'wx', signal });
      signal?.throwIfAborted();
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  const { audio: _audio, ...provenance } = recording;
  await writeFile(join(directory, 'source.json'), JSON.stringify({ ...provenance, sha256 }, null, 2) + '\n',
    { flag: 'wx', signal }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  return path;
}

function recordingCredit(recording, songLabel, portion) {
  if (!recording || !/^CC BY(?:\s|$)/iu.test(recording.license || '')) return undefined;
  const author = recording.attribution || recording.artist;
  return [songLabel + '的原录音来自' + author + '。', recording.pageUrl,
    recording.license + ' ' + recording.licenseUrl, '此片段为' + portion + '裁剪及知微换声。'].filter(Boolean).join('\n');
}

export async function prepareSongReply(request, {
  roleId = 'zhiwei',
  signal,
  voiceRoot = voiceDirectory,
  resolvePrepared = resolveSong,
  discover = async (...args) => (await import('./qq-song-source.mjs')).discoverSongAcrossSources(...args),
  acquireQQMusic,
  probeDuration = async (...args) => (await import('./qq-song-learn.mjs')).probeSongDuration(...args),
  detectOpening = async (...args) => (await import('./qq-song-timing.mjs')).detectSongOpening(...args),
  learnClip = async (...args) => (await import('./qq-song-learn.mjs')).learnSongClip(...args),
  readLyrics = async (...args) => (await import('./qq-song-lyrics.mjs')).readSongLyrics(...args),
  random = Math.random,
} = {}) {
  const preferFemale = roleId === 'zhiwei' && !request?.artist && !hasSongVersion(request?.title);
  const local = await resolvePrepared(request, { signal, lookupOnline: false, preferFemale, random });
  if (local.audio || (local.needsArtist && (!acquireQQMusic || request?.artist))) return local;
  const title = typeof request?.title === 'string' ? request.title.trim() : '';
  const artist = typeof request?.artist === 'string' ? request.artist.trim() : undefined;
  const wanted = requestedPortion(request?.section);
  const lineRequested = request?.line || request?.lineNumber != null || request?.lineCount != null;
  const canLearn = roleId === 'zhiwei' && title && title.length <= 100 && (artist?.length ?? 0) <= 100 &&
    wanted !== null && !lineRequested;
  if (!canLearn) return local.song || !title ? local : resolvePrepared(request, { signal, preferFemale, random });

  return {
    text: '我去找音源，找到就学唱这段。',
    async learn(jobSignal) {
      const deadline = AbortSignal.timeout(6 * 60_000);
      const workSignal = AbortSignal.any([deadline, ...[signal, jobSignal].filter(Boolean)]);
      workSignal.throwIfAborted();
      let source = local.learningSource;
      let recording;
      let desktopRecording;
      let desktopError;
      if (!source) {
        const avoidedArtists = preferFemale ? local.avoidedArtists ?? [] : [];
        let lookupFailed = false;
        if (acquireQQMusic) {
          try { desktopRecording = await acquireQQMusic({ title, artist }, { signal: workSignal, avoidedArtists }); }
          catch (error) {
            workSignal.throwIfAborted();
            desktopError = error;
          }
        }
        if (!desktopRecording && (!desktopError || desktopError.phase === 'qq-music-desktop')) {
          try { recording = await discover({ title, artist }, { signal: workSignal, avoidedArtists }); }
          catch {
            workSignal.throwIfAborted();
            lookupFailed = true;
          }
        }
        if (matchesSongArtist(recording?.artist || desktopRecording?.artist, avoidedArtists) ||
            (!recording && !desktopRecording && avoidedArtists.length && !lookupFailed && !desktopError)) {
          return { text: '我还没找到《' + title + '》的合适女声音源。你可以点名其他版本，或者导入一份女声录音。' };
        }
        if (!recording && !desktopRecording) {
          if (desktopError) throw desktopError;
          const metadata = await resolvePrepared(request, { signal: workSignal, preferFemale, random });
          const label = '《' + (metadata.song?.title || title) + '》';
          const link = metadata.song?.url;
          const reason = lookupFailed ? '音源站暂时无法访问，' + label + '稍后再试。'
            : '我暂时找不到' + label + '这个版本可下载的原音频。你也可以在控制台导入本地录音。';
          return { text: reason + (link ? '\n' + link : '') };
        }
        source = desktopRecording?.source ?? {
          path: await saveRecording(recording, voiceRoot, workSignal),
          sourceStart: 0,
          opening: recording.opening,
          chorus: recording.chorus,
        };
      }
      const duration = await probeDuration(source.path, { signal: workSignal });
      const timing = { ...source, duration };
      let opening = selectSongSegment({ ...timing, section: 'opening' });
      const chorus = selectSongSegment({ ...timing, section: 'chorus' });
      let randomOpening = false;
      if (!opening && wanted !== 'chorus') {
        let candidates;
        try {
          const detected = await detectOpening({ sourcePath: source.path, duration }, { signal: workSignal });
          opening = selectSongSegment({ duration, sourceStart: 0, opening: detected.opening, section: 'opening' });
          candidates = detected.fallbackSegments;
        } catch {
          workSignal.throwIfAborted();
        }
        if (!opening) {
          opening = randomExcerpt(duration, candidates, random);
          randomOpening = Boolean(opening);
        }
      }
      const section = wanted || (chorus && (!opening || random() >= 0.5) ? 'chorus' : 'opening');
      const clip = section === 'chorus' ? chorus : opening;
      const songLabel = '《' + (recording?.title || desktopRecording?.title || local.song?.title || title) + '》';
      const portion = section === 'chorus' ? '副歌' : randomOpening ? '片段' : '开头';
      if (!clip) {
        const detail = section === 'chorus' ? '副歌' : '开唱和句尾';
        return { text: songLabel + (desktopRecording ? '已入库，还缺这份录音的' : '这份录音还没有可用的') + detail + '时间点。' };
      }
      const performance = {
        title: recording?.title || desktopRecording?.title || local.song?.title || title,
        artist: recording?.artist || desktopRecording?.artist || local.song?.artist || artist,
        portion, start: clip.start + (source.sourceStart || 0), end: clip.end + (source.sourceStart || 0),
      };
      const jobs = [
        learnClip({ sourcePath: source.path, ...clip }, { signal: workSignal }),
        readLyrics({ sourcePath: source.path, lyricPath: source.lyricPath, ...performance, voiceRoot, signal: workSignal })
          .catch(() => { workSignal.throwIfAborted(); return { status: 'unavailable', lines: [], text: '' }; }),
      ];
      const [learned, lyrics] = await Promise.all(jobs).catch(async (error) => {
        // Each job can still be reading the source while the other fails.
        await Promise.allSettled(jobs);
        throw error;
      });
      workSignal.throwIfAborted();
      return { audio: learned.audio, text: '给你唱' + songLabel + '的' + portion + '。',
        performance: { ...performance, lyrics }, credit: recordingCredit(recording, songLabel, portion) };
    },
  };
}
