import { snowLumaDirectory } from './local-installation.mjs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { videoFrames } from './video-frames.mjs';
import { recognizeSpeech } from './speech-recognition.mjs';
import { previewSticker } from './qq-sticker-preview.mjs';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
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

function qqImageUrl(value) {
  const secure = safeImageUrl(value);
  if (secure || typeof value !== 'string' || value.length > 4096) return secure;
  try {
    const url = new URL(value);
    // SnowLuma emits HTTP for the classic QQ image service, which also supports TLS.
    if (url.protocol !== 'http:' || url.hostname !== 'gchat.qpic.cn' || url.port || url.username || url.password ||
        !/^\/(?:gchatpic_new|offpic_new)\//.test(url.pathname)) return null;
    url.protocol = 'https:';
    return safeImageUrl(url.href);
  } catch { return null; }
}

const MARKET_STICKER_ROOT = 'https://gxh.vip.qq.com/club/item/parcel/item/';

function safeMarketStickerUrl(value, emojiId) {
  if (typeof value !== 'string' || !value.startsWith(MARKET_STICKER_ROOT)) return null;
  const match = /^([a-fA-F0-9]{2})\/([a-fA-F0-9]{32})\/raw300\.gif$/.exec(value.slice(MARKET_STICKER_ROOT.length));
  if (!match || match[1] !== match[2].slice(0, 2) || (emojiId && match[2].toLowerCase() !== emojiId.toLowerCase())) return null;
  return value;
}

export function parseMediaSegments(segments) {
  const media = [];
  const text = [];
  let imageCount = 0;
  for (const segment of segments) {
    if (segment?.type === 'text' && typeof segment.data?.text === 'string') text.push(segment.data.text);
    else if (segment?.type === 'image' || segment?.type === 'mface') {
      const data = segment.data;
      const file = safeImageReference(data?.file) ? data.file : null;
      const url = qqImageUrl(data?.url) ?? qqImageUrl(data?.file);
      const emojiId = typeof data?.emoji_id === 'string' && /^[a-f0-9]{32}$/i.test(data.emoji_id) ? data.emoji_id : null;
      const marketUrl = emojiId && safeMarketStickerUrl(data.url ||
        (segment.type === 'mface' && MARKET_STICKER_ROOT + emojiId.slice(0, 2) + '/' + emojiId + '/raw300.gif'), emojiId);
      const sticker = segment.type === 'mface' || emojiId ||
        ((data?.sub_type === 1 || data?.sub_type === '1') && typeof data.summary === 'string' && data.summary.trim());
      if (segment.type === 'mface' && !marketUrl && !url && !file) text.push('[表情]');
      else if (imageCount === MAX_IMAGES) text.push('[图片超出数量限制]');
      else {
        const marker = '[图片' + (++imageCount) + ']';
        media.push({ type: 'image', marker, file, url, ...(sticker && { sticker: true }), ...(marketUrl && { marketUrl }) });
        text.push(marker);
      }
    } else if (segment?.type === 'record') {
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
    else if (segment?.type === 'face') text.push('[表情]');
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
  else if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) extension = 'gif';
  return extension ? { bytes, extension } : null;
}

function needsFramePreview({ bytes, extension }) {
  if (extension === 'gif') return true;
  if (extension === 'png') {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'acTL' || type === 'fcTL') return true;
      if (type === 'IEND') break;
      offset += bytes.readUInt32BE(offset) + 12;
    }
  }
  if (extension === 'webp') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = bytes.toString('ascii', offset, offset + 4);
      if (type === 'ANIM' || type === 'ANMF' || (type === 'VP8X' && (bytes[offset + 8] & 2))) return true;
      const length = bytes.readUInt32LE(offset + 4);
      offset += 8 + length + (length % 2);
    }
  }
  return false;
}

function isInside(directory, file) {
  const path = relative(directory, file);
  return Boolean(path && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path));
}

