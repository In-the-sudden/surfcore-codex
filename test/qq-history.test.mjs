import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationReader } from '../plugin/src/qq-history.mjs';

const peer = 10002;
const self = 10001;
const groupId = 20001;
const member = 10003;
const group = { kind: 'group', contact: String(groupId), senderId: String(member), selfId: String(self) };
const direct = { kind: 'private', contact: String(peer), senderId: String(peer), selfId: String(self) };
const text = (value) => ({ type: 'text', data: { text: value } });
const groupEvent = (fields) => ({
  message_type: 'group', group_id: groupId, user_id: member,
  sender: { user_id: member, nickname: '示例成员' },
  message_id: 31, time: 1795312800, message: [text('今天做了蛋糕')], ...fields,
});
const privateEvent = (fields) => ({
  message_type: 'private', sub_type: 'friend', user_id: peer,
  message_id: 32, time: 1795312801, message: [text('朋友的留言')], ...fields,
});

test('history asks for one bounded page and returns the latest 15 scoped messages in order', async () => {
  const events = [...Array.from({ length: 19 }, (_, index) => groupEvent({
    message_id: index + 1,
    time: 1795312800 + index,
    message: [text('流水-' + index + '。')],
  })), groupEvent({ group_id: groupId + 1, message: [text('其他群的消息')] }),
  groupEvent({ is_recalled: true, message: [text('已经撤回')] })];
  const reader = createConversationReader(group, async (action, body, options) => {
    assert.equal(action, 'get_group_msg_history');
    assert.deepEqual(body, { group_id: groupId, count: 15 });
    assert.equal(options.requireOk, true);
    return { messages: events };
  });
  const result = await reader('history');
  assert.equal(result.text.match(/流水-/gu)?.length, 15);
  assert.doesNotMatch(result.text, /流水-[0-3]。|其他群的消息|已经撤回|20001|10003/u);
  assert.ok(result.text.indexOf('流水-4。') < result.text.indexOf('流水-18。'));
  assert.match(result.text, /2026-11-22T02:00:04\.000Z.*示例成员/u);
  assert.equal(result.quotedMedia, undefined);
});

test('history text does not expose numbers, media links, nested forwards or unverified nicknames', async () => {
  const event = groupEvent({
    sender: { user_id: peer, nickname: '假昵称' },
    message: [
      text('这一条含群号 ' + groupId + '、成员号 ' + member + ' 与附件链接 https://example.invalid/abc.gif。'),
      { type: 'at', data: { qq: peer } },
      { type: 'forward', data: { content: [text('转发私聊正文')] } },
      { type: 'image', data: { url: 'https://gchat.qpic.cn/hidden.png' } },
    ],
    raw_message: '原始 CQ 数据不要透传',
  });
  const result = await createConversationReader(group, async () => ({ messages: [event] }))('history');
  assert.match(result.text, /这一条含群号/u);
  assert.doesNotMatch(result.text, /20001|10003|10002|example\.invalid|qpic\.cn|转发私聊正文|原始 CQ 数据|假昵称/u);
  assert.equal(result.quotedMedia, undefined);
});

test('one friend-history page accepts both verified directions, including SnowLuma incoming messages without a target', async () => {
  const reader = createConversationReader(direct, async (action, body) => {
    assert.equal(action, 'get_friend_msg_history');
    assert.deepEqual(body, { user_id: peer, count: 15 });
    return { messages: [
      privateEvent({}),
      privateEvent({ user_id: self, target_id: peer, message_id: 33, message: [text('机器人的回信')] }),
      privateEvent({ user_id: self, target_id: member, message_id: 34, message: [text('其他人的私聊')] }),
      privateEvent({ user_id: peer, target_id: member, message_id: 35, message: [text('第三方的私聊')] }),
      privateEvent({ sub_type: 'group', message_id: 36, message: [text('群临时私聊')] }),
      privateEvent({ user_id: member, target_id: self, message_id: 37, message: [text('陌生人的私聊')] }),
    ] };
  });
  const { text: history } = await reader('history');
  assert.match(history, /朋友的留言/u);
  assert.match(history, /我.*机器人的回信/u);
  assert.doesNotMatch(history, /其他人的私聊|第三方的私聊|群临时私聊|陌生人的私聊/u);
});

