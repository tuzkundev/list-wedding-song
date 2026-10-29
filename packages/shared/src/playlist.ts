import { z } from 'zod';
import { CandidateSchema, IdSchema, VideoIdSchema } from './api';

export const TrackSchema = z.object({
  id: IdSchema, title: z.string(), query: z.string(), kind: z.enum(['music', 'note']), note: z.string(),
  startSeconds: z.number(), endSeconds: z.number().nullable(), fadeInSeconds: z.number(), fadeOutSeconds: z.number(),
  selectedVideoId: VideoIdSchema.nullable(), assetId: IdSchema.nullable(), confirmed: z.boolean(), candidates: z.array(CandidateSchema),
});
export const PlaylistSchema = z.object({ id: IdSchema, title: z.string(), sections: z.array(z.object({ id: IdSchema, title: z.string(), tracks: z.array(TrackSchema) })) });
export type Track = z.infer<typeof TrackSchema>;
export type Playlist = z.infer<typeof PlaylistSchema>;
export type Section = Playlist['sections'][number];
export interface ParseResult { playlist: Playlist | null; errors: { line: number; message: string }[] }

const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase();
const instrumental = /(?:^|[^a-z0-9])(?:piano|violon|violin|guitar(?:\s+acoustic)?|saxophone|sax|flute|cello|organ|trumpet|trong|sao|dan\s+tranh|dan\s+bau|instrumental|khong\s+loi|lyrics)(?=$|[^a-z0-9])/;
const musicalKeepInParen = /(?:^|[^a-z0-9])(?:piano|violon|violin|guitar|saxophone|sax|flute|cello|organ|trumpet|trong|sao|dan\s+tranh|dan\s+bau|instrumental|khong\s+loi|acoustic|cover|remix|live|orchestral|cinematic)(?=$|[^a-z0-9])/;
const editorialPhrase = /(?:^|\s)(?:ban\s+goc\s+co\s+loi|ban\s+co\s+loi|ban\s+goc|co\s+loi|phan\s+cao\s+trao|doan\s+cao\s+trao|phan\s+diep\s+khuc|doan\s+diep\s+khuc|doan\s+dau|doan\s+cuoi)(?=$|\s)/i;

