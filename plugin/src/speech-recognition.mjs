import { voiceRoot as defaultVoiceRoot } from './local-installation.mjs';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const defaultRoot = join(defaultVoiceRoot, 'whisper');

export async function recognizeSpeech(bytes, { kind = 'audio', ffmpeg = process.env.SURFCORE_FFMPEG || 'ffmpeg',
  cli = process.env.SURFCORE_WHISPER_CLI || join(defaultRoot, 'bin', 'Release', 'whisper-cli.exe'),
  model = process.env.SURFCORE_WHISPER_MODEL || join(defaultRoot, 'ggml-base.bin') } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 30 * 1024 * 1024) return { error: '音频无效或过大' };
  try { await Promise.all([access(cli), access(model)]); } catch { return { error: '本地识别器或模型不可用' }; }
  const directory = await mkdtemp(join(tmpdir(), 'surfcore-asr-'));
  try {
    const input = join(directory, 'input'), wav = join(directory, 'audio.wav'), output = join(directory, 'transcript');
    await writeFile(input, bytes, { mode: 0o600 });
    const format = kind === 'video' ? 'mov,matroska,avi,flv,mpegts' : 'wav,mp3,ogg,flac';
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-format_whitelist', format, '-protocol_whitelist', 'file,pipe', '-i', input,
      '-vn', '-t', '180', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav],
    { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const volume = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', wav, '-af', 'volumedetect', '-f', 'null', '-'],
      { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const peak = /max_volume:\s*(-?\d+(?:\.\d+)?|-inf) dB/.exec(volume.stderr)?.[1];
    if (peak === undefined || peak === '-inf' || Number(peak) <= -50) return { error: '未检测到可识别声音' };
    await run(cli, ['-m', model, '-f', wav, '-l', 'auto', '-ng', '-nt', '-otxt', '-of', output],
      { timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const text = (await readFile(output + '.txt', 'utf8')).trim().slice(0, 2000);
    return text ? { text } : { error: '未识别到语音' };
  } catch { return { error: '本地语音识别不可用或未识别到语音' }; }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
