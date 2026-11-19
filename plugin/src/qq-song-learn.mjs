import { voiceRoot as VOICE_ROOT } from './local-installation.mjs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWav } from './voice-wav.mjs';
import { MAX_OPENING_SECONDS } from './qq-song-chorus.mjs';
import { runSongModelJob } from './qq-song-model-queue.mjs';

const AUDIO_HELPER = fileURLToPath(new URL('./qq-song-learn-audio.py', import.meta.url));
const SOURCE_EXTENSIONS = new Set(['.wav', '.flac', '.mp3', '.m4a', '.ogg', '.opus', '.aac']);
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_CLIP_SECONDS = MAX_OPENING_SECONDS;
const MODEL_RATE = 44100;
const MODEL_FRAME_BYTES = 4;
const CLIP_TOLERANCE_SECONDS = 0.02;
const QQ_RATE = 16000;
const FFMPEG_BASE = ['-nostdin', '-hide_banner'];
const LOCAL_AUDIO = ['-format_whitelist', 'wav,flac,mp3,mov,ogg,aac', '-protocol_whitelist', 'file,pipe'];
const CACHE_VERSION = 'zhiwei-a-demucs-kara2-v1';

function defaultFfmpeg() {
  return process.env.SURFCORE_FFMPEG || 'ffmpeg';
}

async function inPhase(phase, signal, operation) {
  signal?.throwIfAborted();
  try {
    const result = await operation();
    signal?.throwIfAborted();
    return result;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause?.phase) throw cause;
    throw Object.assign(new Error(`Song learning ${phase} failed: ${cause?.message ?? String(cause)}`, { cause }), { phase });
  }
}

function runCommand(program, args, { signal, cwd, timeout = 15_000, maxBuffer = 256 * 1024 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let stopped = false;
    let failure;
    let stoppingTree;
    const subprocess = execFile(program, args, {
      cwd, maxBuffer, encoding: 'buffer', windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', ...(cwd && { TEMP: cwd, TMP: cwd, TMPDIR: cwd }) },
    }, (error, stdout, stderr) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (stopped) Promise.resolve(stoppingTree).then(() => reject(failure));
      else if (error) {
        const message = (stderr?.toString('utf8').trim() || stdout?.toString('utf8').trim())?.slice(-1200);
        reject(new Error(message || error.message, { cause: error }));
      } else resolve({ stdout, stderr });
    });
    const stop = (error) => {
      if (stopped) return;
      stopped = true;
      failure = error;
      if (!subprocess.pid) return;
      if (process.platform === 'win32') {
        // Seed-VC launches inference in its own child. Stop the whole tree before cleanup.
        stoppingTree = new Promise((done) => {
          execFile('taskkill.exe', ['/PID', String(subprocess.pid), '/T', '/F'], {
            windowsHide: true, timeout: 5000,
          }, (killError) => {
            if (killError) subprocess.kill();
            done();
          });
        });
      } else subprocess.kill();
    };
    const abort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(new Error(`${basename(program)} timed out`)), timeout);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function localSource(sourcePath, signal) {
  return inPhase('source', signal, async () => {
    if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath) || /^[\\/]{2}/u.test(sourcePath) ||
        !SOURCE_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
      throw new Error('Expected an absolute path to a local audio file');
    }
    const source = await realpath(sourcePath);
    const info = await stat(source);
    if (/^[\\/]{2}/u.test(source) || !info.isFile() || info.size < 1 || info.size > MAX_SOURCE_BYTES) {
      throw new Error('Source is not a bounded local audio file');
    }
    return source;
  });
}

