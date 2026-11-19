import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const data = await mkdtemp(join(tmpdir(), 'surfcore-media-'));
process.env.SURFCORE_DATA_DIR = data;
const { parseMediaSegments, resolveMessageMedia, safeImageUrl } = await import('../plugin/src/qq-media.mjs');
const { createMessageHandler, sampleEvent, startOneBot, readRecordJson } = await import('../plugin/src/bridge.mjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl8sAAAAASUVORK5CYII=', 'base64');

test('resolves images and voice using OneBot and records failures honestly', async () => {
  const parsed = parseMediaSegments([{ type: 'text', data: { text: '看一下' } }, { type: 'image', data: { file: 'image.png' } }, { type: 'record', data: {} }]);
  const calls = [];
  const result = await resolveMessageMedia({ ...parsed, messageId: '12' }, async (action, body) => {
    calls.push([action, body]);
    return action === 'get_image' ? { file: 'base64://' + png.toString('base64') } : { text: '你好' };
  });
  assert.equal(result.text, '看一下[图片1（附件1）][语音转写：你好]');
  assert.deepEqual(result.images[0], { bytes: png, extension: 'png' });
  assert.deepEqual(calls.map(([action]) => action), ['get_image', 'fetch_ptt_text']);
  const failed = await resolveMessageMedia({ ...parsed, messageId: '12' }, async () => { throw new Error('unavailable'); });
  assert.equal(failed.text, '看一下[图片1获取失败][语音转写不可用]');
  assert.deepEqual(failed.images, []);
});

test('uses local recognition only after QQ transcription fails', async () => {
  const parsed = parseMediaSegments([{ type: 'record', data: { file: 'voice.wav' } }]);
  const calls = [];
  const result = await resolveMessageMedia({ ...parsed, messageId: '12' }, async (action) => {
    calls.push(action);
    if (action === 'fetch_ptt_text') throw new Error('unavailable');
    return { base64: Buffer.from('sample audio').toString('base64') };
  }, { transcribe: async (data) => { assert.equal(data.toString(), 'sample audio'); return { text: '本地识别结果' }; } });
  assert.equal(result.text, '[语音转写：本地识别结果]');
  assert.deepEqual(calls, ['fetch_ptt_text', 'get_record']);
});

test('voice file fallback accepts only files within the gateway directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surfcore-gateway-'));
  const previous = process.env.SURFCORE_SNOWLUMA_DIR;
  const file = join(root, 'voice.wav');
  const outside = join(data, 'outside.wav');
  try {
    process.env.SURFCORE_SNOWLUMA_DIR = root;
    await writeFile(file, 'gateway audio');
    await writeFile(outside, 'outside audio');
    const incoming = { ...parseMediaSegments([{ type: 'record', data: { file: 'voice.wav' } }]), messageId: '12' };
    let count = 0;
    const transcribe = async (bytes) => { count++; assert.equal(bytes.toString(), 'gateway audio'); return { text: '识别成功' }; };
    const resolve = (path) => resolveMessageMedia(incoming, async (action) => action === 'get_record' ? { file: path } : {}, { transcribe });
    assert.equal((await resolve(file)).text, '[语音转写：识别成功]');
    assert.equal((await resolve(outside)).text, '[语音转写不可用]');
    assert.equal(count, 1);
  } finally {
    if (previous === undefined) delete process.env.SURFCORE_SNOWLUMA_DIR; else process.env.SURFCORE_SNOWLUMA_DIR = previous;
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects untrusted paths, malformed images and excess input', async () => {
  assert.equal(safeImageUrl('http://gchat.qpic.cn/image'), null);
  assert.equal(safeImageUrl('https://gchat.qpic.cn.evil.test/image'), null);
  assert.equal(safeImageUrl('https://gchat.qpic.cn/image'), 'https://gchat.qpic.cn/image');
  const parsed = parseMediaSegments([{ type: 'image', data: { file: '../secret' } }, { type: 'video', data: {} }]);
  let called = false;
  const result = await resolveMessageMedia({ ...parsed, messageId: '1' }, async () => { called = true; });
  assert.equal(called, false);
  assert.equal(result.text, '[图片1获取失败][视频获取失败]');
  const invalid = await resolveMessageMedia({ ...parseMediaSegments([{ type: 'image', data: { file: 'ok.png' } }]), messageId: '1' }, async () => ({ file: 'base64://' + Buffer.from('secret').toString('base64') }));
  assert.equal(invalid.images.length, 0);
  const many = parseMediaSegments(Array.from({ length: 5 }, () => ({ type: 'image', data: { file: 'ok.png' } })));
  assert.equal(many.media.length, 4);
  assert.match(many.text, /超出数量限制/);
});