export function cleanTitleText(raw: string): string {
  return raw
    .replace(/[*∗＊✱✲✳✴✵✶✷✸★☆]+/gu, ' ')
    .replace(/^[\s+•▪▫●○◦◆◇‣⁃–—―>→⇒~#-]+/gu, '')
    .replace(/[\s+•▪▫●○◦◆◇‣⁃>→⇒~#:.,;]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractTrailingNote(raw: string): { title: string; note: string } {
  let title = cleanTitleText(raw);
  const notes: string[] = [];
  for (;;) {
    const suffix = /\(([^()]+)\)\s*$/.exec(title);
    if (!suffix) break;
    const inner = suffix[1].trim(), folded = fold(inner);
    if (musicalKeepInParen.test(folded) && !editorialPhrase.test(folded)) break;
    notes.unshift(`(${inner})`);
    title = cleanTitleText(title.slice(0, suffix.index));
  }
  return { title, note: notes.join(' ') };
}

function stripEditorialNotes(value: string): string {
  const withoutParen = value.replace(/\(([^()]*)\)/g, (_full, inner: string) => {
    const folded = fold(inner);
    return musicalKeepInParen.test(folded) && !editorialPhrase.test(folded) ? ` ${inner} ` : ' ';
  });
  const tokens = withoutParen
    .replace(/[^\p{L}\p{N}&\s-]+/gu, ' ')
    .replace(/^[\s&-]+|[\s&-]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const removeRanges: Array<[string, string]> = [
    ['bản gốc có lời', 'ban goc co loi'],
    ['bản có lời', 'ban co loi'],
    ['bản gốc', 'ban goc'],
    ['có lời', 'co loi'],
    ['phần cao trào', 'phan cao trao'],
    ['đoạn cao trào', 'doan cao trao'],
    ['phần điệp khúc', 'phan diep khuc'],
    ['đoạn điệp khúc', 'doan diep khuc'],
  ];
  let result = tokens;
  for (const [vn, ascii] of removeRanges) {
    result = result.replace(new RegExp(`(?:^|\\s|-)(?:${vn}|${ascii})(?=$|\\s|-)`, 'giu'), ' ');
  }
  return result.replace(/^[\s&-]+|[\s&-]+$/gu, '').replace(/\s+/g, ' ').trim();
}

export function sanitizeSearchQuery(rawQuery: string): string {
  return stripEditorialNotes(rawQuery);
}

export function buildSearchQuery(title: string): string {
  const clean = stripEditorialNotes(title);
  return !clean || instrumental.test(fold(clean)) ? clean : `${clean} lyrics`;
}

function parseTimeValue(value: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const parts = value.split(':');
  if (parts.length < 2 || parts.length > 3 || !/^\d+$/.test(parts[0])) return null;
  if (!parts.slice(1, -1).every(part => /^\d{2}$/.test(part) && Number(part) < 60)) return null;
  if (!/^\d{2}(?:\.\d+)?$/.test(parts[parts.length - 1]) || Number(parts[parts.length - 1]) >= 60) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

function readRange(text: string, line: number, errors: ParseResult['errors']) {
  const parentheses = /\(([^()]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = parentheses.exec(text))) {
    const content = match[1].trim();
    const after = text.slice(match.index + match[0].length);
    if (!/\d/.test(content) || !/[-–]/.test(content) || !/^\s*(?:\([^()]*\)\s*)*$/.test(after)) continue;
    const range = /^(.+?)\s*[-–]\s*(.+)$/.exec(content);
    const start = range ? parseTimeValue(range[1].trim()) : null;
    const end = range ? parseTimeValue(range[2].trim()) : null;
    if (start === null || end === null || start >= end) {
      errors.push({ line, message: 'Khoảng thời gian không hợp lệ; dùng m:ss–m:ss, kết thúc sau bắt đầu.' });
      return { title: text, range: null };
    }
    return {
      title: `${text.slice(0, match.index)}${after}`.trim(),
      range: [start, end] as const,
    };
  }
  return { title: text, range: null };
}

const NUMBERED_LINE = /^(?:[-+*•▪▫●○◦◆◇‣⁃–—―>→⇒]\s*)?(\d+)[.)]\s*(.*)$/;
const BULLET_LINE = /^[+*•▪▫●○◦◆◇‣⁃–—―>→⇒-]\s*(.*)$/;
const NOTE_LINE = /^\([^()]*\)$/;
const BULLET_PREFIX = /^[+*•▪▫●○◦◆◇‣⁃–—―>→⇒-]\s*/;

interface SourceLine { text: string; line: number; }
interface Entry extends SourceLine { kind: 'heading' | 'content'; }
interface NumberMarker { start: number; end: number; value: string; punctuation: string; }

function unwrapFormatting(value: string): { text: string; heading: boolean } {
  let text = value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const markdown = /^#{1,6}(?:\s+|$)(.*)$/.exec(text);
  if (markdown) return { text: markdown[1].trim(), heading: true };
  const bold = /^(\*\*|__)(.+)\1$/.exec(text);
  if (bold) return { text: bold[2].trim(), heading: true };
  const italic = /^\*([^*]+)\*$/.exec(text);
  if (italic) text = italic[1].trim();
  const strike = /^~~(.+)~~$/.exec(text);
  if (strike) text = strike[1].trim();
  return { text, heading: false };
}

function sectionLabel(value: string): string | null {
  const match = /^(?:folder|thư\s+mục|mục|phần)(?=\s|:|：|[-–—]|$)\s*(?:\d+\s*)?(?::\s*|：\s*|[-–—]\s*|\s+)(.+)$/iu.exec(value.trim());
  return match?.[1].trim() || null;
}

function normalizedHeadingTitle(value: string): string {
  const rangeFree = value.replace(/\s*\([^()]*\d[^()]*[-–][^()]*\)\s*$/, '');
  return fold(cleanTitleText(rangeFree)).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const KNOWN_HEADINGS: Record<string, true> = {
  'don khach': true, 'mc dan': true, 'mc mo dau': true, 'mo dau': true, 'mc dan mo dau': true,
  'co dau': true, 'chu re': true, 'co dau chu re': true, 'chu re co dau': true,
  'trao nhan': true, 'rot ruou': true, 'ket': true,
};

function isKnownHeading(value: string): boolean {
  return Boolean(KNOWN_HEADINGS[normalizedHeadingTitle(value)]);
}

function findNumberMarkers(value: string): NumberMarker[] {
  const markers: NumberMarker[] = [];
  const pattern = /(\d+)([.)])(?=[\s\u00a0]+\S)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    const start = match.index;
    const before = value.slice(0, start);
    const previous = value[start - 1] ?? '';
    if (start > 0 && !/[\s,;]/.test(previous)) continue;
    if (/\bno\.\s*$/i.test(before)) continue;
    let depth = 0;
    for (const character of before) {
      if (character === '(') depth++;
      else if (character === ')') depth = Math.max(0, depth - 1);
    }
    if (depth) continue;
    const lastSpace = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\t'), before.lastIndexOf('\n'));
    const lastUrl = Math.max(before.lastIndexOf('http://'), before.lastIndexOf('https://'));
    if (lastUrl > lastSpace) continue;
    const end = pattern.lastIndex;
    const whitespace = /^[\s\u00a0]+/.exec(value.slice(end))?.[0].length ?? 0;
    markers.push({ start, end: end + whitespace, value: match[1], punctuation: match[2] });
  }
  return markers;
}

function splitInlineHeadingSuffix(value: string): { track: string; heading: string } | null {
  const boundaries = /[.!?]\s+/g;
  let boundary: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((boundary = boundaries.exec(value))) last = boundary;
  if (!last) return null;
  const heading = value.slice(last.index + last[0].length).trim();
  if (!heading || !(isKnownHeading(heading) || sectionLabel(heading) !== null)) return null;
  return { track: value.slice(0, last.index + 1).trim(), heading };
}

function splitNumberedLine(value: string, line: number): Entry[] | null {
  const markers = findNumberMarkers(value);
  if (!markers.length) return null;
  const entries: Entry[] = [];
  const prefix = cleanTitleText(value.slice(0, markers[0].start));
  if (prefix) entries.push({ text: prefix, line, kind: 'heading' });
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index];
    const end = markers[index + 1]?.start ?? value.length;
    const body = value.slice(marker.end, end).trim();
    const split = index < markers.length - 1 ? splitInlineHeadingSuffix(body) : null;
    const trackText = split?.track ?? body;
    if (cleanTitleText(trackText)) {
      entries.push({ text: `${marker.value}${marker.punctuation} ${trackText}`, line, kind: 'content' });
    }
    if (split) entries.push({ text: split.heading, line, kind: 'heading' });
  }
  return entries;
}

function findColon(value: string): number {
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '(') depth++;
    else if (value[index] === ')') depth = Math.max(0, depth - 1);
    else if ((value[index] === ':' || value[index] === '：') && depth === 0) return index;
  }
  return -1;
}

