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
  it('recognizes unnumbered folder headers with numbered or inline tracks underneath', () => {
    const inline = parsePlaylist('Đón khách 1. Hát cho em, 2. Ba kể con nghe. MC dẫn 1. Bài hát.');
    expect(inline.playlist?.sections.map(s => ({
      title: s.title,
      tracks: s.tracks.map(t => t.title),
    }))).toEqual([
      { title: 'Đón khách', tracks: ['Hát cho em', 'Ba kể con nghe'] },
      { title: 'MC dẫn', tracks: ['Bài hát'] },
    ]);

    const multiline = parsePlaylist('Đón khách (0:10-1:00)\n1. Hát cho em\n2. Ba kể con nghe\nMC dẫn\n1. Bài hát');
    expect(multiline.playlist?.sections.map(s => ({
      title: s.title,
      tracks: s.tracks.map(t => [t.title, t.startSeconds, t.endSeconds]),
    }))).toEqual([
      { title: 'Đón khách', tracks: [['Hát cho em', 10, 60], ['Ba kể con nghe', 10, 60]] },
      { title: 'MC dẫn', tracks: [['Bài hát', 0, null]] },
    ]);

    const bulletedFolders = parsePlaylist('Đón khách\n- Hát cho em\n- Ba kể con nghe\nMC dẫn\n- Bài hát');
    expect(bulletedFolders.playlist?.sections.map(s => ({
      title: s.title,
      tracks: s.tracks.map(t => t.title),
    }))).toEqual([
      { title: 'Đón khách', tracks: ['Hát cho em', 'Ba kể con nghe'] },
      { title: 'MC dẫn', tracks: ['Bài hát'] },
    ]);
  });
  it('keeps a flat numbered list as tracks and preserves numeric song titles', () => {
    const { playlist } = parsePlaylist([
      '1. Mambo No. 5',
      '2. Symphony No. 5',
      '3. Love 2.0',
      '4. Perfect (Piano 2.0)',
    ].join('\n'));
    expect(playlist?.sections).toHaveLength(1);
    expect(playlist?.sections[0].tracks.map(track => track.title)).toEqual([
      'Mambo No. 5',
      'Symphony No. 5',
      'Love 2.0',
      'Perfect (Piano 2.0)',
    ]);
  });
  it('recognizes grouped numbered section headers without grouping a flat numbered list', () => {
    const { playlist } = parsePlaylist('1. Ceremony\nFirst dance\n2. Reception\nDinner song');
    expect(playlist?.sections.map(section => ({
      title: section.title,
      tracks: section.tracks.map(track => track.title),
    }))).toEqual([
      { title: 'Ceremony', tracks: ['First dance'] },
      { title: 'Reception', tracks: ['Dinner song'] },
    ]);
  });
  it('recognizes unnumbered wedding headings without turning plain songs into folders', () => {
    const { playlist } = parsePlaylist([
      'Đón khách', 'Hát cho em, Ba kể con nghe',
      'MC dẫn/mở đầu', 'Perfect & love',
      'Cô dâu', 'Beautiful in white',
      'Chú rể', 'I do',
      'Trao nhẫn', 'Perfect',
      'Rót rượu', 'Marry you',
      'Kết', 'A thousand years',
    ].join('\n'));
    expect(playlist?.sections.map(section => section.title)).toEqual([
      'Đón khách', 'MC dẫn/mở đầu', 'Cô dâu', 'Chú rể', 'Trao nhẫn', 'Rót rượu', 'Kết',
    ]);
    expect(playlist?.sections[0].tracks.map(track => track.title)).toEqual(['Hát cho em, Ba kể con nghe']);
    expect(playlist?.sections[1].tracks[0].title).toBe('Perfect & love');
  });
  it('supports markdown and labeled headers with mixed track markers', () => {
    const { playlist } = parsePlaylist([
      '# Ceremony',
      '\t•\u00a0Hát & yêu - acoustic',
      '**Mục 2: Dinner**',
      '* Perfect',
      'Folder: Final songs',
      'Last dance',
      'Thư mục 3 - Photos',
      'Photo song',
      'Phần 4: Farewell',
      'Last song',
    ].join('\n'));
    expect(playlist?.sections.map(section => section.title)).toEqual([
      'Ceremony', 'Dinner', 'Final songs', 'Photos', 'Farewell',
    ]);
    expect(playlist?.sections.map(section => section.tracks.map(track => track.title))).toEqual([
      ['Hát & yêu - acoustic'],
      ['Perfect'],
      ['Last dance'],
      ['Photo song'],
      ['Last song'],
    ]);
  });
  it('recognizes an arbitrary heading immediately before a numbered track group', () => {
    const { playlist } = parsePlaylist('Reception\n1. Love one\n2. Love two\nPlain finale');
    expect(playlist?.sections.map(section => ({
      title: section.title,
      tracks: section.tracks.map(track => track.title),
    }))).toEqual([
      { title: 'Reception', tracks: ['Love one', 'Love two', 'Plain finale'] },
    ]);
  });
  it('keeps plain songs inside a headed section when markers are mixed', () => {
    const { playlist } = parsePlaylist('# Ceremony\nPerfect\n1. Hơn cả yêu\n• Beautiful in white');
    expect(playlist?.sections.map(section => section.tracks.map(track => track.title))).toEqual([
      ['Perfect', 'Hơn cả yêu', 'Beautiful in white'],
    ]);
  });
  it('ignores formatting-only lines instead of creating empty sections or tracks', () => {
    expect(parsePlaylist('***\n**\n•\n-\n\u00a0').playlist).toBeNull();
  });
  it('treats colon lines as headings and splits their inline songs on semicolons', () => {
    const { playlist } = parsePlaylist('Đón khách: Hát cho em; Ba kể con nghe\nMC dẫn: Perfect');
    expect(playlist?.sections.map(section => ({
      title: section.title,
      tracks: section.tracks.map(track => track.title),
    }))).toEqual([
      { title: 'Đón khách', tracks: ['Hát cho em', 'Ba kể con nghe'] },
      { title: 'MC dẫn', tracks: ['Perfect'] },
    ]);
  });
  it('prioritizes track ranges and keeps notes after a range', () => {
    const { playlist, errors } = parsePlaylist([
      '# Ceremony (0:00.5-0:02.5)',
      '1. Song (1:02:03-1:03:04) (bản gốc)',
      '(editorial note)',
      '2. Mambo No. 5',
      '3. Symphony No. 5',
      '4. Love 2.0',
      '5. Perfect (Piano 2.0)',
      '6. https://example.com/5. song',
    ].join('\n'));
    expect(errors).toEqual([]);
    expect(playlist?.sections[0].tracks.map(track => track.title)).toEqual([
      'Song', 'Mambo No. 5', 'Symphony No. 5', 'Love 2.0', 'Perfect (Piano 2.0)', 'https://example.com/5. song',
    ]);
    expect(playlist?.sections[0].tracks[0]).toMatchObject({
      startSeconds: 3723,
      endSeconds: 3784,
      note: '(bản gốc)\n(editorial note)',
    });
    expect(playlist?.sections[0].tracks[1]).toMatchObject({ startSeconds: 0.5, endSeconds: 2.5 });
  });
  it('keeps ordinary songs beneath colon headings and repeated numbered track groups', () => {
    for (const text of [
      'Reception:\nLove one\nLove two\nDinner:\nPerfect',
      'Reception\n1. Love one\n2. Love two\nDinner\n1. Perfect',
    ]) {
      expect(parsePlaylist(text).playlist?.sections.map(section => ({
        title: section.title, songs: section.tracks.map(track => track.title),
      }))).toEqual([
        { title: 'Reception', songs: ['Love one', 'Love two'] },
        { title: 'Dinner', songs: ['Perfect'] },
      ]);
    }
  });
  it('retains orphan notes in their own section instead of attaching across folders', () => {
    const { playlist } = parsePlaylist('# Ceremony\nPerfect\n# Dinner\n(chờ MC)\nMarry you');
    expect(playlist?.sections[0].tracks[0].note).toBe('');
    expect(playlist?.sections[1].tracks.map(track => ({ title: track.title, kind: track.kind }))).toEqual([
      { title: '(chờ MC)', kind: 'note' },
      { title: 'Marry you', kind: 'music' },
    ]);
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
