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

const NUMBERED_LINE = /^(?:[-+•▪▫]\s*)?(\d+)[.)]\s*(.*)$/;
const BULLET_LINE = /^[+•▪▫●○◦◆◇‣⁃–—―>→⇒-]\s*(.*)$/;
const NOTE_LINE = /^\([^()]*\)$/;

function expandInlineLines(rawLines: Array<{ text: string; line: number }>): Array<{ text: string; line: number }> {
  const expanded: Array<{ text: string; line: number }> = [];
  for (const item of rawLines) {
    const hasInlineStart = !NUMBERED_LINE.test(item.text) && /\s+1[.)]\s+\S/.test(item.text);
    const hasMultiNumbered = NUMBERED_LINE.test(item.text) && /(?:[,;]\s*|\s+)\d+[.)]\s+\S/.test(item.text);
    if (!hasInlineStart && !hasMultiNumbered) {
      expanded.push(item);
      continue;
    }
    const sentenceChunks = item.text
      .replace(/([.!?])\s+([^\d,.!?;:\n]+?)\s+(?=1[.)]\s+)/g, '$1\n$2\n')
      .split('\n');
    for (const chunk of sentenceChunks) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      const splitBeforeOne = !NUMBERED_LINE.test(trimmed)
        ? trimmed.replace(/\s+(?=1[.)]\s+)/, '\n').split('\n')
        : [trimmed];
      for (const part of splitBeforeOne) {
        const p = part.trim();
        if (!p) continue;
        if (NUMBERED_LINE.test(p)) {
          const items = p.split(/(?:[,;]\s*|\s+)(?=\d+[.)]\s+)/);
          for (const sub of items) {
            const cleanSub = sub.replace(/[,;.]+\s*$/, '').trim();
            if (cleanSub) expanded.push({ text: cleanSub, line: item.line });
          }
        } else {
          expanded.push({ text: p.replace(/[,;.]+\s*$/, '').trim(), line: item.line });
        }
      }
    }
  }
  return expanded;
}

