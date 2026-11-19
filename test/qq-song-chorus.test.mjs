import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSongSegment } from '../plugin/src/qq-song-chorus.mjs';

test('the opening starts one second before the first lyric and ends after a complete phrase', () => {
  const media = { section: 'opening', sourceStart: 0, duration: 85 };
  assert.deepEqual(selectSongSegment({ ...media, opening: { vocalStart: 30.43, phraseEnd: 65.72 } }),
    { start: 29.43, end: 65.72 });
  assert.deepEqual(selectSongSegment({ ...media, opening: { vocalStart: 0.3, phraseEnd: 28 } }),
    { start: 0, end: 28 });
  assert.deepEqual(selectSongSegment({ ...media, sourceStart: 29, opening: { vocalStart: 30, phraseEnd: 61 } }),
    { start: 0, end: 32 });
  assert.equal(selectSongSegment(media), undefined);
  assert.equal(selectSongSegment({ ...media, opening: { vocalStart: 30.43, phraseEnd: 75 } }), undefined);
  assert.equal(selectSongSegment({ ...media, duration: 63, opening: { vocalStart: 30.43, phraseEnd: 65.72 } }), undefined);
});

test('a trusted chorus interval is translated to media time and limited to its first 30 seconds', () => {
  assert.deepEqual(selectSongSegment({
    section: 'chorus', sourceStart: 60, duration: 40, chorus: { start: 66.5, end: 102 },
  }), { start: 6.5, end: 36.5 });
  assert.deepEqual(selectSongSegment({
    section: 'chorus', sourceStart: 0, duration: 130, chorus: { start: 66.5, end: 80 },
  }), { start: 66.5, end: 80 });
});

test('a missing or unusable chorus cue never selects an unrelated part of the track', () => {
  const media = { section: 'chorus', sourceStart: 60, duration: 30 };
  assert.equal(selectSongSegment(media), undefined);
  for (const chorus of [{ start: 59, end: 85 }, { start: 70, end: 91 }, { start: 73, end: 73 },
    { start: '70', end: 85 }, { start: 70, end: Infinity }]) {
    assert.equal(selectSongSegment({ ...media, chorus }), undefined);
  }
  assert.equal(selectSongSegment({ section: 'chorus', duration: 30, chorus: { start: 66.5, end: 80 } }), undefined);
});

test('invalid media geometry or an unrecognized section has no clip', () => {
  for (const duration of [0, -1, NaN, Infinity, '30']) {
    assert.equal(selectSongSegment({ section: 'opening', sourceStart: 0, duration }), undefined);
  }
  assert.equal(selectSongSegment({ section: 'chorus', sourceStart: -1, duration: 80, chorus: { start: 30, end: 50 } }), undefined);
  assert.equal(selectSongSegment({ section: 'bridge', sourceStart: 0, duration: 80 }), undefined);
});
