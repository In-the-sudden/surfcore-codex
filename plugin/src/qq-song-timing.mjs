import { voiceRoot as VOICE_ROOT } from './local-installation.mjs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localSongSource, probeSongDuration, runSongCommand } from './qq-song-learn.mjs';
import { runSongModelJob } from './qq-song-model-queue.mjs';
import { selectSongSegment } from './qq-song-chorus.mjs';

const HELPER = fileURLToPath(new URL('./qq-song-timing-audio.py', import.meta.url));
const SCAN_SECONDS = 100;
const CACHE_VERSION = 'demucs-whisper-opening-v1';

function validReport(report, duration) {
  if (typeof report?.analysisVersion !== 'string' || !report.analysisVersion.length) return false;
  if (report.status === 'partial') {
    return Array.isArray(report.fallbackSegments) && report.fallbackSegments.length > 0 &&
      report.fallbackSegments.length <= 512 && report.fallbackSegments.every((clip) =>
        Number.isFinite(clip?.start) && Number.isFinite(clip?.end) && clip.start >= 0 &&
        clip.end <= Math.min(duration, SCAN_SECONDS) && clip.end - clip.start >= 20 && clip.end - clip.start <= 40 &&
        Number.isFinite(clip.vocalSupport) && clip.vocalSupport >= 0.4 && clip.vocalSupport <= 1 &&
        Number.isFinite(clip.startGap) && clip.startGap >= 0.35 &&
        Number.isFinite(clip.endGap) && clip.endGap >= 0.35);
  }
  const confidence = report?.confidence;
  return report?.status === 'detected' && confidence?.level === 'supported' &&
    Number.isFinite(confidence.asrProbability) && confidence.asrProbability >= 0.25 && confidence.asrProbability <= 1 &&
    Number.isFinite(confidence.vocalSupport) && confidence.vocalSupport >= 0.4 && confidence.vocalSupport <= 1 &&
    report.opening?.vocalStart <= SCAN_SECONDS &&
    Boolean(selectSongSegment({ ...report, section: 'opening', duration, sourceStart: 0 }));
}

async function sourceDigest(path, signal) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) digest.update(chunk);
  signal?.throwIfAborted();
  return digest.digest('hex');
}

async function analyzeOpening({ clipPath, workDir, voiceRoot, signal }) {
  const python = join(voiceRoot, 'seed-vc', 'venv', 'Scripts', 'python.exe');
  const { stdout } = await runSongCommand(python, [HELPER, '--input', clipPath,
    '--work-directory', workDir, '--voice-root', voiceRoot], { signal, cwd: workDir, timeout: 180_000 });
  const report = JSON.parse(stdout.toString('utf8').trim());
  return { ...report, analysisVersion: report.method };
}

export function createSongTimingDetector({ voiceRoot = VOICE_ROOT,
  ffmpeg = process.env.SURFCORE_FFMPEG || 'ffmpeg',
  analyze = analyzeOpening,
} = {}) {
  return async function detect({ sourcePath, duration }, { signal } = {}) {
    try {
      const source = await localSongSource(sourcePath, signal);
      duration ??= await probeSongDuration(source, { ffmpeg, signal });
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid song duration');
      const root = await realpath(voiceRoot);
      const folder = join(root, 'qq-song-timing');
      await mkdir(folder, { recursive: true });
      const cache = await realpath(folder);
      if (dirname(cache) !== root || basename(cache) !== 'qq-song-timing') throw new Error('Invalid timing cache directory');
      const sha256 = await sourceDigest(source, signal);
      const helperHash = analyze === analyzeOpening ? await sourceDigest(HELPER, signal) : 'custom';
      const key = createHash('sha256').update(CACHE_VERSION).update(helperHash).update(sha256).digest('hex');
      const resultPath = join(cache, key + '.json');
      const readCached = async () => {
        try {
          if ((await stat(resultPath)).size > 256 * 1024) return;
          const result = JSON.parse(await readFile(resultPath, { encoding: 'utf8', signal }));
          if (result.sourceSha256 === sha256 && validReport(result, duration)) return { ...result, cached: true };
        } catch { signal?.throwIfAborted(); }
      };
      const hit = await readCached();
      if (hit) return hit;
      return await runSongModelJob(async () => {
        const queuedHit = await readCached();
        if (queuedHit) return queuedHit;
        const workDir = await mkdtemp(join(cache, 'job-'));
        try {
          const clipPath = join(workDir, 'opening.wav');
          await runSongCommand(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error',
            '-format_whitelist', 'wav,flac,mp3,mov,ogg,aac', '-protocol_whitelist', 'file,pipe',
            '-i', source, '-t', String(SCAN_SECONDS), '-map', '0:a:0', '-ac', '2', '-ar', '44100',
            '-c:a', 'pcm_s16le', clipPath], { signal, timeout: 30_000 });
          const analyzed = await analyze({ clipPath, workDir, voiceRoot: root, signal });
          if (!validReport(analyzed, Math.min(duration, SCAN_SECONDS))) throw new Error('No reliable opening and complete phrase end were detected');
          const currentSha256 = await sourceDigest(source, signal);
          if (currentSha256 !== sha256) throw new Error('Source changed during timing analysis');
          const result = { ...analyzed, sourceSha256: sha256, sourceDuration: duration,
            analyzedAt: new Date().toISOString(), ...(analyzed.opening && { opening: {
              vocalStart: analyzed.opening.vocalStart, phraseEnd: analyzed.opening.phraseEnd,
            } }) };
          const temporary = join(workDir, 'timing.json');
          await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { signal, flag: 'wx' });
          signal?.throwIfAborted();
          await rename(temporary, resultPath);
          return { ...result, cached: false };
        } finally {
          await rm(workDir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
        }
      }, { signal });
    } catch (cause) {
      signal?.throwIfAborted();
      throw Object.assign(new Error('Song opening timing failed: ' + cause.message, { cause }), { phase: 'timing' });
    }
  };
}

export const detectSongOpening = createSongTimingDetector();
