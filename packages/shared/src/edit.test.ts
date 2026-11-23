import { describe, expect, it } from 'vitest';
import { formatTimestamp, gainAtPosition, getEditErrors, parseTimestamp, resolveSegments, segmentsLength } from './edit';
const edit = { startSeconds: 2, endSeconds: 10, fadeInSeconds: 1, fadeOutSeconds: 2 };
it('validates actual source duration without silently repairing intent', () => {
  expect(getEditErrors(edit, 12)).toEqual({});
  expect(getEditErrors(edit, 9).endSeconds).toBeDefined();
  expect(getEditErrors({ ...edit, endSeconds: 2 }, 12).endSeconds).toBeDefined();
  expect(getEditErrors({ ...edit, fadeInSeconds: 7 }, 12).fadeOutSeconds).toBeDefined();
  expect(getEditErrors({ ...edit, fadeInSeconds: 6 }, 12)).toEqual({});
  expect(getEditErrors({ ...edit, fadeInSeconds: -1 }, 12).fadeInSeconds).toBeDefined();
  expect(getEditErrors(edit, null).duration).toBeDefined();
});
it('recomputes linear preview gain on seeks including both boundaries', () => {
  expect([1, 2, 2.5, 3, 7, 9, 10].map(position => gainAtPosition(position, edit))).toEqual([0, 0, 0.5, 1, 1, 0.5, 0]);
  expect(gainAtPosition(2, { ...edit, fadeInSeconds: 0 })).toBe(1);
});
it('formats and parses mp3cut-style mm:ss.d timestamps and raw seconds', () => {
  expect(formatTimestamp(0)).toBe('00:00.0');
  expect(formatTimestamp(58.6)).toBe('00:58.6');
  expect(formatTimestamp(67.25)).toBe('01:07.3');
  expect(parseTimestamp('01:07.5')).toBe(67.5);
  expect(parseTimestamp('58.6')).toBe(58.6);
  expect(parseTimestamp('01:75.0')).toBeNull();
});

describe('cutMode remove', () => {
  const remove = { startSeconds: 10, endSeconds: 20, fadeInSeconds: 1, fadeOutSeconds: 2, cutMode: 'remove' as const };
  it('keeps audio before and after the selected range', () => {
    expect(resolveSegments(remove, 60)).toEqual([
      { startSeconds: 0, endSeconds: 10, fadeInSeconds: 1, fadeOutSeconds: 0 },
      { startSeconds: 20, endSeconds: 60, fadeInSeconds: 0, fadeOutSeconds: 2 },
    ]);
    expect(segmentsLength(resolveSegments(remove, 60))).toBe(50);
    expect(getEditErrors(remove, 60)).toEqual({});
  });
  it('drops empty edges', () => {
    expect(resolveSegments({ ...remove, startSeconds: 0 }, 60)).toEqual([{ startSeconds: 20, endSeconds: 60, fadeInSeconds: 1, fadeOutSeconds: 2 }]);
    expect(resolveSegments({ ...remove, endSeconds: 60 }, 60)).toEqual([{ startSeconds: 0, endSeconds: 10, fadeInSeconds: 1, fadeOutSeconds: 2 }]);
  });
  it('rejects removing the whole song or oversized fades', () => {
    expect(getEditErrors({ ...remove, startSeconds: 0, endSeconds: 60 }, 60).endSeconds).toBeDefined();
    expect(getEditErrors({ ...remove, fadeInSeconds: 11 }, 60).fadeOutSeconds).toBeDefined();
  });
});