function entriesForContent(value: string, line: number): Entry[] {
  const marker = NUMBERED_LINE.exec(value);
  const bullet = !marker && BULLET_LINE.test(value);
  const base = marker?.[2] ?? value.replace(BULLET_PREFIX, '');

  const label = sectionLabel(base);
  if (label) return [{ text: label, line, kind: 'heading' }];

  const colon = !bullet && (!marker || isKnownHeading(base.slice(0, findColon(base)))) && !/^https?:\/\//i.test(base)
    ? findColon(base)
    : -1;
  if (colon >= 0) {
    const header = base.slice(0, colon).trim();
    const remainder = base.slice(colon + 1).trim();
    if (header) {
      const entries: Entry[] = [{ text: header, line, kind: 'heading' }];
      if (!remainder) return entries;
      const numbered = splitNumberedLine(remainder, line);
      if (numbered) {
        entries.push(...numbered);
      } else {
        for (const track of remainder.split(/;\s*/).map(part => part.trim()).filter(Boolean)) {
          entries.push({ text: track, line, kind: 'content' });
        }
      }
      return entries;
    }
  }

  const inline = splitNumberedLine(value, line);
  if (inline) return inline;
  return [{ text: value, line, kind: 'content' }];
}

function trackText(value: string): string {
  return value
    .replace(/^(?:[-+*•▪▫●○◦◆◇‣⁃–—―>→⇒]\s*)?\d+[.)]\s*/, '')
    .replace(BULLET_PREFIX, '')
    .trim();
}

function headingText(value: string): string {
  return trackText(value).replace(/:\s*$/, '').trim();
}

function isNumbered(value: string): boolean {
  return NUMBERED_LINE.test(value);
}

function hasBulletPrefix(value: string): boolean {
  return BULLET_LINE.test(value);
}

function findSectionHeadings(entries: Entry[]): boolean[] {
  const numbered = entries.map(entry => NUMBERED_LINE.exec(entry.text));
  const headings = entries.map((entry, index) => entry.kind === 'heading' ||
    (!hasBulletPrefix(entry.text) || numbered[index] !== null) &&
    isKnownHeading(numbered[index]?.[2] ?? entry.text));

  // Legacy numbered folders have song lines after every numbered heading.
  // Consecutive numbered lines without song lines between them are tracks instead.
  const numberedIndexes: number[] = [];
  let allGroupsHaveSongs = true;
  let groupHasSong = false;
  let hasPlainHeading = false;
  for (let index = 0; index < entries.length; index++) {
    if (headings[index] && !numbered[index]) hasPlainHeading = true;
    if (numbered[index]) {
      if (numberedIndexes.length && !groupHasSong) allGroupsHaveSongs = false;
      numberedIndexes.push(index);
      groupHasSong = false;
    } else if (!NOTE_LINE.test(entries[index].text)) {
      groupHasSong = true;
    }
  }
  if (!hasPlainHeading && numberedIndexes.length > 1 && allGroupsHaveSongs && groupHasSong) {
    for (const index of numberedIndexes) headings[index] = true;
  }

  let hasHeading = false;
  let lastTrackNumber: number | null = null;
  for (let index = 0; index < entries.length; index++) {
    if (headings[index]) {
      hasHeading = true;
      lastTrackNumber = null;
      continue;
    }
    if (numbered[index]) {
      lastTrackNumber = Number(numbered[index]![1]);
      continue;
    }
    const entry = entries[index];
    const nextNumber = numbered[index + 1];
    if (!nextNumber || headings[index + 1] || NOTE_LINE.test(entry.text) || hasBulletPrefix(entry.text)) continue;
    const restartsNumbering = lastTrackNumber !== null && Number(nextNumber[1]) <= lastTrackNumber;
    if ((!hasHeading && lastTrackNumber === null) || restartsNumbering) {
      headings[index] = true;
      hasHeading = true;
      lastTrackNumber = null;
    }
  }
  return headings;
}

