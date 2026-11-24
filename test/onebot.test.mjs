import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const liveModel = process.env.SURFCORE_TEST_LIVE_MODEL === '1';

test('OneBot private reply through ' + (liveModel ? 'live Codex' : 'a stub model'), { timeout: liveModel ? 120_000 : 8_000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'surfcore-onebot-'));
  process.env.SURFCORE_DATA_DIR = data;
  const { sampleEvent, startOneBot } = await import('../plugin/src/bridge.mjs');
  let connection;
  let wsAuth;
  let httpRequest;
  let sendCalls = 0;
  let loginAuth;
  let incomingEvent;
  let historyRequests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/get_login_info') {
      loginAuth = req.headers.authorization;
      res.end('{"retcode":0,"data":{"user_id":10001}}');
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks));
    if (req.url === '/get_msg' || req.url === '/get_friend_msg_history') {
      historyRequests.push({ path: req.url, body });
      const quote = {
        message_type: 'private', sub_type: 'friend', user_id: 10002, message_id: -42,
        message: [{ type: 'text', data: { text: '引用上下文来自同一私聊' } }],
      };
      res.end(JSON.stringify({ status: 'ok', retcode: 0,
        data: req.url === '/get_msg' ? quote : { messages: [quote] },
      }));
      return;
    }
    sendCalls++;
    httpRequest = { path: req.url, auth: req.headers.authorization, body };
    res.end('{"status":"ok","retcode":0,"data":{"message_id":42}}');
  });
  server.on('upgrade', (req, socket) => {
    connection = socket;
    wsAuth = req.headers.authorization;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const payload = Buffer.from(JSON.stringify(incomingEvent ?? sampleEvent(liveModel ? '你好，请用一句话介绍自己，带上你的角色名字。' : 'hello', 1)));
    const frame = Buffer.alloc(4);
    frame[0] = 0x81;
    frame[1] = 126;
    frame.writeUInt16BE(payload.length, 2);
    socket.write(Buffer.concat([frame, payload]));
  });

  try {
    await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
    const port = server.address().port;
    let failure;
    const generate = liveModel ? async (input) => {
      try {
        const { runCodex } = await import('../plugin/src/codex.mjs');
        return await runCodex(input);
      } catch (error) {
        failure = error;
        throw error;
      }
    } : async () => 'hello back';
    const options = { owner: '10002', selfId: '10001', wsUrl: 'ws://127.0.0.1:' + port,
      httpUrl: 'http://127.0.0.1:' + port, wsToken: 'fake-ws', httpToken: 'fake-http', send: true, generate };
    await assert.rejects(startOneBot({ ...options, selfId: '10009' }), /登录账号和配置的机器人 QQ 不一致/);
    assert.equal(connection, undefined);
    const run = startOneBot(options);
    run.catch((error) => { failure = error; });

    // Wait for the bridge to persist the confirmed reply before closing the fixture.
    const { readMemory } = await import('../plugin/src/store.mjs');
    const deadline = Date.now() + (liveModel ? 110_000 : 2_500);
    let sent = [];
    while (Date.now() < deadline) {
      if (failure) throw failure;
      try { sent = await readMemory('lin', 'qq-10002'); }
      catch (error) { if (error.code !== 'EPERM') throw error; }
      if (sent.length) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(loginAuth, 'Bearer fake-http');
    assert.equal(wsAuth, 'Bearer fake-ws');
    assert.equal(httpRequest?.path, '/send_private_msg');
    assert.equal(httpRequest.auth, 'Bearer fake-http');
    assert.equal(httpRequest.body.user_id, 10002);
    assert.equal(sent.length, 1);
    const expectedReply = liveModel ? /林/ : /^hello back$/;
    assert.match(sent[0].reply, expectedReply);
    assert.deepEqual(httpRequest.body.message, [{ type: 'text', data: { text: sent[0].reply } }]);
    connection.write(Buffer.from([0x88, 2, 0x03, 0xe8]));
    connection.end();
    await run;

    const previews = [];
    const previewRun = startOneBot({ ...options, send: false, onEvent: (event) => { if (event.type === 'preview') previews.push(event); } });
    previewRun.catch((error) => { failure = error; });
    const previewDeadline = Date.now() + 2_500;
    while (!previews.length && Date.now() < previewDeadline) {
      if (failure) throw failure;
      await new Promise((done) => setTimeout(done, 25));
    }
    assert.equal(previews.length, 1);
    assert.equal(sendCalls, 1, 'preview mode must not call OneBot send endpoints');
    connection.write(Buffer.from([0x88, 2, 0x03, 0xe8]));
    connection.end();
    await previewRun;

    const faceSent = Promise.withResolvers();
    const faceRun = startOneBot({
      ...options, autonomousMedia: true,
      loadReplyFaces: async () => [{ id: 'selected-fixture-face', label: '贴贴' }],
      generate: async ({ faceOptions }) => {
        assert.deepEqual(faceOptions, [{ choice: 1, label: '贴贴' }]);
        return { action: 'speak', text: '贴贴。', face: 1 };
      },
      onEvent: (event) => { if (event.format === 'face') faceSent.resolve(); },
    });
    faceRun.catch(faceSent.reject);
    const timer = setTimeout(() => faceSent.reject(new Error('Face send did not complete')), 2_500);
    try { await faceSent.promise; }
    finally { clearTimeout(timer); }
    assert.deepEqual(httpRequest, {
      path: '/send_custom_face', auth: 'Bearer fake-http',
      body: { user_id: 10002, emoji_id: 'selected-fixture-face' },
    });
    connection.write(Buffer.from([0x88, 2, 0x03, 0xe8]));
    connection.end();
    await faceRun;

    const { localStickers } = await import('../plugin/src/qq-local-stickers.mjs');
    const original = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    await localStickers.save('lin', '10001:qq-10002', { bytes: original, extension: 'gif', label: '先前收藏的动图' });
    incomingEvent = sampleEvent('看看我引用的那条', 12);
    incomingEvent.message.unshift({ type: 'reply', data: { id: '-42' } });
    const localSent = Promise.withResolvers();
    const stickerRun = startOneBot({
      ...options, autonomousMedia: true,
      generate: async ({ conversationTools, message }) => {
        if (conversationTools.canReadQuote) return { action: 'lookup', source: 'quoted' };
        assert.match(message, /引用上下文来自同一私聊/);
        assert.deepEqual(conversationTools.stickers, [{ choice: 1, label: '先前收藏的动图' }]);
        return { action: 'speak', text: '我看到啦。', localSticker: 1 };
      },
      onEvent: (event) => { if (event.format === 'local-sticker') localSent.resolve(); },
    });
    stickerRun.catch(localSent.reject);
    const stickerTimer = setTimeout(() => localSent.reject(new Error('Stored sticker did not send')), 2_500);
    try { await localSent.promise; }
    finally { clearTimeout(stickerTimer); }
    assert.deepEqual(historyRequests, [
      { path: '/get_msg', body: { message_id: -42 } },
      { path: '/get_friend_msg_history', body: { user_id: 10002, message_id: -42, count: 1 } },
    ]);
    assert.equal(httpRequest.path, '/send_private_msg');
    assert.equal(httpRequest.body.user_id, 10002);
    assert.equal(httpRequest.body.message[0].type, 'image');
    assert.equal(httpRequest.body.message[0].data.sub_type, 1);
    assert.equal(httpRequest.body.message[0].data.file, 'base64://' + original.toString('base64'));
    connection.write(Buffer.from([0x88, 2, 0x03, 0xe8]));
    connection.end();
    await stickerRun;
  } finally {
    connection?.destroy();
    server.close();
    delete process.env.SURFCORE_DATA_DIR;
    if (dirname(resolve(data)) === resolve(tmpdir())) await rm(data, { recursive: true, force: true });
  }
});
