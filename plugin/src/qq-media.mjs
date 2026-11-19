import { snowLumaDirectory } from './local-installation.mjs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { videoFrames } from './video-frames.mjs';
import { recognizeSpeech } from './speech-recognition.mjs';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;

export function safeImageReference(value) {
  return typeof value === 'string' && value.length <= 512 && /^[\w.+=@-]+$/.test(value) && !value.includes('..');
}

export function safeImageUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
        !(host === 'qpic.cn' || host.endsWith('.qpic.cn') || host === 'multimedia.nt.qq.com.cn')) return null;
    return url.href;
  } catch { return null; }
}

export function parseMediaSegments(segments) {
  const media = [];
  const text = [];
  for (const segment of segments) {
    if (segment?.type === 'text' && typeof segment.data?.text === 'string') text.push(segment.data.text);
    else if (segment?.type === 'image' && media.filter((item) => item.type === 'image').length < MAX_IMAGES) {
      const marker = '[图片' + (media.filter((item) => item.type === 'image').length + 1) + ']';
      media.push({ type: 'image', marker, file: safeImageReference(segment.data?.file) ? segment.data.file : null, url: safeImageUrl(segment.data?.url) });
      text.push(marker);
    } else if (segment?.type === 'image') text.push('[图片超出数量限制]');
    else if (segment?.type === 'record') {
      if (!media.some((item) => item.type === 'record')) { media.push({ type: 'record', file: safeImageReference(segment.data?.file) ? segment.data.file : null }); text.push('[语音]'); }
      else text.push('[语音未转写]');
    } else if (segment?.type === 'video') {
      if (!media.some((item) => item.type === 'video')) {
        media.push({ type: 'video', url: safeImageUrl(segment.data?.url) });
        text.push('[视频]');
      } else text.push('[视频超出数量限制]');
    }
    else if (segment?.type === 'at') {
      const qq = String(segment.data?.qq ?? '');
      text.push(qq === 'all' ? '[@全体成员]' : /^[0-9]{1,15}$/.test(qq) ? '[@' + qq + ']' : '[@成员]');
    } else if (segment?.type === 'reply') text.push('[引用消息]');
    else if (segment?.type === 'face' || segment?.type === 'mface') text.push('[表情]');
    else return null;
  }
  return { text: text.join('').trim(), media };
}

function decodeImage(bytes) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
  let extension;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) extension = 'png';
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) extension = 'jpg';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') extension = 'webp';
  return extension ? { bytes, extension } : null;
}

async function localBytes(value, maxBytes) {
  try {
    const root = await realpath(snowLumaDirectory());
    const file = await realpath(value);
    const inside = relative(root, file);
    if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) return null;
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) return null;
    return await readFile(file);
  } catch { return null; }
}

async function imageBytes(data) {
  const value = data?.base64 ?? data?.data ?? data?.file;
  if (typeof value !== 'string') return null;
  if (isAbsolute(value)) {
    const bytes = await localBytes(value, MAX_IMAGE_BYTES);
    return bytes ? decodeImage(bytes) : null;
  }
  const encoded = value.startsWith('base64://') ? value.slice(9)
    : /^data:image\/(?:png|jpe?g|webp);base64,/i.test(value) ? value.slice(value.indexOf(',') + 1)
    : value;
  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  return decodeImage(Buffer.from(encoded, 'base64'));
}

async function audioBytes(data) {
  const value = data?.base64 ?? data?.data ?? data?.file;
  if (typeof value !== 'string') return null;
  if (isAbsolute(value)) return localBytes(value, MAX_AUDIO_BYTES);
  const encoded = value.startsWith('base64://') ? value.slice(9) : value;
  if (encoded.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  return Buffer.from(encoded, 'base64');
}

async function fetchImage(url) {
  const safe = safeImageUrl(url);
  if (!safe) return null;
  const response = await fetch(safe, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok || Number(response.headers.get('content-length') || 0) > MAX_IMAGE_BYTES) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) { await response.body.cancel().catch(() => {}); return null; }
    chunks.push(chunk);
  }
  return decodeImage(Buffer.concat(chunks, size));
}