test('quote query uses only the signed reply ID and returns verified media for later processing', async () => {
  const withQuote = { ...direct, quotedMessageId: -38 };
  const reader = createConversationReader(withQuote, async (action, body) => {
    assert.equal(action, 'get_msg');
    assert.deepEqual(body, { message_id: -38 });
    return privateEvent({
      message_id: -38, user_id: self, target_id: peer,
      message: [text('给你看'), { type: 'image', data: { file: 'a.png', url: 'https://gchat.qpic.cn/a.png' } }],
    });
  });
  const result = await reader('quoted');
  assert.match(result.text, /给你看/u);
  assert.doesNotMatch(result.text, /qpic\.cn|10001|10002/u);
  assert.deepEqual(result.quotedMedia, {
    messageId: '-38', text: '2026-11-22T02:00:01.000Z 我：给你看[图片1]',
    media: [{ type: 'image', marker: '[图片1]', file: 'a.png', url: 'https://gchat.qpic.cn/a.png' }],
  });
});

test('quote query ignores IDs other than the trusted reference and rejects mismatched, recalled and ambiguous events', async () => {
  const withQuote = { ...direct, quotedMessageId: 32 };
  for (const event of [
    privateEvent({ user_id: self }),
    privateEvent({ target_id: member }),
    privateEvent({ message_id: 40 }),
    privateEvent({ recalled: true }),
    privateEvent({ sub_type: 'group' }),
    groupEvent({ message_id: 32 }),
  ]) {
    const result = await createConversationReader(withQuote, async () => event)('quoted');
    assert.doesNotMatch(result.text, /朋友的留言|今天做了蛋糕/u);
    assert.equal(result.quotedMedia, undefined);
  }
  let calls = 0;
  const unexpected = async () => { calls++; throw new Error('unexpected request'); };
  await createConversationReader(direct, unexpected)('quoted');
  await createConversationReader({ ...direct, subType: 'group' }, unexpected)('history');
  await createConversationReader(withQuote, unexpected)({ kind: 'quoted', message_id: 77 });
  assert.equal(calls, 0);
});

test('a private quote without recipient or account evidence must match a peer-scoped lookup', async () => {
  const quoted = { ...direct, quotedMessageId: 32 };
  const ambiguous = privateEvent({ message: [text('未核实的文本')] });
  for (const confirmed of [privateEvent({ message: [text('已核实的文本')] }), privateEvent({ recalled: true })]) {
    const reader = createConversationReader(quoted, async (action, body) => {
      if (action === 'get_msg') return ambiguous;
      assert.equal(action, 'get_friend_msg_history');
      assert.deepEqual(body, { user_id: peer, message_id: 32, count: 1 });
      return { messages: [confirmed] };
    });
    const result = await reader('quoted');
    assert.doesNotMatch(result.text, /未核实的文本/u);
    assert.equal(result.text.includes('已核实的文本'), !confirmed.recalled);
  }
});

test('gateway errors and empty pages return a safe status', async () => {
  const error = await createConversationReader(group, async () => {
    throw new Error('private gateway diagnostic ' + peer);
  })('history');
  const empty = await createConversationReader(group, async () => ({ messages: [] }))('history');
  assert.match(error.text, /暂时.*读取/u);
  assert.doesNotMatch(error.text, /diagnostic|10002/u);
  assert.match(empty.text, /没有.*消息/u);
});

test('history suppresses a duplicate with a known recall and caps combined text', async () => {
  const duplicate = groupEvent({ message_id: 95, message: [text('被撤回的重复原文')] });
  const repeated = groupEvent({ message_id: 96, message: [text('仅出现一次')] });
  const extra = Array.from({ length: 15 }, (_, index) => groupEvent({
    message_id: 101 + index,
    time: 1795312800 - index,
    message: [text('文'.repeat(1000))],
  }));
  const reader = createConversationReader(group, async () => ({ messages: [
    duplicate, { ...duplicate, recalled: true }, repeated, repeated, ...extra,
  ] }));
  const { text: history } = await reader('history');
  assert.doesNotMatch(history, /被撤回的重复原文/u);
  assert.equal(history.match(/仅出现一次/gu)?.length, 1);
  assert.ok(history.length < 4300);
});

test('strict fallback validation rejects results from a different login and ambiguous temporary private rows', async () => {
  const accountMismatch = groupEvent({ self_id: member, message: [text('其他登录账号的群消息')] });
  const groupReader = createConversationReader(group, async () => ({ messages: [accountMismatch] }));
  assert.doesNotMatch((await groupReader('history')).text, /其他登录账号的群消息/u);

  const tempPrivate = privateEvent({ sub_type: undefined, sender: { group_id: groupId }, message: [text('未知来源的临时会话')] });
  const directReader = createConversationReader(direct, async () => ({ messages: [tempPrivate] }));
  assert.doesNotMatch((await directReader('history')).text, /未知来源的临时会话/u);
});