test('keeps common message segments and associates successful images with attachment order', async () => {
  const parsed = parseMediaSegments([
    { type: 'reply', data: { id: '123' } }, { type: 'at', data: { qq: '12345' } },
    { type: 'face', data: { id: 1 } }, { type: 'mface', data: {} },
    { type: 'image', data: { file: 'first.png' } }, { type: 'image', data: { file: 'second.png' } },
  ]);
  const result = await resolveMessageMedia({ ...parsed, messageId: '1' }, async (_action, { file }) =>
    file === 'first.png' ? {} : { data: png.toString('base64') });
  assert.equal(result.text, '[引用消息][@12345][表情][表情][图片1获取失败][图片2（附件1）]');
  assert.equal(result.images.length, 1);
  assert.equal(parseMediaSegments([{ type: 'at', data: { qq: '[伪造]' } }]).text, '[@成员]');
  const dataUrl = await resolveMessageMedia({ ...parseMediaSegments([{ type: 'image', data: { file: 'one.png' } }]), messageId: '2' },
    async () => ({ data: 'data:image/png;base64,' + png.toString('base64') }));
  assert.equal(dataUrl.images.length, 1);
  const plainFile = await resolveMessageMedia({ ...parseMediaSegments([{ type: 'image', data: { file: 'one.png' } }]), messageId: '3' },
    async () => ({ file: png.toString('base64') }));
  assert.equal(plainFile.images.length, 1);
});

test('tries the event image URL when the gateway URL is unusable', async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); return new Response(png); };
  try {
    const parsed = parseMediaSegments([{ type: 'image', data: { file: 'ok.png', url: 'https://gchat.qpic.cn/valid' } }]);
    const result = await resolveMessageMedia({ ...parsed, messageId: '1' }, async () => ({ url: 'https://example.com/not-allowed' }));
    assert.deepEqual(calls, ['https://gchat.qpic.cn/valid']);
    assert.equal(result.images.length, 1);
  } finally { globalThis.fetch = previous; }
});

test('caps aggregate image bytes and identifies skipped images', async () => {
  const large = Buffer.alloc(4 * 1024 * 1024 + 1);
  png.copy(large);
  const parsed = parseMediaSegments([{ type: 'image', data: { file: 'one.png' } }, { type: 'image', data: { file: 'two.png' } }]);
  const result = await resolveMessageMedia({ ...parsed, messageId: '1' }, async () => ({ data: large.toString('base64') }));
  assert.equal(result.images.length, 1);
  assert.equal(result.text, '[图片1（附件1）][图片2总大小超限]');
});

