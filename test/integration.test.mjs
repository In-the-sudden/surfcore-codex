import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

test('role isolation, local sharing, time filtering, and duplicate/unauthorized OneBot events', async () => {
  const data = await mkdtemp(join(tmpdir(), 'surfcore-test-'));
  const oldData = process.env.SURFCORE_DATA_DIR;
  process.env.SURFCORE_DATA_DIR = data;
  try {
    const store = await import('../plugin/src/store.mjs');
    const { createMessageHandler, sampleEvent } = await import('../plugin/src/bridge.mjs');
    const delivered = [];
    const handle = createMessageHandler({
      owner: '10002', selfId: '10001', admins: ['10004'], groups: ['10006', '10007'], simulated: true,
      generate: async ({ role }) => JSON.stringify({
        role: role.id, notes: role.shared.map(({ note }) => note),
        remembered: role.recent.map(({ incoming }) => incoming),
      }),
      deliver: async (contact, text) => delivered.push([contact, JSON.parse(text)]),
    });
    await store.remember('lin', '林独有的事实');
    assert.equal(await handle({ ...sampleEvent('陌生人', 1), user_id: 10003 }), null);
    assert.equal(await handle({ ...sampleEvent('群', 2), message_type: 'group' }), null);
    await handle(sampleEvent('林的第一轮', 3));
    assert.equal(await handle(sampleEvent('重复', 3)), null);
    await handle({ ...sampleEvent('管理员的第一轮', 3), user_id: 10004 });
    assert.equal(await handle({ ...sampleEvent('管理员的群消息', 8), user_id: 10004, message_type: 'group' }), null);
    await store.activateCharacter('ming');
    await handle(sampleEvent('明的第一轮', 4));
    await store.activateCharacter('lin');
    await handle(sampleEvent('林的第二轮', 5));
    await handle({ ...sampleEvent('管理员的第二轮', 5), user_id: 10004 });
    const groupEvent = (text, id, { group = 10006, sender = 10004, mention = 10001 } = {}) => {
      const event = sampleEvent(text, id);
      return { ...event, user_id: sender, message_type: 'group', group_id: group,
        message: mention === null ? event.message : [{ type: 'at', data: { qq: mention } }, ...event.message] };
    };
    assert.equal(await handle(groupEvent('没有艾特', 9, { mention: null })), null);
    assert.equal(await handle(groupEvent('艾特全体', 9, { mention: 'all' })), null);
    assert.equal(await handle(groupEvent('其他群', 9, { group: 10008 })), null);
    assert.equal(await handle(groupEvent('其他成员', 9, { sender: 10003 })), null);
    await handle(groupEvent('第一群的消息', 9));
    await handle(groupEvent('第二群的消息', 9, { group: 10007, sender: 10002 }));
    await handle(groupEvent('第一群的后续', 10, { sender: 10002 }));
    assert.deepEqual(delivered, [
      ['10002', { role: 'lin', notes: ['林独有的事实'], remembered: [] }],
      ['10004', { role: 'lin', notes: [], remembered: [] }],
      ['10002', { role: 'ming', notes: [], remembered: [] }],
      ['10002', { role: 'lin', notes: ['林独有的事实'], remembered: ['林的第一轮'] }],
      ['10004', { role: 'lin', notes: [], remembered: ['管理员的第一轮'] }],
      ['10006', { role: 'lin', notes: [], remembered: [] }],
      ['10007', { role: 'lin', notes: [], remembered: [] }],
      ['10006', { role: 'lin', notes: [], remembered: ['第一群的消息'] }],
    ]);
    assert.equal((await store.readMemory('lin', 'demo-10002', { now: Date.now() + 31 * 86_400_000 })).length, 0);
    assert.equal((await store.readMemory('lin', 'demo-10002', { maxDays: Infinity })).length, 2);
    assert.deepEqual((await store.readMemory('lin', 'demo-10002'))[0].messages,
      [{ messageId: '3', senderId: '10002', text: '林的第一轮' }]);
    assert.deepEqual((await store.readMemory('lin', 'demo-group-10006')).map(({ messages }) => messages[0].senderId), ['10004', '10002']);
    assert.deepEqual((await store.characterContext()).recent, []);

    const { extractMemoryBatch } = await import('../plugin/src/memory-extraction.mjs');
    const incoming = '最近我买了一把吉他想要学习';
    const summary = '月亮猫开始练习乐器';
    await store.addMemory('lin', 'qq-group-10006', {
      incoming, messages: [{ senderId: '10004', senderNickname: '月亮猫', text: incoming }],
    });
    const { candidates: [candidate] } = await extractMemoryBatch('lin', 'qq-group-10006', {
      owner: '10002',
      generate: async ({ message }) => JSON.stringify({ candidates: [{
        sourceIds: [JSON.parse(message).records[0].sourceId],
        who: '月亮猫', event: summary, feeling: '', importance: 2,
        share: { decision: 'share', summary },
      }] }),
    });

    const requests = [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'get_character_context' } },
      { id: 4, method: 'tools/call', params: { name: 'activate_character', arguments: { id: '../outside' } } },
    ];
    const child = spawn(process.execPath, ['plugin/src/mcp.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stdin.end(requests.map((request) => JSON.stringify({ jsonrpc: '2.0', ...request })).join('\n') + '\n');
    await new Promise((done, fail) => {
      child.on('error', fail);
      child.on('close', (code) => code === 0 ? done() : fail(new Error('MCP exited with code ' + code)));
    });
    const responses = output.trim().split('\n').map(JSON.parse);
    assert.equal(responses[0].result.serverInfo.name, 'surfcore-roles');
    assert.equal(responses[1].result.tools.length, 6);
    assert.ok(responses[1].result.tools.some(({ name }) => name === 'open_surfcore_panel'));
    const context = JSON.parse(responses[2].result.content[0].text);
    assert.deepEqual(context.recent, []);
    assert.equal(context.shared[0].note, '林独有的事实');
    assert.deepEqual(context.sharedConcepts, [{
      candidateId: candidate.id, text: summary, nickname: '月亮猫', relatedMemoryIds: [],
    }]);
    assert.equal(responses[3].result.isError, true);
  } finally {
    if (oldData === undefined) delete process.env.SURFCORE_DATA_DIR;
    else process.env.SURFCORE_DATA_DIR = oldData;
    if (dirname(resolve(data)) === resolve(tmpdir())) await rm(data, { recursive: true, force: true });
  }
});