async function localBytes(value, maxBytes) {
  try {
    const configuredRoot = snowLumaDirectory();
    const root = await realpath(configuredRoot);
    if (!isInside(configuredRoot, value) && !isInside(root, value)) return null;
    const file = await realpath(value);
    if (!isInside(root, file)) return null;
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) return null;
    const handle = await open(file, 'r');
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of handle.createReadStream({ start: 0, end: maxBytes, autoClose: false })) {
        length += chunk.length;
        if (length > maxBytes) return null;
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, length);
    } finally {
      await handle.close();
    }
  } catch { return null; }
}

async function imageBytes(data) {
  const value = data?.base64 ?? data?.data ?? data?.file;
  if (typeof value !== 'string') return null;
  const encoded = value.startsWith('base64://') ? value.slice(9)
    : /^data:image\/(?:apng|png|jpe?g|gif|webp);base64,/i.test(value) ? value.slice(value.indexOf(',') + 1)
    : value;
  if (encoded.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    const image = decodeImage(Buffer.from(encoded, 'base64'));
    if (image) return image;
  }
  const bytes = isAbsolute(value) ? await localBytes(value, MAX_IMAGE_BYTES) : null;
  return bytes ? decodeImage(bytes) : null;
}

async function audioBytes(data) {
  const value = data?.base64 ?? data?.data ?? data?.file;
  if (typeof value !== 'string') return null;
  if (isAbsolute(value)) return localBytes(value, MAX_AUDIO_BYTES);
  const encoded = value.startsWith('base64://') ? value.slice(9) : value;
  if (encoded.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  return Buffer.from(encoded, 'base64');
}

function signedImageType(url) {
  const query = url.searchParams;
  if (url.origin !== 'https://multimedia.nt.qq.com.cn' || url.pathname !== '/download' ||
      query.getAll('appid').length !== 1 || query.getAll('fileid').length !== 1 || !query.get('fileid')) return null;
  const app = query.get('appid');
  if (app === '1406') return 10;
  if (app === '1407') return 20;
  return null;
}

function currentImageKey(keys, type, previous) {
  if (!Array.isArray(keys)) return null;
  const now = Math.floor(Date.now() / 1000);
  let fallback = null;
  for (const key of keys) {
    if ((key?.type !== type && key?.type !== 2) || typeof key.rkey !== 'string' ||
        !Number.isSafeInteger(key.create_time) || key.create_time < 0 || !Number.isSafeInteger(key.ttl) || key.ttl < 0 ||
        (key.create_time || now) + (key.ttl || 3600) <= now) continue;
    const value = key.rkey.replace(/^[?&]rkey=/, '');
    if (value === previous || !/^[A-Za-z0-9+/_=-]{1,2048}$/.test(value)) continue;
    if (key.type === type) return value;
    fallback ??= value;
  }
  return fallback;
}

async function boundedResponseBytes(response, maxBytes, abort, keepPartial = false) {
  if (Number(response.headers.get('content-length') || 0) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return null;
  const chunks = [];
  let size = 0;
  let idleTimer;
  const expectChunk = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(abort, 15_000);
    idleTimer.unref();
  };
  try {
    expectChunk();
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) return null;
      chunks.push(chunk);
      expectChunk();
    }
  } catch (error) {
    if (!keepPartial) throw error;
  } finally { clearTimeout(idleTimer); }
  return Buffer.concat(chunks, size);
}

async function openImageDownload(value, deadline, headers) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const headerTimer = setTimeout(abort, 10_000);
  headerTimer.unref();
  try {
    const response = await fetch(value, { headers, redirect: 'error', signal: AbortSignal.any([deadline, controller.signal]) });
    return { response, abort };
  } finally { clearTimeout(headerTimer); }
}

