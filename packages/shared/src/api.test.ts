import { describe, expect, it } from 'vitest';
import { AssetRequestSchema, ExportRequestSchema, SearchRequestSchema } from './api';

const id = '90000000-0000-4000-8000-000000000001';
const track = { id, title: 'Bài', assetId: id, startSeconds: 2, endSeconds: 10, fadeInSeconds: 1, fadeOutSeconds: 2, confirmed: true };
const request = (overrides = {}) => ({ playlistId: id, sections: [{ id, title: 'Mục', tracks: [{ ...track, ...overrides }] }] });

describe('API trust boundaries', () => {
  it.each(['id;touch /tmp/x', '../secrets', 'https://youtube.com/watch?v=abcdefghijk', 'abcdefghijk/../../x'])('rejects arbitrary source or path %s', videoId => {
    expect(AssetRequestSchema.safeParse({ videoId }).success).toBe(false);
  });
  it('accepts only a video ID and rejects extra command parameters', () => {
    expect(AssetRequestSchema.parse({ videoId: 'abcdefghijk' })).toEqual({ videoId: 'abcdefghijk' });
    expect(AssetRequestSchema.safeParse({ videoId: 'abcdefghijk', url: 'file:///etc/passwd' }).success).toBe(false);
  });
  it('bounds search work and rejects blank queries', () => {
    expect(SearchRequestSchema.safeParse({ query: ' ' }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ query: 'x'.repeat(501) }).success).toBe(false);
  });
  it.each([{ confirmed: false }, { endSeconds: 2 }, { fadeInSeconds: 7 }, { startSeconds: -1 }, { fadeOutSeconds: Infinity }])('rejects invalid export edits %j', overrides => {
    expect(ExportRequestSchema.safeParse(request(overrides)).success).toBe(false);
  });
  it('permits fade sum equal to segment length, and empty sections beside a song', () => {
    const value = request({ fadeInSeconds: 6 });
    value.sections.push({ id, title: 'Chỉ ghi chú', tracks: [] });
    expect(ExportRequestSchema.parse(value)).toEqual(value);
    expect(ExportRequestSchema.safeParse({ playlistId: id, sections: [{ id, title: '', tracks: [] }] }).success).toBe(false);
  });
});