export function parsePlaylist(text: string): ParseResult {
  const rawLines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((value, index) => ({ ...unwrapFormatting(value), line: index + 1 }))
    .filter(value => value.text && !/^[\s+*•▪▫●○◦◆◇‣⁃–—―>→⇒#-]+$/u.test(value.text));
  if (!rawLines.length) return { playlist: null, errors: [] };

  const entries = rawLines.flatMap(value => {
    if (value.heading) {
      const cleaned = headingText(value.text);
      const title = sectionLabel(cleaned) ?? cleaned;
      return title ? [{ text: title, line: value.line, kind: 'heading' as const }] : [];
    }
    return entriesForContent(value.text, value.line);
  });
  if (!entries.length) return { playlist: null, errors: [] };

  const errors: ParseResult['errors'] = [];
  const playlist: Playlist = { id: crypto.randomUUID(), title: 'Nhạc cưới', sections: [] };
  const headingIndexes = findSectionHeadings(entries);
  const firstHeading = headingIndexes.indexOf(true);
  // Preserve the existing playlist-title prelude before numbered folder headings.
  const hasTitlePrelude = firstHeading > 0 && isNumbered(entries[firstHeading].text) &&
    entries.slice(0, firstHeading).every(entry => entry.kind === 'content' &&
      !isNumbered(entry.text) && !hasBulletPrefix(entry.text) && !NOTE_LINE.test(entry.text));
  const ignoredPreludeEnd = hasTitlePrelude ? firstHeading : 0;
  if (hasTitlePrelude) playlist.title = entries.slice(0, firstHeading).map(entry => cleanTitleText(entry.text)).join(' · ');

  let section: Section | undefined;
  let defaultRange: readonly [number, number] | null = null;
  let previousTrack: Track | undefined;

  const ensureDefaultSection = () => {
    if (!section) {
      section = { id: crypto.randomUUID(), title: 'Danh sách nhạc', tracks: [] };
      playlist.sections.push(section);
    }
  };

  const pushTrack = (rawText: string, lineNo: number) => {
    const stripped = trackText(rawText);
    if (!stripped) return;
    const standaloneNote = NOTE_LINE.test(stripped);
    if (standaloneNote && previousTrack) {
      previousTrack.note = [previousTrack.note, stripped].filter(Boolean).join('\n');
      return;
    }
    ensureDefaultSection();
    const parsed = readRange(stripped, lineNo, errors);
    const extracted = extractTrailingNote(parsed.title);
    const finalTitle = standaloneNote ? stripped : extracted.title || cleanTitleText(parsed.title);
    if (!finalTitle) return;
    const range = parsed.range ?? defaultRange;
    const track: Track = {
      id: crypto.randomUUID(),
      title: finalTitle,
      query: standaloneNote ? '' : buildSearchQuery(finalTitle),
      kind: standaloneNote ? 'note' : 'music',
      note: standaloneNote ? '' : extracted.note,
      startSeconds: range?.[0] ?? 0,
      endSeconds: range?.[1] ?? null,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
      selectedVideoId: null,
      assetId: null,
      confirmed: false,
      candidates: [],
    };
    section!.tracks.push(track);
    previousTrack = track;
  };

  for (let index = ignoredPreludeEnd; index < entries.length; index++) {
    const value = entries[index];
    if (headingIndexes[index]) {
      const parsed = readRange(headingText(value.text), value.line, errors);
      const title = cleanTitleText(parsed.title);
      if (!title) continue;
      section = { id: crypto.randomUUID(), title, tracks: [] };
      playlist.sections.push(section);
      defaultRange = parsed.range;
      previousTrack = undefined;
      continue;
    }
    pushTrack(value.text, value.line);
  }
  return { playlist: playlist.sections.length ? playlist : null, errors };
}
