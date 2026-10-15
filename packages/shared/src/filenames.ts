const RESERVED: Record<string, true> = { CON: true, PRN: true, AUX: true, NUL: true, COM1: true, COM2: true, COM3: true, COM4: true, COM5: true, COM6: true, COM7: true, COM8: true, COM9: true, LPT1: true, LPT2: true, LPT3: true, LPT4: true, LPT5: true, LPT6: true, LPT7: true, LPT8: true, LPT9: true };
export function sanitizeName(raw: string, fallback: 'Muc' | 'Bai'): string {
  const clean = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 120).replace(/[. ]+$/g, '');
  return !clean || /^_+$/.test(clean) || RESERVED[clean.split('.')[0].toUpperCase()] ? fallback : clean;
}
export function formatPrefix(index: number, total: number): string {
  return String(index + 1).padStart(Math.max(2, String(Math.max(1, total)).length), '0');
}
export const formatSectionFolder = (index: number, total: number, title: string) => `${formatPrefix(index, total)} - ${sanitizeName(title, 'Muc')}/`;
export const formatTrackEntry = (folder: string, index: number, total: number, title: string) => `${folder}${formatPrefix(index, total)} - ${sanitizeName(title, 'Bai')}.mp3`;
