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
    .replace(/[\s+•▪▫●○◦◆◇‣⁃>→⇒~#]+$/gu, '')
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

function readRange(text: string, line: number, errors: ParseResult['errors']) {
  const suffix = /\(([^()]*)\)\s*$/.exec(text);
  if (!suffix || !/[\d:]/.test(suffix[1]) || !/[-–:]/.test(suffix[1])) return { title: text, range: null };
  const match = /^(\d+):(\d{2})\s*[-–]\s*(\d+):(\d{2})$/.exec(suffix[1].trim());
  const values = match?.slice(1).map(Number);
  if (!values || values[1] > 59 || values[3] > 59 || values[0] * 60 + values[1] >= values[2] * 60 + values[3]) {
    errors.push({ line, message: 'Khoảng thời gian không hợp lệ; dùng m:ss–m:ss, kết thúc sau bắt đầu.' });
    return { title: text, range: null };
  }
  return { title: text.slice(0, suffix.index).trim(), range: [values[0] * 60 + values[1], values[2] * 60 + values[3]] as const };
}

export function parsePlaylist(text: string): ParseResult {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((value, index) => ({ text: value.replace(/[*∗＊✱✲✳✴✵✶✷✸★☆]+/gu, ' ').trim(), line: index + 1 }))
    .filter(value => value.text);
  if (!lines.length) return { playlist: null, errors: [] };
  const errors: ParseResult['errors'] = [];
  const header = /^(?:[-+•▪▫]\s*)?\d+[.)]\s*(.*)$/;
  const hasSections = lines.some(value => header.test(value.text));
  const playlist: Playlist = { id: crypto.randomUUID(), title: 'Nhạc cưới', sections: [] };
  let section: Section | undefined;
  let defaultRange: readonly [number, number] | null = null;
  const titles: string[] = [];
  if (!hasSections) {
    section = { id: crypto.randomUUID(), title: 'Danh sách nhạc', tracks: [] };
    playlist.sections.push(section);
  }
  for (const value of lines) {
    const heading = header.exec(value.text);
    if (heading) {
      const parsed = readRange(cleanTitleText(heading[1]), value.line, errors);
      section = { id: crypto.randomUUID(), title: cleanTitleText(parsed.title), tracks: [] };
      playlist.sections.push(section);
      defaultRange = parsed.range;
      continue;
    }
    if (!section) { titles.push(cleanTitleText(value.text)); continue; }
    const rawCandidate = value.text.replace(/^[\s+•*∗＊✱✲✳✴✵✶✷✸★☆▪▫●○◦◆◇‣⁃–—―>→⇒-]+/gu, '').trim();
    if (/^\([^()]*\)$/.test(rawCandidate) && section.tracks.length) {
      const previous = section.tracks[section.tracks.length - 1];
      previous.note = [previous.note, rawCandidate].filter(Boolean).join('\n');
      continue;
    }
    const parsed = readRange(rawCandidate, value.line, errors);
    const extracted = extractTrailingNote(parsed.title);
    const finalTitle = extracted.title || cleanTitleText(parsed.title);
    const range = parsed.range ?? defaultRange;
    section.tracks.push({
      id: crypto.randomUUID(),
      title: finalTitle,
      query: buildSearchQuery(finalTitle),
      kind: 'music',
      note: extracted.note,
      startSeconds: range?.[0] ?? 0,
      endSeconds: range?.[1] ?? null,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
      selectedVideoId: null,
      assetId: null,
      confirmed: false,
      candidates: [],
    });
  }
  if (titles.length) playlist.title = titles.join(' · ');
  return { playlist, errors };
}
