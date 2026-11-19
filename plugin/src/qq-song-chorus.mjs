const MAX_CHORUS_SECONDS = 30;
export const MAX_OPENING_SECONDS = 40;

// sourceStart and the trusted chorus cue use the same recording's time axis.
// The returned interval is relative to the start of the decoded source.
export function selectSongSegment({ section, duration, sourceStart, chorus, opening }) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(sourceStart) || sourceStart < 0) return undefined;

  if (section === 'opening') {
    const { vocalStart, phraseEnd } = opening ?? {};
    if (!Number.isFinite(vocalStart) || !Number.isFinite(phraseEnd) || vocalStart < sourceStart || phraseEnd <= vocalStart) {
      return undefined;
    }
    const start = Math.max(0, vocalStart - sourceStart - 1);
    const end = phraseEnd - sourceStart;
    return end <= duration && end - start <= MAX_OPENING_SECONDS ? { start, end } : undefined;
  }

  if (section !== 'chorus' || !Number.isFinite(chorus?.start) || !Number.isFinite(chorus?.end)) return undefined;

  const start = chorus.start - sourceStart;
  const end = Math.min(chorus.end - sourceStart, start + MAX_CHORUS_SECONDS);
  if (start < 0 || end <= start || end > duration) return undefined;

  return { start, end };
}
