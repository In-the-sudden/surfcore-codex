import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { readStatus } from '../plugin/src/account.mjs';
import { enforceQuota } from '../plugin/src/quota.mjs';

const limits = {
  primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 },
  secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 2_000_000_000 },
};

function fakeServer(readQuota) {
  let cwd, closed = false;
  return {
    launch(path) {
      cwd = path;
      return {
        initialize: async () => {},
        request: async (method) => {
          if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'plus', email: 'private@example.test' } };
          if (method === 'config/read') return { config: { model: 'test-model' } };
          return readQuota();
        },
        close: () => { closed = true; },
      };
    },
    async assertCleaned() {
      assert.equal(closed, true);
      await assert.rejects(access(cwd), { code: 'ENOENT' });
    },
  };
}

test('account status retries a transient quota error and removes temporary state', async () => {
  let attempts = 0;
  const fake = fakeServer(() => {
    if (++attempts === 1) throw new Error('private server detail');
    return { rateLimits: limits };
  });
  const result = await readStatus({ launch: fake.launch });
  assert.equal(attempts, 2);
  assert.deepEqual(result.rateLimits, limits);
  assert.equal(result.quotaError, null);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  await fake.assertCleaned();
});

test('account status reports persistent quota errors without exposing server details', async () => {
  let attempts = 0;
  const fake = fakeServer(() => { attempts++; throw new Error('private server detail'); });
  const result = await readStatus({ launch: fake.launch });
  assert.equal(attempts, 2);
  assert.equal(result.rateLimits, null);
  assert.match(result.quotaError, /刷新/);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  await fake.assertCleaned();
});

test('account status does not display malformed percentages', async () => {
  const fake = fakeServer(() => ({ rateLimits: { ...limits, primary: { ...limits.primary, usedPercent: -1 } } }));
  const result = await readStatus({ launch: fake.launch });
  assert.equal(result.rateLimits.primary, null);
  assert.deepEqual(result.rateLimits.secondary, limits.secondary);
  await fake.assertCleaned();
});

test('account status closes the server and removes temporary state after initialization fails', async () => {
  let cwd, closed = false;
  await assert.rejects(readStatus({ launch(path) {
    cwd = path;
    return { initialize: async () => { throw new Error('initialization failed'); }, close: () => { closed = true; } };
  } }), /initialization failed/);
  assert.equal(closed, true);
  await assert.rejects(access(cwd), { code: 'ENOENT' });
});

test('quota protection rejects missing, expired and out-of-range windows', () => {
  const policy = { enabled: true, primaryRemaining: 20, secondaryRemaining: 10 };
  const now = 1_900_000_000_000;
  assert.doesNotThrow(() => enforceQuota(limits, policy, now));
  for (const window of [null, { ...limits.primary, usedPercent: -1 }, { ...limits.primary, usedPercent: 101 },
    { ...limits.primary, resetsAt: now / 1000 }]) {
    assert.throws(() => enforceQuota({ ...limits, primary: window }, policy, now), /无法读取/);
    assert.throws(() => enforceQuota({ ...limits, secondary: window }, policy, now), /无法读取/);
  }
});
