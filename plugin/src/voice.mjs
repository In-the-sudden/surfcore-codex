import { cleanText } from './store.mjs';
import { readProvider, voiceBinding, validVoiceId, VOICE_PROVIDERS, DESIGN_VOICE, DESIGN_INSTRUCTION } from './voice-config.mjs';
import { normalizeWav, wavDataOffset, MAX_AUDIO_BYTES } from './voice-wav.mjs';

const SAMPLE_LINES = Object.freeze({ auto: '你好，今天过得怎么样？', 'zh-CN': '你好，今天过得怎么样？', 'yue-HK': '你好，今日過成點呀？', en: 'Hello. How has your day been?', ja: 'こんにちは。今日はどんな一日でしたか？' });
const active = new Set(), lastSynthesis = new Map();
export const synthesisStatus = (providerId) => lastSynthesis.get(providerId) || null;

async function request(config, path, options, signal) {
  signal.throwIfAborted();
  const token = process.env[config.tokenEnv];
  let response;
  try {
    response = await fetch(config.baseUrl + path, { ...options, redirect: 'error', signal,
      headers: { ...options?.headers, ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error('语音服务未响应（' + config.baseUrl + '）。请检查对应引擎。', { cause: error });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('语音服务返回 HTTP ' + response.status + '。请检查引擎、音色和凭据。');
  }
  return response;
}

async function readBounded(response, max, signal, onChunk = () => {}) {
  if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw new Error('语音响应超过允许大小。'); }
  if (!response.body) throw new Error('语音服务返回空响应。');
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.length;
      if (bytes > max) throw new Error('语音响应超过允许大小。');
      chunks.push(value); onChunk(value, bytes);
    }
    return Buffer.concat(chunks, bytes);
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function catalog(config, signal) {
  const response = await request(config, '/v1/voices', {}, signal);
  let data;
  try { data = JSON.parse((await readBounded(response, 512 * 1024, signal)).toString('utf8')); }
  catch (error) { if (signal.aborted) throw signal.reason; throw new Error('语音服务未返回有效音色列表。', { cause: error }); }
  const rows = config.kind === 'breeze' ? data : data?.voices;
  if (!Array.isArray(rows)) throw new Error('语音服务音色列表与所选 provider 不匹配。');
  const voices = rows.map((voice) => typeof voice === 'string' ? { id: voice } : voice)
    .filter((voice) => validVoiceId(voice?.id) && voice.id !== DESIGN_VOICE)
    .map(({ id, label, name, description }) => ({ id, label: String(label || name || description || id).slice(0, 120) }));
  if (config.kind === 'breeze') voices.push({ id: DESIGN_VOICE, label: '设计音色（未保存）' });
  if (!voices.length) throw new Error('这个语音包还没有可用音色。');
  return { providerId: config.providerId, voices, default: voices.some(({ id }) => id === data.default) ? data.default : voices[0].id };
}

export async function listVoices(providerId, { signal } = {}) {
  const deadline = AbortSignal.any([AbortSignal.timeout(3_000), ...(signal ? [signal] : [])]);
  return catalog(await readProvider(providerId), deadline);
}
export const loadVoices = listVoices;

export async function health(providerId) {
  try {
    const config = await readProvider(providerId), signal = AbortSignal.timeout(3_000);
    if (config.kind === 'breeze') {
      const response = await request(config, '/health', {}, signal);
      const data = JSON.parse((await readBounded(response, 8192, signal)).toString('utf8'));
      if (data.status !== 'ok' || data.sample_rate !== 24000) throw new Error('Breeze 健康响应与预期不符。');
    }
    const voices = await catalog(config, signal);
    return { healthy: true, method: config.kind === 'breeze' ? '/health + /v1/voices' : '/v1/voices', voices: voices.voices.length };
  } catch (error) { return { healthy: false, error: error.message }; }
}

async function generate(binding, text, signal, started) {
  const config = await readProvider(binding.providerId);
  const key = config.baseUrl;
  if (active.has(key) || active.size >= 2) { const error = new Error('语音合成忙，请稍后重试。'); error.code = 'busy'; throw error; }
  active.add(key);
  try {
    const { voices } = await catalog(config, signal);
    if (!voices.some(({ id }) => id === binding.voiceId)) throw new Error('选择的音色没有加载；未自动更换音色。');
    let body;
    if (config.kind === 'breeze') {
      body = { input: text, response_format: 'wav', stream_format: 'audio', seed: binding.style.seed ?? 42,
        cfg_scale: binding.style.cfgScale ?? 1, split_chars: 120, max_new_tokens: 750 };
      if (binding.voiceId !== DESIGN_VOICE) body.voice = binding.voiceId;
      const instruction = binding.style.instruction || (binding.voiceId === DESIGN_VOICE ? DESIGN_INSTRUCTION : '');
      if (instruction) body.instructions = instruction;
    } else {
      body = { text, voice: binding.voiceId, sr: 24000, format: 'wav', cache: false };
      if (Object.keys(binding.style).length) body.style = binding.style;
    }
    const response = await request(config, config.kind === 'breeze' ? '/v1/audio/speech' : '/v1/speak/file',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal);
    let firstAudioMs = null, prefix = Buffer.alloc(0), dataOffset = null;
    const bytes = await readBounded(response, MAX_AUDIO_BYTES, signal, (chunk, count) => {
      if (firstAudioMs !== null) return;
      if (dataOffset === null) { prefix = Buffer.concat([prefix, Buffer.from(chunk).subarray(0, Math.max(0, 8192 - prefix.length))]); dataOffset = wavDataOffset(prefix); }
      if (dataOffset !== null && count > dataOffset) firstAudioMs = performance.now() - started;
    });
    const wav = normalizeWav(bytes, { streaming: config.kind === 'breeze' });
    const metrics = { durationMs: wav.durationMs, bytes: wav.audio.length, sampleRate: wav.sampleRate, channels: wav.channels,
      firstAudioMs, totalMs: performance.now() - started };
    lastSynthesis.set(binding.providerId, { ok: true, at: new Date().toISOString(), voiceId: binding.voiceId, ...metrics });
    return { status: 'audio', ...binding, audio: wav.audio, metrics };
  } catch (error) {
    if (error.code !== 'busy') lastSynthesis.set(binding.providerId, { ok: false, at: new Date().toISOString(), error: signal.aborted ? '合成已取消或超时。' : error.message });
    throw error;
  } finally { active.delete(key); }
}

export async function synthesize(options) {
  const binding = voiceBinding({ ...options, providerId: options.providerId ?? options.pack });
  const text = options.text === undefined || options.text === '' ? SAMPLE_LINES[options.language] || SAMPLE_LINES.auto : cleanText(options.text, 300, '试听文本');
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('合成超时范围为 100 到 120000 毫秒。');
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
  const started = performance.now();
  try { return { ...await generate(binding, text, signal, started), fallbackUsed: false }; }
  catch (error) {
    const reason = signal.aborted ? (options.signal?.aborted ? '合成已取消。' : '合成超时。') : error.message;
    const code = signal.aborted ? (options.signal?.aborted ? 'cancelled' : 'timeout') : error.code || 'synthesis_failed';
    if (!signal.aborted && code !== 'busy' && options.allowOnline === true && options.fallback && !VOICE_PROVIDERS[binding.providerId].online) {
      try {
        const fallback = voiceBinding(options.fallback);
        if (!VOICE_PROVIDERS[fallback.providerId].online) throw new Error('备选必须是明确绑定的在线语音服务。');
        return { ...await generate(fallback, text, signal, started), fallbackUsed: true, primary: binding, reason };
      }
      catch (fallbackError) { return { status: 'text', text, ...binding, code, reason, fallbackUsed: false, fallbackError: signal.aborted ? '在线备选已超时或取消。' : fallbackError.message }; }
    }
    return { status: 'text', text, ...binding, code, reason, fallbackUsed: false };
  }
}

export async function previewVoice(options) {
  const result = await synthesize({ ...options, allowOnline: false, fallback: null });
  if (result.status !== 'audio') { const error = new Error(result.reason); error.code = result.code; throw error; }
  return result.audio;
}
