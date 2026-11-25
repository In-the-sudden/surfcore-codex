import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const directory = await mkdtemp(join(tmpdir(), 'surfcore-explicit-voice-'));
process.env.SURFCORE_DATA_DIR = directory;
const { createMessageHandler, sampleEvent } = await import('../plugin/src/bridge.mjs');
after(() => rm(directory, { recursive: true, force: true }));

const request = '这句话想听你亲口说给我。';
const draft = '今天的晚风很轻，慢慢走也能看见前面的灯亮起来。';

test('a model-confirmed voice request retries a long reply within one eight-second budget', async (t) => {
  const wav = Buffer.from('mock wav');
  const attempts = [];
  const deliveries = [];
  const handle = createMessageHandler({
    owner: '10002', selfId: '10001', record: false,
    generate: async ({ message }) => {
      assert.equal(message, request);
      return JSON.stringify({ action: 'speak', text: draft, voiceRequested: true });
    },
    prepareReplyVoice: async (_roleId, text, timeoutMs, { explicit, signal }) => {
      assert.equal(text, draft);
      assert.equal(explicit, true);
      assert.ok(signal instanceof AbortSignal);
      attempts.push(timeoutMs);
      if (attempts.length === 1) {
        await delay(35);
        return null;
      }
      return wav;
    },
    chooseReplyFormat: async () => 'text',
    deliver: async (_contact, text, _kind, audio) => deliveries.push({ text, audio }),
  });
  t.after(() => handle.close());
  await handle(sampleEvent(request, 1));
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0] > 4000 && attempts[0] <= 8000);
  assert.ok(attempts[1] > 0 && attempts[1] <= attempts[0] - 20);
  assert.deepEqual(deliveries, [{ text: draft, audio: wav }]);
});

test('failed explicit speech may receive a new model reply or remain silent', async (t) => {
  const alternate = '我在，慢慢说。';
  const deliveries = [];
  const failureScopes = [];
  let failureResponse;
  const handle = createMessageHandler({
    owner: '10002', selfId: '10001', admins: ['10003'], record: false,
    generate: async ({ voiceFailureMode, ownerPrivate }) => {
      if (voiceFailureMode) {
        failureScopes.push(ownerPrivate);
        return failureResponse;
      }
      return JSON.stringify({ action: 'speak', text: draft, voiceRequested: true });
    },
    prepareReplyVoice: async () => null,
    deliver: async (contact, text, _kind, audio) => deliveries.push({ contact, text, audio }),
  });
  t.after(() => handle.close());

  failureResponse = { action: 'skip' };
  await handle(sampleEvent(request, 2));
  assert.deepEqual(deliveries, []);

  failureResponse = { action: 'speak', text: draft };
  await handle(sampleEvent(request, 3));
  assert.deepEqual(deliveries, []);

  failureResponse = { action: 'speak', text: alternate };
  await handle({ ...sampleEvent(request, 4), user_id: 10003, sub_type: 'friend' });
  assert.deepEqual(failureScopes, [true, true, false]);
  assert.deepEqual(deliveries, [{ contact: '10003', text: alternate, audio: undefined }]);
});

test('a voice that arrives after eight seconds is discarded', { timeout: 3000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers();
  const lateAudio = Promise.withResolvers();
  const deliveries = [];
  let failureCalls = 0;
  const handle = createMessageHandler({
    owner: '10002', selfId: '10001', record: false,
    generate: async ({ voiceFailureMode }) => {
      if (!voiceFailureMode) return { action: 'speak', text: draft, voiceRequested: true };
      failureCalls++;
      return { action: 'skip' };
    },
    prepareReplyVoice: async (_role, _text, _timeout, { signal }) => {
      started.resolve(signal);
      return lateAudio.promise;
    },
    deliver: async (...args) => deliveries.push(args),
  });
  t.after(() => handle.close());
  const turn = handle(sampleEvent(request, 5));
  const signal = await started.promise;
  t.mock.timers.tick(7_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  await turn;
  lateAudio.resolve(Buffer.from('late audio'));
  assert.equal(failureCalls, 1);
  assert.deepEqual(deliveries, []);
});