async function downloadQQImageBytes(value, response, abort, deadline) {
  const total = Number(response.headers.get('content-length'));
  const encoding = response.headers.get('content-encoding');
  const resumable = response.status === 200 && !deadline.aborted && signedImageType(new URL(value)) &&
    response.headers.get('accept-ranges')?.toLowerCase() === 'bytes' && (!encoding || encoding === 'identity') &&
    Number.isSafeInteger(total) && total > 0 && total <= MAX_IMAGE_BYTES;
  const received = await boundedResponseBytes(response, MAX_IMAGE_BYTES, abort, resumable);
  if (!resumable || !received || received.length === total) return received;
  if (received.length > total || deadline.aborted) return null;

  const pieces = [received];
  const etag = response.headers.get('etag');
  for (let start = received.length; start < total;) {
    // Keep each follow-up smaller than the connection that was interrupted.
    const end = Math.min(start + 512 * 1024, total) - 1;
    const { response: part, abort: abortPart } = await openImageDownload(value, deadline, {
      Range: 'bytes=' + start + '-' + end,
      ...(etag?.startsWith('"') && { 'If-Range': etag }),
    });
    const partTag = part.headers.get('etag');
    const partEncoding = part.headers.get('content-encoding');
    if (part.status !== 206 || part.headers.get('content-range') !== 'bytes ' + start + '-' + end + '/' + total ||
        (etag && partTag && etag !== partTag) || (partEncoding && partEncoding !== 'identity')) {
      await part.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = await boundedResponseBytes(part, end - start + 1, abortPart);
    if (bytes?.length !== end - start + 1) return null;
    pieces.push(bytes);
    start = end + 1;
  }
  return Buffer.concat(pieces, total);
}

async function expiredImageUrl(response, abort) {
  if (response.status !== 400) return false;
  const bytes = await boundedResponseBytes(response, 4096, abort);
  try { return bytes !== null && JSON.parse(bytes.toString('utf8'))?.retcode === -5503007; }
  catch { return false; }
}

async function fetchImage(value, { market = false, readImageKeys, deadline }) {
  const safe = market ? safeMarketStickerUrl(value) : safeImageUrl(value);
  if (!safe) return null;
  let currentUrl = safe;
  let { response, abort } = await openImageDownload(currentUrl, deadline);
  if (!response.ok && readImageKeys) {
    const url = new URL(safe);
    const type = signedImageType(url);
    if (type && await expiredImageUrl(response, abort)) {
      const key = currentImageKey(await readImageKeys(), type, url.searchParams.get('rkey'));
      if (key) {
        url.searchParams.set('rkey', key);
        currentUrl = url.href;
        ({ response, abort } = await openImageDownload(currentUrl, deadline));
      }
    }
  }
  if (!response.ok) {
    if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
    return null;
  }
  const bytes = await downloadQQImageBytes(currentUrl, response, abort, deadline);
  return bytes ? decodeImage(bytes) : null;
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

export async function resolveMessageMedia(incoming, oneBotAction, {
  transcribe = recognizeSpeech, attachmentOffset = 0, stickerOffset = 0,
  maxImages = MAX_IMAGES, maxTotalImageBytes = MAX_TOTAL_IMAGE_BYTES, onImagesReady,
} = {}) {
  maxImages = Math.min(maxImages, MAX_IMAGES);
  maxTotalImageBytes = Math.min(maxTotalImageBytes, MAX_TOTAL_IMAGE_BYTES);
  let text = incoming.text;
  const images = [];
  const stickers = [];
  let currentKeys;
  let imageDeadline;
  const readImageKeys = () => currentKeys ??= Promise.resolve()
    .then(() => oneBotAction('get_rkey', {}, { timeout: 5_000 }))
    .catch(() => []);
  const downloadImage = (url, options = {}) => fetchImage(url, {
    ...options, readImageKeys, deadline: imageDeadline ??= AbortSignal.timeout(180_000),
  });
  let totalBytes = 0;
  const markers = new Set((incoming.media ?? []).filter((item) => item.type === 'image').map((item) => item.marker));
  text = text.replace(/\[图片(\d+)\]/g, (marker, number) => markers.has(marker) ? marker : '[图片' + number + '未加载]');
  if (!(incoming.media ?? []).some((item) => item.type === 'record')) text = text.replaceAll('[语音]', '[语音未转写]');
  if (!(incoming.media ?? []).some((item) => item.type === 'video')) text = text.replaceAll('[视频]', '[视频未加载]');
  const media = incoming.media ?? [];
  const lastImage = media.findLastIndex(({ type }) => type === 'image');
  for (const [index, item] of media.entries()) {
    if (item.type === 'image') {
      try {
        let image, result;
        if (images.length >= maxImages || totalBytes >= maxTotalImageBytes) {
          text = text.replace(item.marker, item.marker.slice(0, -1) + '总大小超限]');
          continue;
        }
        try { if (item.marketUrl) image = await downloadImage(item.marketUrl, { market: true }); } catch {}
        try { if (!image && item.file) { result = await oneBotAction('get_image', { file: item.file }); image = await imageBytes(result); } } catch {}
        const urls = new Set([result?.url, result?.file, item.url].map(qqImageUrl).filter(Boolean));
        for (const url of urls) {
          if (image) break;
          try { image = await downloadImage(url); } catch {}
        }
        const framePreview = image && needsFramePreview(image);
        if (image && (framePreview || item.sticker)) {
          const preview = await previewSticker(image.bytes, image.extension, {
            maxImages: maxImages - images.length, maxTotalImageBytes: maxTotalImageBytes - totalBytes,
          });
          if (preview) {
            const first = attachmentOffset + images.length + 1;
            images.push(...preview.images);
            totalBytes += preview.images.reduce((sum, { bytes }) => sum + bytes.length, 0);
            const last = attachmentOffset + images.length;
            const attachment = '附件' + first + (last === first ? '' : '至' + last);
            const animated = preview.frameCount > 1;
            let label = animated ? (preview.complete ? '动图完整预览' : '动图部分预览') : '表情预览';
            label += '，' + attachment;
            if (animated) {
              label += '，' + (preview.complete ? '共' + preview.frameCount : '前' + preview.shownFrames + '/' + preview.frameCount) +
                '帧，按附件顺序逐行阅读，每行从左到右，格内标有帧号及时长（如有）';
            }
            if (preview.complete && (item.sticker || animated) && (!item.marketUrl || framePreview)) {
              stickers.push({ bytes: image.bytes, extension: image.extension, visualHash: preview.visualHash });
              label += '；可收藏表情' + (stickerOffset + stickers.length);
            }
            text = text.replace(item.marker, item.marker.slice(0, -1) + '（' + label + '）]');
            continue;
          }
          if (framePreview) {
            text = text.replace(item.marker, item.marker.slice(0, -1) + '（动图预览不可用）]');
            continue;
          }
        }
        if (image && totalBytes + image.bytes.length <= maxTotalImageBytes) {
          totalBytes += image.bytes.length;
          images.push(image);
          text = text.replace(item.marker, item.marker.slice(0, -1) + '（附件' + (attachmentOffset + images.length) + '）]');
        } else text = text.replace(item.marker, item.marker.slice(0, -1) + (image ? '总大小超限]' : '获取失败]'));
      } finally {
        if (index === lastImage) onImagesReady?.();
      }
    } else if (item.type === 'video') {
      let result;
      try {
        const bytes = await fetchVideo(item.url);
        result = bytes ? await videoFrames(bytes) : { error: '视频获取失败' };
        if (bytes && result.images) {
          try { result.audio = await transcribe(bytes, { kind: 'video' }); } catch {}
        }
      } catch { result = { error: '视频获取失败' }; }
      if (result.images && images.length + result.images.length <= maxImages && totalBytes + result.images.reduce((sum, image) => sum + image.bytes.length, 0) <= maxTotalImageBytes) {
        const first = attachmentOffset + images.length + 1;
        images.push(...result.images);
        totalBytes += result.images.reduce((sum, image) => sum + image.bytes.length, 0);
        text = text.replace('[视频]', '[视频：' + Math.ceil(result.duration) + '秒，抽帧为附件' + first + '至' + (attachmentOffset + images.length) + (result.audio?.text ? '；音轨转写（可能有误）：' + result.audio.text : '；声音未识别') + ']');
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
  return { text, images, ...(stickers.length && { stickers }) };
}