export function parsePlaylist(text: string): ParseResult {
  const rawLines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((value, index) => ({ text: value.replace(/[*∗＊✱✲✳✴✵✶✷✸★☆]+/gu, ' ').trim(), line: index + 1 }))
    .filter(value => value.text);
  if (!rawLines.length) return { playlist: null, errors: [] };

  const lines = expandInlineLines(rawLines);
  const errors: ParseResult['errors'] = [];
  const playlist: Playlist = { id: crypto.randomUUID(), title: 'Nhạc cưới', sections: [] };

  const hasNumbered = lines.some(l => NUMBERED_LINE.test(l.text));
  // Check if numbered lines are tracks under unnumbered folder headers (e.g. "Đón khách\n1. Hát cho em\n2. Ba kể con nghe\nMC dẫn\n1. Bài hát")
  const numberedAreTracks = hasNumbered && (() => {
    let sawPlainBeforeNumbered = false;
    for (let i = 0; i < lines.length; ++i) {
      const cur = lines[i].text;
      const next = lines[i + 1]?.text;
      const curNum = NUMBERED_LINE.exec(cur);
      if (!curNum && !NOTE_LINE.test(cur) && !BULLET_LINE.test(cur)) {
        if (next && NUMBERED_LINE.test(next)) sawPlainBeforeNumbered = true;
      }
      if (curNum) {
        // If a numbered line is followed by a bulleted line, or followed by an unnumbered non-note line that is NOT itself a header before another numbered line, then numbered lines are sections.
        if (next && !NUMBERED_LINE.test(next) && !NOTE_LINE.test(next)) {
          const afterNext = lines[i + 2]?.text;
          const nextIsHeaderBeforeNumbered = !BULLET_LINE.test(next) && Boolean(afterNext && NUMBERED_LINE.test(afterNext));
          if (!nextIsHeaderBeforeNumbered) return false;
        }
      }
    }
    return sawPlainBeforeNumbered;
  })();

  // Check if there are no numbers at all, but unbulleted folder headers precede bulleted tracks (e.g. "Đón khách\n- Hát cho em\nMC dẫn\n- Bài hát" or "Đón khách:\nHát cho em")
  const unnumberedFoldersWithBullets = !hasNumbered && (() => {
    const colonHeaders = lines.some(l => !NOTE_LINE.test(l.text) && !BULLET_LINE.test(l.text) && /:\s*$/.test(l.text));
    if (colonHeaders) return true;
    let headerCount = 0;
    for (let i = 0; i < lines.length; ++i) {
      const cur = lines[i].text;
      const next = lines[i + 1]?.text;
      if (!NOTE_LINE.test(cur) && !BULLET_LINE.test(cur) && next && BULLET_LINE.test(next)) {
        ++headerCount;
      }
    }
    return headerCount >= 2;
  })();

  let section: Section | undefined;
  let defaultRange: readonly [number, number] | null = null;
  const titles: string[] = [];

  const pushTrack = (rawText: string, lineNo: number) => {
    if (!section) {
      section = { id: crypto.randomUUID(), title: 'Danh sách nhạc', tracks: [] };
      playlist.sections.push(section);
    }
    const stripped = rawText
      .replace(/^(?:[-+•▪▫]\s*)?\d+[.)]\s*/, '')
      .replace(/^[\s+•*∗＊✱✲✳✴✵✶✷✸★☆▪▫●○◦◆◇‣⁃–—―>→⇒-]+/gu, '')
      .trim();
    if (NOTE_LINE.test(stripped) && section.tracks.length) {
      const previous = section.tracks[section.tracks.length - 1];
      previous.note = [previous.note, stripped].filter(Boolean).join('\n');
      return;
    }
    const parsed = readRange(stripped, lineNo, errors);
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
  };

  if (numberedAreTracks) {
    for (const value of lines) {
      const isNum = NUMBERED_LINE.test(value.text);
      const isNote = NOTE_LINE.test(value.text);
      const isBul = BULLET_LINE.test(value.text);
      if (!isNum && !isNote && !isBul) {
        const parsed = readRange(cleanTitleText(value.text), value.line, errors);
        section = { id: crypto.randomUUID(), title: cleanTitleText(parsed.title), tracks: [] };
        playlist.sections.push(section);
        defaultRange = parsed.range;
      } else {
        pushTrack(value.text, value.line);
      }
    }
    return { playlist, errors };
  }

  if (unnumberedFoldersWithBullets) {
    for (const value of lines) {
      const isNote = NOTE_LINE.test(value.text);
      const isBul = BULLET_LINE.test(value.text);
      const isColonHeader = !isNote && !isBul && /:\s*$/.test(value.text);
      if (isColonHeader || (!isNote && !isBul)) {
        const parsed = readRange(cleanTitleText(value.text), value.line, errors);
        section = { id: crypto.randomUUID(), title: cleanTitleText(parsed.title), tracks: [] };
        playlist.sections.push(section);
        defaultRange = parsed.range;
      } else {
        pushTrack(value.text, value.line);
      }
    }
    return { playlist, errors };
  }

  if (!hasNumbered) {
    section = { id: crypto.randomUUID(), title: 'Danh sách nhạc', tracks: [] };
    playlist.sections.push(section);
  }

  for (const value of lines) {
    const heading = NUMBERED_LINE.exec(value.text);
    if (heading) {
      const parsed = readRange(cleanTitleText(heading[2]), value.line, errors);
      section = { id: crypto.randomUUID(), title: cleanTitleText(parsed.title), tracks: [] };
      playlist.sections.push(section);
      defaultRange = parsed.range;
      continue;
    }
    if (!section) {
      titles.push(cleanTitleText(value.text));
      continue;
    }
    pushTrack(value.text, value.line);
  }
  if (titles.length) playlist.title = titles.join(' · ');
  return { playlist, errors };
}