async function fetchVideo(url) {
  const safe = safeImageUrl(url);
  if (!safe) return null;
  const response = await fetch(safe, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  const limit = 30 * 1024 * 1024;
  if (!response.ok || Number(response.headers.get('content-length') || 0) > limit) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function resolveMessageMedia(incoming, oneBotAction, { transcribe = recognizeSpeech } = {}) {
  let text = incoming.text;
  const images = [];
  let totalBytes = 0;
  const markers = new Set((incoming.media ?? []).filter((item) => item.type === 'image').map((item) => item.marker));
  text = text.replace(/\[图片(\d+)\]/g, (marker, number) => markers.has(marker) ? marker : '[图片' + number + '未加载]');
  if (!(incoming.media ?? []).some((item) => item.type === 'record')) text = text.replaceAll('[语音]', '[语音未转写]');
  if (!(incoming.media ?? []).some((item) => item.type === 'video')) text = text.replaceAll('[视频]', '[视频未加载]');
  for (const item of incoming.media ?? []) {
    if (item.type === 'image') {
      let image, result;
      try { if (item.file) { result = await oneBotAction('get_image', { file: item.file }); image = await imageBytes(result); } } catch {}
      for (const url of [result?.url, item.url]) {
        if (image) break;
        try { if (url) image = await fetchImage(url); } catch {}
      }
      if (image && images.length < MAX_IMAGES && totalBytes + image.bytes.length <= MAX_TOTAL_IMAGE_BYTES) {
        totalBytes += image.bytes.length;
        images.push(image);
        text = text.replace(item.marker, item.marker.slice(0, -1) + '（附件' + images.length + '）]');
      } else text = text.replace(item.marker, item.marker.slice(0, -1) + (image ? '总大小超限]' : '获取失败]'));
    } else if (item.type === 'video') {
      let result;
      try {
        const bytes = await fetchVideo(item.url);
        result = bytes ? await videoFrames(bytes) : { error: '视频获取失败' };
        if (bytes && result.images) {
          try { result.audio = await transcribe(bytes, { kind: 'video' }); } catch {}
        }
      } catch { result = { error: '视频获取失败' }; }
      if (result.images && images.length + result.images.length <= MAX_IMAGES && totalBytes + result.images.reduce((sum, image) => sum + image.bytes.length, 0) <= MAX_TOTAL_IMAGE_BYTES) {
        const first = images.length + 1;
        images.push(...result.images);
        totalBytes += result.images.reduce((sum, image) => sum + image.bytes.length, 0);
        text = text.replace('[视频]', '[视频：' + Math.ceil(result.duration) + '秒，抽帧为附件' + first + '至' + images.length + (result.audio?.text ? '；音轨转写（可能有误）：' + result.audio.text : '；声音未识别') + ']');
      } else text = text.replace('[视频]', '[' + (result.error || '视频抽帧超过图片限制') + ']');
    } else if (item.type === 'record') {
      let transcript;
      try {
        const result = await oneBotAction('fetch_ptt_text', { message_id: incoming.messageId });
        if (typeof result?.text === 'string' && result.text.trim()) transcript = result.text.trim().slice(0, 2000);
      } catch {}
      if (!transcript && item.file) {
        try {
          const result = await oneBotAction('get_record', { file: item.file, out_format: 'wav' });
          const bytes = await audioBytes(result);
          if (bytes?.length) {
            const recognized = await transcribe(bytes);
            if (typeof recognized?.text === 'string') transcript = recognized.text.trim().slice(0, 2000);
          }
        } catch {}
      }
      text = text.replace('[语音]', transcript ? '[语音转写：' + transcript + ']' : '[语音转写不可用]');
    }
  }
  return { text, images };
}
