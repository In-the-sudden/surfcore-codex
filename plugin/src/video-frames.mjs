import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;

function defaultFfmpeg() {
  return process.env.SURFCORE_FFMPEG || 'ffmpeg';
}

export async function videoFrames(bytes, { ffmpeg = defaultFfmpeg() } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_VIDEO_BYTES) return { error: '视频大小超限或无效' };
  const directory = await mkdtemp(join(tmpdir(), 'surfcore-video-'));
  try {
    const input = join(directory, 'input');
    await writeFile(input, bytes, { mode: 0o600 });
    let metadata = '';
    try {
      const result = await run(ffmpeg, ['-hide_banner', '-format_whitelist', 'mov,matroska,avi,flv,mpegts', '-protocol_whitelist', 'file,pipe', '-i', input], { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true });
      metadata = result.stderr;
    } catch (error) {
      if (error.code === 'ENOENT' || error.killed || typeof error.stderr !== 'string') return { error: '视频解码工具不可用' };
      metadata = error.stderr;
    }
    const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(metadata);
    if (!match) return { error: '视频时长无法确认' };
    const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    if (!Number.isFinite(duration) || duration <= 0) return { error: '视频时长无法确认' };
    // ffmpeg displays duration to two decimals; the boundary can be rounded.
    if (duration >= 180) return { error: '视频接近或超过3分钟，不读取画面' };
    const images = [];
    for (let index = 0; index < 3; index++) {
      const time = duration * index / 3;
      const output = join(directory, 'frame-' + index + '.jpg');
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-format_whitelist', 'mov,matroska,avi,flv,mpegts', '-protocol_whitelist', 'file,pipe', '-ss', time.toFixed(3), '-i', input,
        '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-y', output],
      { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true });
      const frame = await readFile(output);
      if (frame.length > 5 * 1024 * 1024 || frame[0] !== 0xff || frame[1] !== 0xd8) return { error: '视频抽帧失败' };
      images.push({ bytes: frame, extension: 'jpg' });
    }
    return { duration, images };
  } catch { return { error: '视频抽帧失败' }; }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
