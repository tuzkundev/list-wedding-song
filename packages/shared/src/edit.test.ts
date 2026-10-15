import { expect, it } from 'vitest';
import { formatTimestamp, gainAtPosition, getEditErrors, parseTimestamp } from './edit';
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
