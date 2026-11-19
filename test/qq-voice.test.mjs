import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

function sampleWav() {
  const wav = Buffer.alloc(4844);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(4836, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(4800, 40);
  return wav;
}

async function until(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(15);
  }
}

test('QQ sends the saved voice only for explicit authorized requests and falls back before submission', { timeout: 12000 }, async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'surfcore-qq-voice-'));
  const previousDataDirectory = process.env.SURFCORE_DATA_DIR;
  const previousVoiceToken = process.env.SURFCORE_VOICE_BREEZE_TOKEN;
  process.env.SURFCORE_DATA_DIR = data;
  delete process.env.SURFCORE_VOICE_BREEZE_TOKEN;
  const { createMessageHandler, sampleEvent, startOneBot } = await import('../plugin/src/bridge.mjs');
  const { configureProvider } = await import('../plugin/src/voice-config.mjs');
  const { setVoice } = await import('../plugin/src/settings.mjs');
  const { readMemory } = await import('../plugin/src/store.mjs');
  const wav = sampleWav();
  const synthesis = [], sends = [], events = [], prompts = [];
  const controller = new AbortController();
  let socket, run, runError, failSynthesis = false, refuseRecord = false, beforeSynthesisResponse;
  let paused = false, generation = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/voices') {
      res.setHeader('Content-Type', 'application/json');
      res.end('[{"id":"saved-a"}]');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (req.url === '/v1/audio/speech') {
      synthesis.push(body);
      await beforeSynthesisResponse?.();
      res.statusCode = failSynthesis ? 503 : 200;
      res.end(failSynthesis ? '' : wav);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/get_login_info') {
      res.end('{"retcode":0,"data":{"user_id":10001}}');
      return;
    }
    if (req.url === '/get_msg') {
      const sent = sends[-body.message_id - 1];
      const group = sent?.path === '/send_group_msg';
      res.end(JSON.stringify(group ? { status: 'failed', retcode: 100 } : {
        status: 'ok', retcode: 0, data: { message_id: body.message_id, message_type: 'private', user_id: 10001,
          target_id: sent?.body.user_id, message: [{ type: 'record', data: {} }] },
      }));
      return;
    }
    sends.push({ path: req.url, body });
    const rejected = refuseRecord && body.message?.[0]?.type === 'record';
    res.end(JSON.stringify({ status: rejected ? 'failed' : 'ok', retcode: 0, data: { message_id: -sends.length } }));
  });
  server.on('upgrade', (req, connection) => {
    socket = connection;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  });
  t.after(async () => {
    controller.abort();
    socket?.destroy();
    await run;
    await new Promise((resolve) => server.close(resolve));
    if (previousDataDirectory === undefined) delete process.env.SURFCORE_DATA_DIR;
    else process.env.SURFCORE_DATA_DIR = previousDataDirectory;
    if (previousVoiceToken === undefined) delete process.env.SURFCORE_VOICE_BREEZE_TOKEN;
    else process.env.SURFCORE_VOICE_BREEZE_TOKEN = previousVoiceToken;
    await rm(data, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = '127.0.0.1:' + server.address().port;
  await configureProvider({ providerId: 'breeze', baseUrl: 'http://' + address });
  await setVoice('lin', 'breeze', 'saved-a', { style: { seed: 53 } });
  run = startOneBot({
    owner: '10002', selfId: '10001', groups: ['10004'], httpUrl: 'http://' + address, wsUrl: 'ws://' + address,
    send: true, social: { enabled: true }, signal: controller.signal,
    shouldContinue: () => !paused, generationToken: () => generation,
    onEvent: (event) => events.push(event),
    generate: async ({ message, decisionMode }) => {
      prompts.push(message);
      return decisionMode ? { action: 'speak', text: '群里好。' } : '你好呀。';
    },
  }).catch((error) => { runError = error; });
  await until(() => events.some(({ type }) => type === 'connected') || runError, 'bridge did not connect');
  if (runError) throw runError;

  function push(event) {
    const payload = Buffer.from(JSON.stringify(event));
    const frame = Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
    socket.write(Buffer.concat([frame, payload]));
  }
  function groupEvent(id, group_id, atBot = true) {
    const event = { ...sampleEvent('用语音回复：打个招呼。', id), message_type: 'group', user_id: 10003, group_id };
    if (atBot) event.message.unshift({ type: 'at', data: { qq: '10001' } });
    return event;
  }

  push(groupEvent(1, 10005));
  push(groupEvent(2, 10004));
  push(sampleEvent('普通消息里提到“用语音回复”。', 3));
  await until(() => sends.length >= 2, 'missing private reply and consent prompt');
  assert.ok(sends.every(({ path, body }) => path === '/send_private_msg' && body.message[0].type === 'text'));
  assert.equal(synthesis.length, 0);

  push(sampleEvent('用语音回复：打个招呼。', 4));
  await until(() => sends.length >= 3, 'missing private voice reply');
  assert.equal(prompts[1], '打个招呼。');
  assert.deepEqual(sends[2], { path: '/send_private_msg', body: {
    user_id: 10002, message: [{ type: 'record', data: { file: 'base64://' + wav.toString('base64') } }],
  } });
  assert.equal(synthesis[0].voice, 'saved-a');
  assert.equal(synthesis[0].seed, 53);
  assert.equal(synthesis[0].input, '你好呀。');
  await until(() => events.some(({ type }) => type === 'voiceVerified'), 'missing private record readback');

  push(sampleEvent('同意群聊', 5));
  await until(() => sends.length >= 4, 'missing group consent acknowledgement');
  assert.equal(sends[3].body.message[0].type, 'text');
  push(groupEvent(11, 10004, false));
  push(groupEvent(6, 10004));
  await until(() => sends.length >= 5, 'missing authorized group voice reply');
  assert.equal(sends[4].path, '/send_group_msg');
  assert.equal(sends[4].body.group_id, 10004);
  assert.equal(sends[4].body.message[0].type, 'record');
  assert.equal(JSON.parse(prompts[2]).wakeReason, 'atMention');
  assert.equal(JSON.parse(prompts[2]).unread.at(-1).text, '打个招呼。');
  await until(() => events.some(({ type }) => type === 'voiceUnverified'), 'readback failure was not reported');

  failSynthesis = true;
  push(sampleEvent('用语音回复：再打个招呼。', 7));
  await until(() => sends.length >= 6, 'missing text fallback');
  assert.deepEqual(sends[5].body.message, [{ type: 'text', data: { text: '你好呀。' } }]);
  assert.ok(events.some(({ type }) => type === 'voiceFallback'));

  failSynthesis = false;
  refuseRecord = true;
  push(sampleEvent('用语音回复', 8));
  await until(() => events.some(({ type }) => type === 'error'), 'missing transport failure');
  assert.equal(sends[6].body.message[0].type, 'record');
  assert.equal(sends.length, 7, 'ambiguous transport failure must never resend as text');

  let release;
  refuseRecord = false;
  beforeSynthesisResponse = () => new Promise((resolve) => { release = resolve; });
  push(sampleEvent('用语音回复：暂停期间不要发送。', 9));
  await until(() => release, 'synthesis did not start');
  paused = true;
  generation += 1;
  release();
  beforeSynthesisResponse = undefined;
  paused = false;
  push(sampleEvent('普通回复作为队列结束标记。', 10));
  await until(() => sends.length >= 8, 'missing final ordinary reply');
  assert.equal(sends[7].body.message[0].type, 'text');
  assert.equal(sends.length, 8, 'voice created before pause must not be sent after resume');
  const memory = await readMemory('lin', 'qq-10002');
  assert.ok(memory.some(({ messageId, reply }) => messageId === '4' && reply === '你好呀。'));
  assert.ok(!memory.some(({ messageId }) => messageId === '8' || messageId === '9'));

  await t.test('a full queue still accepts group revocation during voice synthesis', async () => {
    const queuedDeliveries = [];
    const synthesisStarted = Promise.withResolvers();
    const finishSynthesis = Promise.withResolvers();
    const handle = createMessageHandler({
      owner: '10002', selfId: '10001', groups: ['10004'], social: { enabled: true },
      record: false, simulated: true,
      generate: async () => ({ action: 'speak', text: '群里好。' }),
      prepareReplyVoice: async () => {
        synthesisStarted.resolve();
        return finishSynthesis.promise;
      },
      deliver: async (_contact, _reply, kind) => queuedDeliveries.push(kind),
    });
    await handle(sampleEvent('同意群聊', 20));
    const first = handle(groupEvent(21, 10004));
    await synthesisStarted.promise;
    const pending = Array.from({ length: 7 }, (_, index) => handle(groupEvent(22 + index, 10004)));
    const revoke = handle(sampleEvent('撤销群聊', 29));
    const revoked = await Promise.race([revoke, delay(200).then(() => null)]);
    finishSynthesis.resolve(wav);
    await Promise.all([first, ...pending, revoke]);
    await handle.close();
    assert.deepEqual(revoked, { action: 'authorization', authorized: false, effective: false });
    assert.deepEqual(queuedDeliveries, ['private']);
  });
});