export async function probeSongDuration(sourcePath, { signal, ffmpeg = defaultFfmpeg() } = {}) {
  const source = await localSource(sourcePath, signal);
  return inPhase('probe', signal, async () => {
    const { stderr } = await runCommand(ffmpeg, [
      ...FFMPEG_BASE, ...LOCAL_AUDIO, '-i', source, '-map', '0:a:0', '-t', '0', '-f', 'null', '-',
    ], { signal });
    const match = /^\s{2}Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/mu.exec(stderr.toString('utf8'));
    const duration = match && (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Audio duration is unavailable');
    return duration;
  });
}

function clipWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(MODEL_RATE, 24);
  header.writeUInt32LE(MODEL_RATE * MODEL_FRAME_BYTES, 28);
  header.writeUInt16LE(MODEL_FRAME_BYTES, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function extractClip(source, start, end, ffmpeg, signal) {
  return inPhase('clip', signal, async () => {
    const duration = end - start;
    const frames = Math.round(duration * MODEL_RATE);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || frames < 1 || frames > MAX_CLIP_SECONDS * MODEL_RATE) {
      throw new Error(`Expected a positive audio interval of at most ${MAX_CLIP_SECONDS} seconds`);
    }
    const { stdout } = await runCommand(ffmpeg, [
      ...FFMPEG_BASE, '-loglevel', 'error', ...LOCAL_AUDIO, '-ss', start.toFixed(6), '-i', source,
      '-t', (frames / MODEL_RATE).toFixed(8), '-map', '0:a:0', '-ac', '2', '-ar', String(MODEL_RATE),
      '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1',
    ], { signal, maxBuffer: MAX_CLIP_SECONDS * MODEL_RATE * MODEL_FRAME_BYTES + 4096 });
    const durationSeconds = stdout.length / MODEL_FRAME_BYTES / MODEL_RATE;
    if (!stdout.length || stdout.length % MODEL_FRAME_BYTES || durationSeconds > MAX_CLIP_SECONDS ||
        Math.abs(durationSeconds - duration) > CLIP_TOLERANCE_SECONDS) {
      throw new Error('Decoded audio does not cover the requested interval');
    }
    return { pcm: stdout, durationSeconds };
  });
}

function seedProfile(voiceRoot) {
  return join(voiceRoot, 'seed-vc', 'zhiwei-profile.json');
}

async function convertClip({ clipPath, outputPath, workDir, voiceRoot, ffmpeg, signal }) {
  const seedRoot = join(voiceRoot, 'seed-vc');
  const python = join(seedRoot, 'venv', 'Scripts', 'python.exe');
  const demucsRoot = join(voiceRoot, 'song-xiaoxiaoqiji');
  const leadAssets = join(voiceRoot, 'lead-separation-assets');
  const separator = join(leadAssets, 'sherpa-onnx-v2.0.1-win-x64-shared-MD-Release-no-tts', 'bin', 'sherpa-onnx-offline-source-separation.exe');
  const helper = (args) => runCommand(python, [AUDIO_HELPER, ...args], { signal, cwd: workDir });
  const runModel = (program, args, timeout) => runCommand(program, args, { signal, cwd: workDir, timeout });
  let demucsRun;
  try {
    const vocals = await inPhase('separation', signal, async () => {
      const { stdout } = await runModel(python, [
        join(demucsRoot, 'separate_song.py'), clipPath, '--device', 'cuda',
      ], 120_000);
      const reportLine = /^REPORT=(.+)$/mu.exec(stdout.toString('utf8'));
      if (!reportLine) throw new Error('Demucs did not report a completed run');
      const reportPath = await realpath(reportLine[1].trim());
      const runDir = dirname(reportPath);
      if (basename(reportPath) !== 'report.json' || dirname(runDir) !== await realpath(join(demucsRoot, 'runs')) ||
          !/^\d{8}-\d{6}-[a-f0-9]{8}$/u.test(basename(runDir))) throw new Error('Unexpected Demucs report path');
      demucsRun = runDir;
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      if (report.status !== 'separated_pending_listening') throw new Error('Demucs separation is incomplete');
      return join(runDir, 'vocals.wav');
    });

    const leadPath = join(workDir, 'lead.wav');
    const monoPath = join(workDir, 'lead-mono.wav');
    await inPhase('lead', signal, async () => {
      const input = 'vocals-pcm.wav';
      const primary = 'kara-primary.wav';
      const secondary = 'kara-secondary.wav';
      const model = relative(workDir, join(leadAssets, 'UVR_MDXNET_KARA_2.onnx'));
      await helper(['prepare', clipPath, vocals, input]);
      await runModel(separator, [
        '--num-threads=2', '--provider=cpu', `--uvr-model=${model}`, `--input-wav=${input}`,
        `--output-vocals-wav=${primary}`, `--output-accompaniment-wav=${secondary}`,
      ], 120_000);
      await helper(['lead', clipPath, vocals, input, primary, secondary, leadPath, monoPath]);
    });

    const converted = await inPhase('conversion', signal, async () => {
      const outputRoot = join(workDir, 'seed-vc');
      const { stdout } = await runModel(python, [
        join(seedRoot, 'singing_runner.py'), '--source', monoPath,
        '--profile', seedProfile(voiceRoot), '--output-root', outputRoot,
      ], 240_000);
      const report = JSON.parse(stdout.toString('utf8').trim());
      if (report.status !== 'converted_pending_listening' || report.outputs?.length !== 1 || !report.outputs[0].path) {
        throw new Error('Seed-VC did not return a converted A-timbre vocal');
      }
      return report.outputs[0].path;
    });

    await inPhase('mix', signal, async () => {
      const mixPath = join(workDir, 'mix.wav');
      await helper(['mix', clipPath, leadPath, converted, mixPath]);
      await runCommand(ffmpeg, [
        ...FFMPEG_BASE, '-loglevel', 'error', '-i', mixPath, '-map', '0:a:0',
        '-ac', '1', '-ar', String(QQ_RATE), '-c:a', 'pcm_s16le', outputPath,
      ], { signal });
    });
  } finally {
    if (demucsRun) await rm(demucsRun, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
}

async function readResult(path, expectedSeconds, signal) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_CLIP_SECONDS * QQ_RATE * 2 + 4096) throw new Error('Invalid song audio size');
  const { audio, durationMs, channels, sampleRate } = normalizeWav(await readFile(path, { signal }));
  const durationSeconds = durationMs / 1000;
  if (channels !== 1 || sampleRate !== QQ_RATE || durationSeconds > MAX_CLIP_SECONDS ||
      Math.abs(durationSeconds - expectedSeconds) > CLIP_TOLERANCE_SECONDS) throw new Error('Invalid song audio layout or length');
  return { audio, durationSeconds };
}

export function createSongLearner({ voiceRoot = VOICE_ROOT, ffmpeg = defaultFfmpeg(), render = convertClip } = {}) {
  let pending = Promise.resolve();
  return async ({ sourcePath, start, end }, { signal } = {}) => {
    signal?.throwIfAborted();
    let cancelWait;
    const operation = pending.then(async () => {
      signal?.removeEventListener('abort', cancelWait);
      signal?.throwIfAborted();
      const source = await localSource(sourcePath, signal);
      const { pcm, durationSeconds } = await extractClip(source, start, end, ffmpeg, signal);
      const root = await inPhase('workspace', signal, () => realpath(voiceRoot));
      const cache = await inPhase('workspace', signal, async () => {
        const folder = join(root, 'qq-song-learned');
        await mkdir(folder, { recursive: true });
        const actual = await realpath(folder);
        if (dirname(actual) !== root || basename(actual) !== 'qq-song-learned') throw new Error('Invalid song cache directory');
        return actual;
      });
      const profile = render === convertClip
        ? await inPhase('conversion', signal, () => readFile(seedProfile(root), { signal })) : Buffer.alloc(0);
      const key = createHash('sha256').update(CACHE_VERSION).update(profile).update(pcm).digest('hex');
      const cachedPath = join(cache, `${key}.wav`);
      try {
        const hit = await readResult(cachedPath, durationSeconds, signal);
        signal?.throwIfAborted();
        return { ...hit, cached: true };
      } catch { signal?.throwIfAborted(); }

      let workDir;
      try {
        await inPhase('workspace', signal, async () => { workDir = await mkdtemp(join(cache, 'job-')); });
        const clipPath = join(workDir, 'clip.wav');
        const outputPath = join(workDir, 'result.wav');
        await inPhase('workspace', signal, () => writeFile(clipPath, clipWav(pcm), { signal }));
        await inPhase('conversion', signal, () => runSongModelJob(
          () => render({ clipPath, outputPath, workDir, voiceRoot: root, ffmpeg, durationSeconds, signal }), { signal }));
        const result = await inPhase('mix', signal, () => readResult(outputPath, durationSeconds, signal));
        await inPhase('cache', signal, () => rename(outputPath, cachedPath));
        return { ...result, cached: false };
      } finally {
        if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
      }
    });
    pending = operation.catch(() => {});
    if (!signal) return operation;
    const cancelledWhileQueued = new Promise((_, reject) => {
      cancelWait = () => reject(signal.reason);
      signal.addEventListener('abort', cancelWait, { once: true });
    });
    return Promise.race([operation, cancelledWhileQueued]);
  };
}

export const learnSongClip = createSongLearner();
export { localSource as localSongSource, runCommand as runSongCommand };
