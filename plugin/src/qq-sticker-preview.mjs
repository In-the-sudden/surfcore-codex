import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./qq-sticker-preview.py', import.meta.url));
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;

function pythonCommands() {
  if (process.env.SURFCORE_STICKER_PYTHON) return [process.env.SURFCORE_STICKER_PYTHON];
  const runtime = join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python');
  const bundled = process.platform === 'win32' ? join(runtime, 'python.exe') : join(runtime, 'bin', 'python3');
  const commands = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  return existsSync(bundled) ? [bundled, ...commands] : commands;
}

function render(python, bytes, extension, maxImages, maxTotalImageBytes) {
  return new Promise((resolve) => {
    const child = spawn(python, ['-E', script, extension, String(maxImages), String(maxTotalImageBytes)], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks = [];
    let size = 0;
    const maxOutput = Math.ceil(maxTotalImageBytes / 3) * 4 + 4096;
    let limited = false;
    const timeout = setTimeout(() => { limited = true; child.kill(); }, 8_000);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxOutput) { limited = true; child.kill(); }
      if (!limited) chunks.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({ unavailable: error.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 3) { resolve({ unavailable: true }); return; }
      if (code !== 0 || limited) { resolve({}); return; }
      try { resolve({ output: JSON.parse(Buffer.concat(chunks, size).toString('utf8')) }); }
      catch { resolve({}); }
    });
    child.stdin.end(bytes);
  });
}

export async function previewSticker(bytes, extension, { maxImages = 4, maxTotalImageBytes = MAX_TOTAL_IMAGE_BYTES } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES ||
      !['png', 'jpg', 'gif', 'webp'].includes(extension) || !Number.isInteger(maxImages) ||
      !Number.isInteger(maxTotalImageBytes) || maxImages < 1 || maxTotalImageBytes < 1) return null;
  maxImages = Math.min(maxImages, 4);
  maxTotalImageBytes = Math.min(maxTotalImageBytes, MAX_TOTAL_IMAGE_BYTES);
  for (const python of pythonCommands()) {
    const { unavailable, output } = await render(python, bytes, extension, maxImages, maxTotalImageBytes);
    if (unavailable) continue;
    if (!output || !Array.isArray(output.sheets) || !output.sheets.length || output.sheets.length > maxImages ||
        !Number.isSafeInteger(output.frameCount) || !Number.isSafeInteger(output.shownFrames) ||
        output.shownFrames < 1 || output.frameCount < output.shownFrames) return null;
    const complete = output.frameCount === output.shownFrames;
    if (complete && !/^[a-f0-9]{64}$/.test(output.visualHash)) return null;
    const images = output.sheets.map((item) => ({ bytes: Buffer.from(item, 'base64'), extension: 'png' }));
    if (images.some(({ bytes }) => bytes.length > MAX_IMAGE_BYTES || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') ||
        images.reduce((size, { bytes }) => size + bytes.length, 0) > maxTotalImageBytes) return null;
    return { images, frameCount: output.frameCount, shownFrames: output.shownFrames, complete,
      ...(complete && { visualHash: output.visualHash }) };
  }
  return null;
}
