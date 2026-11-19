import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewVoice, synthesize, health } from '../plugin/src/voice.mjs';
import { normalizeWav } from '../plugin/src/voice-wav.mjs';

function fixture({ seconds = 0.1, streaming = false } = {}) {
  const bytes = Math.round(seconds * 24000) * 2, wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(streaming ? 0xffffffff : wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(streaming ? 0xffffffff : bytes, 40);
  return wav;
}

test('voice preview sends custom text only to the selected voice service', async () => {
  const original = globalThis.fetch;
  const calls = [];
  const wav = fixture();
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/voices')) return Response.json({ voices: [{ id: 'test' }] });
    return new Response(wav);
  };
  try {
    assert.deepEqual(await previewVoice({ pack: 'cloud', voiceId: 'test', language: 'zh-CN', text: '这是试听。' }), wav);
    assert.equal(calls[1].url, 'http://127.0.0.1:8767/v1/speak/file');
    assert.equal(JSON.parse(calls[1].options.body).text, '这是试听。');
    await assert.rejects(previewVoice({ pack: 'cloud', voiceId: 'test', text: 'a'.repeat(301) }), /试听文本/);
  } finally { globalThis.fetch = original; }
});

test('Breeze adapts array catalogs and native style fields, repairs streaming WAV lengths', async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/voices')) return Response.json([{ id: 'saved', description: 'Saved voice' }]);
    return new Response(fixture({ streaming: true }));
  };
  try {
    const result = await synthesize({ providerId: 'breeze', voiceId: 'saved', text: '数字一二三。', style: { instruction: 'Warm delivery.', seed: 104, cfgScale: 1.5 } });
    assert.equal(result.status, 'audio');
    assert.equal(calls[1].url, 'http://127.0.0.1:7860/v1/audio/speech');
    const sent = JSON.parse(calls[1].options.body);
    assert.equal(sent.voice, 'saved'); assert.equal(sent.instructions, 'Warm delivery.');
    assert.equal(sent.seed, 104); assert.equal(sent.cfg_scale, 1.5); assert.equal(sent.response_format, 'wav');
    assert.equal(sent.speed, undefined);
    assert.equal(result.audio.readUInt32LE(4), result.audio.length - 8);
    assert.equal(result.audio.readUInt32LE(40), result.audio.length - 44);
    assert.equal(result.metrics.durationMs, 100);
  } finally { globalThis.fetch = original; }
});

test('missing saved voice returns explicit text without silently using a design or cloud voice', async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url) => { calls.push(url); return Response.json([{ id: 'other' }]); };
  try {
    const result = await synthesize({ providerId: 'breeze', voiceId: 'missing', text: '保留文字。', fallback: { providerId: 'cloud', voiceId: 'other' } });
    assert.equal(result.status, 'text'); assert.equal(result.text, '保留文字。'); assert.match(result.reason, /未自动更换/);
    assert.equal(calls.length, 1);
    assert.ok(calls.every((url) => url.startsWith('http://127.0.0.1:7860/')));
  } finally { globalThis.fetch = original; }
});

test('an engine voice named design-neutral stays a real saved voice rather than the virtual design option', async () => {
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/v1/voices')) return Response.json([{ id: 'design-neutral' }]);
    sent = JSON.parse(options.body); return new Response(fixture({ streaming: true }));
  };
  try {
    assert.equal((await synthesize({ providerId: 'breeze', voiceId: 'design-neutral' })).status, 'audio');
    assert.equal(sent.voice, 'design-neutral');
    const fallback = await synthesize({ providerId: 'breeze', voiceId: 'missing', allowOnline: true, fallback: { providerId: 'invalid', voiceId: 'wrong' } });
    assert.equal(fallback.status, 'text'); assert.match(fallback.fallbackError, /有效/);
  } finally { globalThis.fetch = original; }
});

