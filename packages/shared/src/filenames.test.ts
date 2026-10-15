import { expect, it } from 'vitest';
import { formatPrefix, formatSectionFolder, formatTrackEntry, sanitizeName } from './filenames';
it('preserves Vietnamese Unicode while blocking traversal, Windows invalid names and length overflow', () => {
  expect(formatSectionFolder(0, 2, 'Đón khách')).toBe('01 - Đón khách/');
  expect(formatTrackEntry('01 - Đón khách/', 0, 2, 'Hơn cả yêu')).toBe('01 - Đón khách/01 - Hơn cả yêu.mp3');
  expect(sanitizeName(' ../CON.txt.. ', 'Bai')).toBe('.._CON.txt');
  expect(sanitizeName('CON.mp3', 'Bai')).toBe('Bai');
  expect(sanitizeName('///...', 'Muc')).toBe('Muc');
  expect(sanitizeName('Đ'.repeat(150), 'Bai')).toHaveLength(120);
  expect(formatPrefix(99, 100)).toBe('100');
});