test('OneBot preview processes image and speech without sending messages', { timeout: 8000 }, async () => {
  const calls = [], previews = [];
  let socket;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push({ path: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/get_login_info') res.end(JSON.stringify({ retcode: 0, data: { user_id: 10001 } }));
    else if (req.url === '/get_image') res.end(JSON.stringify({ retcode: 0, data: { file: 'base64://' + png.toString('base64') } }));
    else if (req.url === '/fetch_ptt_text') res.end(JSON.stringify({ retcode: 0, data: { text: '听到了' } }));
    else res.end(JSON.stringify({ retcode: 1 }));
  });
  server.on('upgrade', (req, conn) => {
    socket = conn;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    conn.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const event = { ...sampleEvent('unused', 808), message: [{ type: 'image', data: { file: 'sample.png' } }, { type: 'record', data: {} }] };
    const payload = Buffer.from(JSON.stringify(event)), header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
    conn.write(Buffer.concat([header, payload]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let received;
  const run = startOneBot({ owner: '10002', selfId: '10001', wsUrl: 'ws://127.0.0.1:' + port, httpUrl: 'http://127.0.0.1:' + port,
    send: false, generate: async (input) => { received = input; return '预览'; }, onEvent: (event) => { if (event.type === 'preview') previews.push(event); } });
  try {
    const deadline = Date.now() + 3000;
    while (!previews.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(previews.length, 1);
    assert.equal(received.mediaImages.length, 1);
    assert.match(received.message, /语音转写：听到了/);
    assert.deepEqual(calls.map(({ path }) => path), ['/get_login_info', '/get_image', '/fetch_ptt_text']);
    socket.write(Buffer.from([0x88, 2, 0x03, 0xe8])); socket.end();
    await run;
  } finally { socket?.destroy(); server.close(); }
});

test('OneBot get_record rejects oversized JSON before reading the audio payload', { timeout: 8000 }, async () => {
  const calls = [], previews = [];
  let socket;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/get_login_info') res.end(JSON.stringify({ retcode: 0, data: { user_id: 10001 } }));
    else if (req.url === '/fetch_ptt_text') res.end(JSON.stringify({ retcode: 1 }));
    else if (req.url === '/get_record') {
      res.setHeader('Content-Length', String(42 * 1024 * 1024 + 1));
      res.end('{}');
    } else res.end(JSON.stringify({ retcode: 1 }));
  });
  server.on('upgrade', (req, conn) => {
    socket = conn;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    conn.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const event = { ...sampleEvent('unused', 809), message: [{ type: 'record', data: { file: 'oversized.ogg' } }] };
    const payload = Buffer.from(JSON.stringify(event)), header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
    conn.write(Buffer.concat([header, payload]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let received;
  const run = startOneBot({ owner: '10002', selfId: '10001', wsUrl: 'ws://127.0.0.1:' + port, httpUrl: 'http://127.0.0.1:' + port,
    send: false, generate: async (input) => { received = input; return '预览'; }, onEvent: (event) => { if (event.type === 'preview') previews.push(event); } });
  try {
    const deadline = Date.now() + 3000;
    while (!previews.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(previews.length, 1);
    assert.match(received.message, /语音转写不可用/);
    assert.deepEqual(calls, ['/get_login_info', '/fetch_ptt_text', '/get_record']);
    socket.write(Buffer.from([0x88, 2, 0x03, 0xe8])); socket.end();
    await run;
  } finally { socket?.destroy(); server.close(); }
});

test('OneBot get_record cancels an oversized streaming response without a length header', async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readRecordJson(new Response(stream)), /响应过大/);
  assert.equal(cancelled, true);
  assert.deepEqual(await readRecordJson(new Response('{"retcode":0,"data":{"file":"x"}}')), { retcode: 0, data: { file: 'x' } });
});

test('OneBot local files are confined to the configured SnowLuma root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surfcore-media-root-'));
  const inside = join(root, 'image.png'), outside = join(data, 'outside.png');
  await writeFile(inside, png); await writeFile(outside, png);
  const old = process.env.SURFCORE_SNOWLUMA_DIR;
  process.env.SURFCORE_SNOWLUMA_DIR = root;
  try {
    const parsed = parseMediaSegments([{ type: 'image', data: { file: 'one.png' } }]);
    assert.equal((await resolveMessageMedia({ ...parsed, messageId: '1' }, async () => ({ file: inside }))).images.length, 1);
    assert.equal((await resolveMessageMedia({ ...parsed, messageId: '1' }, async () => ({ file: outside }))).images.length, 0);
    assert.deepEqual(await readFile(outside), png);
  } finally { if (old === undefined) delete process.env.SURFCORE_SNOWLUMA_DIR; else process.env.SURFCORE_SNOWLUMA_DIR = old; }
});

test('only authorized messages reach the media resolver and model', async () => {
  const calls = [], deliveries = [];
  const handler = createMessageHandler({ owner: '10002', selfId: '10001', simulated: true,
    resolveMedia: async (item) => { calls.push(item); return resolveMessageMedia(item, async () => ({ file: 'base64://' + png.toString('base64') })); },
    generate: async (input) => { calls.push(input); return '收到'; }, deliver: async (...args) => deliveries.push(args) });
  const event = { ...sampleEvent('unused', 123), message: [{ type: 'image', data: { file: 'safe.png' } }] };
  assert.equal(await handler({ ...event, user_id: 10003 }), null);
  assert.equal(calls.length, 0);
  await handler(event);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].mediaImages.length, 1);
  assert.equal(deliveries.length, 1);
  await handler.close();
});

test('group media requires current session consent and an allowed group', async () => {
  let resolutions = 0;
  const handler = createMessageHandler({ owner: '10002', selfId: '10001', groups: ['10004'], simulated: true, social: { enabled: true, botName: '知微', probability: 0 },
    resolveMedia: async (item) => { resolutions++; return { text: item.text, images: [] }; },
    generate: async () => '{"action":"speak","text":"收到"}', deliver: async () => {} });
  const event = { ...sampleEvent('unused', 124), user_id: 10003, message_type: 'group', group_id: 10004,
    message: [{ type: 'at', data: { qq: 10001 } }, { type: 'image', data: { file: 'safe.png' } }] };
  assert.equal(await handler(event), null);
  assert.equal(resolutions, 0);
  await handler(sampleEvent('同意群聊', 125));
  assert.equal(await handler({ ...event, group_id: 10005, message_id: 126 }), null);
  assert.equal(resolutions, 0);
  await handler({ ...event, message_id: 127 });
  assert.equal(resolutions, 1);
  await handler(sampleEvent('撤销群聊', 128));
  assert.equal(await handler({ ...event, message_id: 129 }), null);
  assert.equal(resolutions, 1);
  await handler.close();
});

test('media lost from a restored waiter is explicitly marked unavailable', async () => {
  const result = await resolveMessageMedia({ text: '[图片1][语音]', messageId: '10' }, async () => { assert.fail('no media reference should be fetched'); });
  assert.equal(result.text, '[图片1未加载][语音未转写]');
});