test('online fallback requires permission and an exact voice binding and reports the switch', async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes(':7860')) throw new Error('offline');
    return url.endsWith('/v1/voices') ? Response.json({ voices: ['bound-cloud'] }) : new Response(fixture());
  };
  const options = { providerId: 'breeze', voiceId: 'saved', text: '授权备选。', fallback: { providerId: 'cloud', voiceId: 'bound-cloud' } };
  try {
    assert.equal((await synthesize(options)).status, 'text');
    assert.equal(calls.some(({ url }) => url.includes(':8767')), false);
    calls.length = 0;
    const result = await synthesize({ ...options, allowOnline: true });
    assert.equal(result.status, 'audio'); assert.equal(result.fallbackUsed, true); assert.equal(result.voiceId, 'bound-cloud');
    assert.equal(result.primary.voiceId, 'saved'); assert.match(result.reason, /未响应/);
    assert.equal(JSON.parse(calls.at(-1).options.body).voice, 'bound-cloud');
    const missing = await synthesize({ ...options, allowOnline: true, fallback: { providerId: 'cloud', voiceId: 'unloaded' } });
    assert.equal(missing.status, 'text'); assert.match(missing.fallbackError, /未自动更换/);
  } finally { globalThis.fetch = original; }
});

test('WAV validation rejects fake, truncated, unaligned, over-duration and ordinary mismatched files', () => {
  assert.throws(() => normalizeWav(Buffer.alloc(44)), /WAV/);
  assert.throws(() => normalizeWav(fixture().subarray(0, 100)), /WAV/);
  assert.throws(() => normalizeWav(fixture({ streaming: true })), /WAV/);
  const malformed = fixture(); malformed.writeUInt32LE(1, 28);
  assert.throws(() => normalizeWav(malformed), /WAV/);
  assert.throws(() => normalizeWav(fixture({ seconds: 60.01 })), /60 秒/);
  const odd = fixture({ streaming: true }).subarray(0, 45);
  assert.throws(() => normalizeWav(odd, { streaming: true }), /WAV/);
});

test('synthesis bounds the response body, including unknown content lengths', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => url.endsWith('/v1/voices') ? Response.json([]) : new Response(Buffer.alloc(5 * 1024 * 1024 + 1));
  try { const result = await synthesize({ providerId: 'breeze', voiceId: '@design' }); assert.equal(result.status, 'text'); assert.match(result.reason, /大小/); }
  finally { globalThis.fetch = original; }
});

test('body timeout and caller cancellation release the provider slot and never start a cloud fallback', async () => {
  const original = globalThis.fetch, calls = [];
  let entered, release;
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/v1/voices')) return Response.json([]);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(fixture({ streaming: true }).subarray(0, 44)); entered?.(); }, cancel() { release?.(); } }));
  };
  const options = { providerId: 'breeze', voiceId: '@design', allowOnline: true, fallback: { providerId: 'cloud', voiceId: 'bound' } };
  try {
    const controller = new AbortController();
    const started = new Promise((resolve) => { entered = resolve; });
    const pending = synthesize({ ...options, signal: controller.signal });
    await started;
    assert.equal((await synthesize(options)).code, 'busy');
    controller.abort();
    assert.equal((await pending).code, 'cancelled');
    entered = undefined;
    const timer = setTimeout(() => {}, 1000);
    try { assert.equal((await synthesize({ ...options, timeoutMs: 100 })).code, 'timeout'); }
    finally { clearTimeout(timer); }
    assert.equal(calls.some((url) => url.includes(':8767')), false);
    globalThis.fetch = async (url) => url.endsWith('/v1/voices') ? Response.json([]) : new Response(fixture({ streaming: true }));
    assert.equal((await synthesize(options)).status, 'audio');
  } finally { globalThis.fetch = original; }
});

test('health requires a provider-specific response and never claims synthesis success', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => Response.json(url.endsWith('/health') ? { status: 'ok', sample_rate: 24000 } : []);
    assert.equal((await health('breeze')).healthy, true);
    globalThis.fetch = async () => Response.json({ status: 'ok' });
    assert.equal((await health('breeze')).healthy, false);
  } finally { globalThis.fetch = original; }
});