test('Codex inherits an explicit proxy or the Windows loopback proxy without OneBot credentials', async () => {
  const { buildCodexEnv } = await import('../plugin/src/codex.mjs');
  const systemProxy = () => 'http://127.0.0.1:7890';
  const original = { Path: 'runtime', SURFCORE_ONEBOT_TOKEN: 'private', no_proxy: 'dev.local' };
  assert.deepEqual(buildCodexEnv(original, systemProxy), {
    Path: 'runtime', HTTPS_PROXY: 'http://127.0.0.1:7890', no_proxy: 'dev.local,127.0.0.1,localhost,::1',
  });
  assert.equal(original.SURFCORE_ONEBOT_TOKEN, 'private');
  assert.deepEqual(buildCodexEnv({ https_proxy: 'http://manual.proxy:8000' }, () => {
    assert.fail('Windows proxy discovery must not override an explicit proxy');
  }), { https_proxy: 'http://manual.proxy:8000' });
  assert.deepEqual(buildCodexEnv(original, () => null), { Path: 'runtime', no_proxy: 'dev.local' });
});

test('QQ reply selection ignores commentary and prefers a final answer', async () => {
  const { finalReply } = await import('../plugin/src/codex.mjs');
  const progress = { type: 'agentMessage', phase: 'commentary', text: 'I will check this.' };
  const answer = { type: 'agentMessage', phase: 'final_answer', text: '你好，我是林。' };
  const legacy = { type: 'agentMessage', text: '旧版的回复' };
  assert.equal(finalReply([progress]), '');
  assert.equal(finalReply([progress, answer, legacy, progress]), answer.text);
  assert.equal(finalReply([legacy, progress]), legacy.text);
});
