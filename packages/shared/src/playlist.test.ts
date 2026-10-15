import { describe, expect, it } from 'vitest';
import { buildSearchQuery, parsePlaylist, sanitizeSearchQuery } from './playlist';

const fixture = `Nhạc cưới\n1. Đón khách\n+ Hơn cả yêu\n• Perfect violin & piano instrumental\n- Perfect lyrics\nUntil I Found You Acoustic\nBeautiful in white\nNgày đầu tiên\nÁnh nắng của anh\nCầu hôn\n2) MC mở đầu\nVideo câu chuyện tình yêu\n3. Cô dâu (1:07–2:10)\nA thousand years- Phiên bản cinematic orchestral\n(phần cao trào)\n4. Chú rể (0:48-1:35)\nPerfect\n5. Trao nhẫn (1:00–1:50)\nI do\n6. Rót rượu (0:52–1:35)\nMarry you\n7. Kết (0:50–1:35)\nA thousand years`;

describe('playlist review model', () => {
  it('preserves seven ordered sections and all fourteen original music rows', () => {
    const { playlist, errors } = parsePlaylist(fixture.replace(/\n/g, '\r\n'));
    expect(errors).toEqual([]);
    expect(playlist?.sections.map(s => s.tracks.length)).toEqual([8, 1, 1, 1, 1, 1, 1]);
    expect(playlist?.sections[2].tracks[0]).toMatchObject({ title: 'A thousand years- Phiên bản cinematic orchestral', startSeconds: 67, endSeconds: 130, note: '(phần cao trào)' });
    expect(playlist?.sections.slice(3).map(s => [s.tracks[0].startSeconds, s.tracks[0].endSeconds])).toEqual([[48, 95], [60, 110], [52, 95], [50, 95]]);
    playlist!.sections[1].tracks[0].kind = 'note';
    expect(playlist?.sections.flatMap(s => s.tracks).filter(t => t.kind === 'music')).toHaveLength(13);
    expect(playlist?.sections).toHaveLength(7);
  });
  it('uses array order, independent IDs and track range precedence', () => {
    const { playlist } = parsePlaylist('- 9) Trùng (0:20-0:40)\n+ Bài (0:21-0:30)\n1. Trùng\nBài');
    expect(playlist?.sections.map(s => s.title)).toEqual(['Trùng', 'Trùng']);
    const tracks = playlist!.sections.flatMap(s => s.tracks);
    expect(tracks[0]).toMatchObject({ title: 'Bài', query: 'Bài lyrics', startSeconds: 21, endSeconds: 30 });
    expect(new Set([playlist!.id, ...playlist!.sections.map(s => s.id), ...tracks.map(t => t.id)]).size).toBe(5);
  });
  it('does not treat a non-numbered first line as a playlist heading', () => {
    expect(parsePlaylist('Perfect\n+ Hơn cả yêu').playlist?.sections[0].tracks.map(t => t.title)).toEqual(['Perfect', 'Hơn cả yêu']);
    expect(parsePlaylist(' \r\n ').playlist).toBeNull();
  });
  it.each(['0:70-2:10', '2:10-1:07', '1:07-bad', '1:7-2:10'])('reports original line on invalid range %s', range => {
    expect(parsePlaylist(`Tiêu đề\n1. Mục\nBài (${range})`).errors).toEqual([expect.objectContaining({ line: 3 })]);
  });
  it('strips leading asterisks/bullets and moves inline editorial notes like (bản gốc có lời) out of title and query', () => {
    const { playlist } = parsePlaylist('**1. Rót rượu (0:52–1:35)**\n- * Marry you (bản gốc có lời)');
    expect(playlist?.sections[0].title).toBe('Rót rượu');
    expect(playlist?.sections[0].tracks[0]).toMatchObject({
      title: 'Marry you',
      note: '(bản gốc có lời)',
      query: 'Marry you lyrics',
      startSeconds: 52,
      endSeconds: 95,
    });
    expect(sanitizeSearchQuery('* Marry you (bản gốc có lời) lyrics')).toBe('Marry you lyrics');
  });
});

describe('query instrument boundaries', () => {
  it.each([
    ['Hơn cả yêu', 'Hơn cả yêu lyrics'], ['Perfect violin & piano instrumental', 'Perfect violin & piano instrumental'],
    ['Hơn cả yêu PIANO', 'Hơn cả yêu PIANO'], ['Perfect lyrics', 'Perfect lyrics'], ['Perfect instrumental', 'Perfect instrumental'],
    ['Until I Found You Acoustic', 'Until I Found You Acoustic lyrics'], ['Sáo không lời', 'Sáo không lời'],
    ['Organic love', 'Organic love lyrics'], ['Pianola', 'Pianola lyrics'], ['ĐÀN BẦU tình ca', 'ĐÀN BẦU tình ca'],
    ['* Hơn cả yêu *', 'Hơn cả yêu lyrics'], ['Beautiful in white *** @#$%', 'Beautiful in white lyrics'],
    ['* Marry you (bản gốc có lời)', 'Marry you lyrics'], ['Marry you - bản gốc có lời', 'Marry you lyrics'], ['', ''],
  ])('%s → %s', (title, expected) => expect(buildSearchQuery(title)).toBe(expected));
});
