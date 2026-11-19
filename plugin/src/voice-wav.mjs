export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 60;

// Streaming Breeze headers advertise an unknown length; only their size fields may be repaired.
export function normalizeWav(input, { streaming = false } = {}) {
  const audio = Buffer.from(input);
  const fail = () => { throw new Error('语音服务未返回完整有效的 PCM WAV。'); };
  if (audio.length < 44 || audio.length > MAX_AUDIO_BYTES || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') fail();
  const marker = (size) => size === 0xffffffff || size === 0x7fffffff;
  const riffSize = audio.readUInt32LE(4);
  if (riffSize !== audio.length - 8 && !(streaming && marker(riffSize))) fail();
  let offset = 12, format, data;
  while (offset + 8 <= audio.length) {
    const id = audio.toString('ascii', offset, offset + 4);
    let size = audio.readUInt32LE(offset + 4);
    if (id === 'data' && streaming && marker(size)) {
      size = audio.length - offset - 8;
      audio.writeUInt32LE(size, offset + 4);
    }
    if (offset + 8 + size > audio.length) fail();
    if (id === 'fmt ') {
      if (format || size < 16 || audio.readUInt16LE(offset + 8) !== 1) fail();
      const channels = audio.readUInt16LE(offset + 10), sampleRate = audio.readUInt32LE(offset + 12);
      const byteRate = audio.readUInt32LE(offset + 16), align = audio.readUInt16LE(offset + 20), bits = audio.readUInt16LE(offset + 22);
      if (![1, 2].includes(channels) || bits !== 16 || sampleRate < 8000 || sampleRate > 48000 || align !== channels * 2 || byteRate !== sampleRate * align) fail();
      format = { channels, sampleRate, byteRate, align };
    }
    if (id === 'data') { if (data || !size) fail(); data = { size, offset: offset + 8 }; }
    offset += 8 + size + (size % 2);
  }
  if (offset !== audio.length || !format || !data || data.size % format.align) fail();
  const durationMs = data.size / format.byteRate * 1000;
  if (durationMs > MAX_AUDIO_SECONDS * 1000) throw new Error('试听音频超过 60 秒。');
  audio.writeUInt32LE(audio.length - 8, 4);
  return { audio, durationMs, sampleRate: format.sampleRate, channels: format.channels, dataOffset: data.offset };
}

export function wavDataOffset(prefix) {
  if (prefix.length < 12 || prefix.toString('ascii', 0, 4) !== 'RIFF') return null;
  let offset = 12;
  while (offset + 8 <= prefix.length) {
    if (prefix.toString('ascii', offset, offset + 4) === 'data') return offset + 8;
    offset += 8 + prefix.readUInt32LE(offset + 4) + (prefix.readUInt32LE(offset + 4) % 2);
  }
  return null;
}
