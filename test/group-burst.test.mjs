import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroupBurstCollector } from '../plugin/src/group-burst.mjs';

function groupMessage(messageId, overrides = {}) {
  return {
    kind: 'group', contact: '10004', senderId: '10003', messageId, text: '消息 ' + messageId,
    media: [], atBot: false, ...overrides,
  };
}

function collector(t, process) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = [];
  const burst = createGroupBurstCollector({
    now: Date.now,
    process: (records, context) => {
      calls.push({ records, context });
      return process?.(records, context);
    },
  });
  t.after(() => burst.cancel());
  return { ...burst, calls, tick: (ms) => t.mock.timers.tick(ms) };
}

test('a same-sender burst retains each record and flushes after 1.5 seconds of silence', async (t) => {
  const { add, calls, tick } = collector(t, () => 'processed');
  const first = groupMessage('10', { atBot: true, at: 10 });
  const second = groupMessage('11', { at: 20 });
  const context = { token: 1, authGeneration: 2 };
  const firstResult = add(first, { mergeable: true, context });
  tick(1_000);
  const secondResult = add(second, { mergeable: true, context: { ...context } });
  tick(1_499);
  assert.deepEqual(calls, []);
  tick(1);
  assert.deepEqual(calls, [{ records: [first, second], context }]);
  assert.equal(await firstResult, 'processed');
  assert.equal(await secondResult, 'processed');
});

test('a continuous burst flushes by four seconds from its first message', async (t) => {
  const { add, calls, tick } = collector(t);
  const first = groupMessage('10');
  const second = groupMessage('11');
  const third = groupMessage('12');
  const fourth = groupMessage('13');
  add(first, { mergeable: true });
  tick(1_400);
  add(second, { mergeable: true });
  tick(1_400);
  add(third, { mergeable: true });
  tick(1_199);
  assert.deepEqual(calls, []);
  tick(1);
  assert.deepEqual(calls.map(({ records }) => records), [[first, second, third]]);
  const result = add(fourth, { mergeable: true });
  tick(1_500);
  await result;
  assert.deepEqual(calls.map(({ records }) => records), [[first, second, third], [fourth]]);
});

test('interleaving senders and standalone group messages preserve group arrival order', async (t) => {
  const { add, calls, tick } = collector(t);
  const first = groupMessage('10');
  const interruption = groupMessage('11', { senderId: '10006' });
  const resumed = groupMessage('12');
  const standalone = groupMessage('13', { media: [{ type: 'image' }] });
  const after = groupMessage('14');
  add(first, { mergeable: true });
  add(interruption, { mergeable: true });
  add(resumed, { mergeable: true });
  add(standalone, { mergeable: false });
  assert.deepEqual(calls.map(({ records }) => records), [[first], [interruption], [resumed], [standalone]]);
  const result = add(after, { mergeable: true });
  tick(1_500);
  await result;
  assert.deepEqual(calls.map(({ records }) => records.at(-1).messageId), ['10', '11', '12', '13', '14']);
});

test('other groups and private messages can process independently', async (t) => {
  const { promise: blocked, resolve } = Promise.withResolvers();
  const { add, calls, tick } = collector(t, ([{ contact }]) => contact === '10004' ? blocked : contact);
  const first = groupMessage('10');
  const second = groupMessage('11', { contact: '10005' });
  const privateMessage = groupMessage('12', { kind: 'private', contact: '10003' });
  const firstResult = add(first, { mergeable: true });
  tick(500);
  const secondResult = add(second, { mergeable: true });
  assert.equal(await add(privateMessage, { mergeable: true }), '10003');
  assert.deepEqual(calls.map(({ records }) => records), [[privateMessage]]);
  tick(1_500);
  assert.equal(await secondResult, '10005');
  assert.deepEqual(calls.map(({ records }) => records), [[privateMessage], [first], [second]]);
  resolve('10004');
  assert.equal(await firstResult, '10004');
});

test('authorization or role changes split a burst and cancellation settles pending work', async (t) => {
  const { add, calls, cancel, tick } = collector(t);
  const first = groupMessage('10');
  const second = groupMessage('11');
  const third = groupMessage('12');
  const initial = { token: 1, authGeneration: 2 };
  const switchedRole = { token: 2, authGeneration: 2 };
  const changedAuthorization = { token: 2, authGeneration: 3 };
  add(first, { mergeable: true, context: initial });
  add(second, { mergeable: true, context: switchedRole });
  const pending = add(third, { mergeable: true, context: changedAuthorization });
  assert.deepEqual(calls, [
    { records: [first], context: initial },
    { records: [second], context: switchedRole },
  ]);
  cancel();
  assert.equal(await pending, null);
  tick(4_000);
  assert.equal(calls.length, 2);
});

test('a forced group flush leaves other groups buffered', async (t) => {
  const { add, calls, flush, tick } = collector(t);
  const first = groupMessage('10');
  const second = groupMessage('11', { contact: '10005' });
  add(first, { mergeable: true });
  add(second, { mergeable: true });
  flush(first.contact);
  assert.deepEqual(calls.map(({ records }) => records), [[first]]);
  flush();
  tick(4_000);
  assert.deepEqual(calls.map(({ records }) => records), [[first], [second]]);
});
