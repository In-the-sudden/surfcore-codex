import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableMemoryChars, dailyMemoryLimit, memoryDay, memoryProcessingDue } from '../plugin/src/memory-daily-policy.mjs';

const group = { scope: 'qq-group-10005', owner: '10001' };
const privateChat = { scope: 'qq-10002', owner: '10001' };
const activeDays = Array.from({ length: 14 }, (_, index) => `2026-11-${String(index + 1).padStart(2, '0')}`);

test('separate group and private limits grow to their caps over consecutive days', () => {
  assert.equal(dailyMemoryLimit({ ...group, activeDays: [], today: '2026-11-01' }).limit, 300);
  assert.equal(dailyMemoryLimit({ ...privateChat, activeDays: [], today: '2026-11-01' }).limit, 100);
  const partial = dailyMemoryLimit({ ...group, activeDays: activeDays.slice(0, 7), today: '2026-11-07' });
  assert.ok(partial.limit > 300 && partial.limit < 1500);
  assert.equal(dailyMemoryLimit({ ...group, activeDays, today: '2026-11-14' }).limit, 1500);
  assert.equal(dailyMemoryLimit({ ...privateChat, activeDays, today: '2026-11-14' }).limit, 500);
  assert.equal(dailyMemoryLimit({ scope: 'qq-10001', owner: '10001', activeDays, today: '2026-11-14' }).limit, null);
  assert.equal(dailyMemoryLimit({ scope: 'qq-group-10001', owner: '10001', activeDays, today: '2026-11-14' }).limit, 1500);
});

test('inactivity decays above the base and a new streak starts on renewed activity', () => {
  const next = dailyMemoryLimit({ ...group, activeDays, today: '2026-11-15' });
  assert.equal(next.limit, 1200);
  assert.equal(next.inactiveDays, 1);
  const later = dailyMemoryLimit({ ...group, activeDays, today: '2026-11-30' });
  assert.ok(later.limit >= 300 && later.limit < next.limit);
  const restarted = dailyMemoryLimit({ ...group, activeDays: [...activeDays, '2026-11-20', '2026-11-21'], today: '2026-11-21' });
  assert.equal(restarted.streak, 2);
  assert.ok(restarted.limit > 300 && restarted.limit < 1500);
  const resumed = dailyMemoryLimit({ ...group, activeDays: [...activeDays, '2026-11-16'], today: '2026-11-16' });
  assert.equal(resumed.limit, next.limit);
});

test('daily boundaries use Hong Kong time and invalid calendar dates fail', () => {
  assert.equal(memoryDay('2026-11-07T15:59:59Z'), '2026-11-07');
  assert.equal(memoryDay('2026-11-07T16:00:00Z'), '2026-11-08');
  assert.throws(() => dailyMemoryLimit({ ...group, activeDays: ['2026-02-30'], today: '2026-11-08' }), /日期/);
});

test('first batch waits two hours, later batches wait since the previous processing', () => {
  const firstPendingAt = '2026-11-08T00:00:00Z';
  assert.equal(memoryProcessingDue({ firstPendingAt, now: '2026-11-08T01:59:59Z' }).due, false);
  assert.equal(memoryProcessingDue({ firstPendingAt, now: '2026-11-08T02:00:00Z' }).due, true);
  assert.equal(memoryProcessingDue({ firstPendingAt: '2026-11-08T02:10:00Z', lastProcessedAt: '2026-11-08T02:00:00Z', now: '2026-11-08T04:00:00Z' }).due, true);
  assert.equal(memoryProcessingDue({ firstPendingAt: '2026-11-08T05:00:00Z', lastProcessedAt: '2026-11-08T02:00:00Z', now: '2026-11-08T05:00:00Z' }).due, true);
});

test('remaining daily output cannot go negative and owner is unlimited', () => {
  assert.equal(availableMemoryChars(300, 80), 220);
  assert.equal(availableMemoryChars(300, 400), 0);
  assert.equal(availableMemoryChars(null, 1000), null);
  assert.throws(() => availableMemoryChars(100, -1));
});
