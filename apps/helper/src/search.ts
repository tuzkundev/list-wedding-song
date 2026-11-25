import { z } from 'zod';
import { SearchRequestSchema, SearchResponseSchema, VideoIdSchema, type Candidate } from '@wedding/shared/api';
import { extractYouTubeVideoId, sanitizeSearchQuery, youtubeWatchUrl } from '@wedding/shared/playlist';
import { ProcessExecutionError, runProcess } from './process.js';
import { AppError } from './server.js';

const EntrySchema = z.object({ id: z.unknown(), title: z.unknown().optional(), channel: z.unknown().optional(), duration: z.unknown().optional(), thumbnails: z.array(z.object({ url: z.string() })).optional() }).passthrough();
export function sourceError(error: unknown): AppError {
  if (error instanceof ProcessExecutionError) {
    if (error.reason === 'timeout') return new AppError(502, 'SOURCE_TIMEOUT', 'YouTube phản hồi quá lâu. Hãy thử lại thủ công.');
    if (error.reason === 'aborted') return new AppError(502, 'CANCELLED', 'Đã hủy yêu cầu.');
    if (/network|resolve|connection|unreachable|timed out|ssl|certificate/i.test(error.stderr)) return new AppError(502, 'SOURCE_OFFLINE', 'Không kết nối được YouTube. Kiểm tra mạng rồi thử lại.');
    if (/sign in|not available|unavailable|private|restricted|blocked|403|429|bot|copyright|DRM/i.test(error.stderr)) return new AppError(502, 'SOURCE_REJECTED', 'YouTube từ chối hoặc nội dung bị hạn chế. Chọn bản khác; helper không vượt đăng nhập, DRM hay chặn vùng.');
  }
  return new AppError(502, 'SOURCE_ERROR', 'Không đọc được nguồn YouTube. Hãy thử lại hoặc chọn bản khác.');
}

function toCandidate(item: z.infer<typeof EntrySchema>): Candidate {
  const thumbnail = item.thumbnails?.find(value => /^https:\/\//.test(value.url) && z.string().url().safeParse(value.url).success)?.url ?? null;
  return { videoId: item.id as string, title: typeof item.title === 'string' ? item.title : null, channel: typeof item.channel === 'string' ? item.channel : null, durationSeconds: typeof item.duration === 'number' && Number.isFinite(item.duration) && item.duration >= 0 ? item.duration : null, thumbnailUrl: thumbnail, webpageUrl: youtubeWatchUrl(item.id as string) };
}

export async function searchYouTube(query: string, runtimeArgs: string[], signal?: AbortSignal): Promise<{ candidates: Candidate[] }> {
  const request = SearchRequestSchema.parse({ query });
  const cleanQuery = sanitizeSearchQuery(request.query) || request.query;
  const linkedVideoId = extractYouTubeVideoId(request.query);
  try {
    if (linkedVideoId) {
      const single = await runProcess('yt-dlp', ['--ignore-config', '--no-plugin-dirs', '--no-remote-components', ...runtimeArgs, '--dump-single-json', '--skip-download', '--no-playlist', '--socket-timeout', '15', '--retries', '0', '--extractor-retries', '0', '--', youtubeWatchUrl(linkedVideoId)], { timeoutMs: 60_000, signal });
      const entry = EntrySchema.parse(JSON.parse(single.stdout.toString()));
      return SearchResponseSchema.parse({ candidates: [toCandidate({ ...entry, id: linkedVideoId })] });
    }
    const result = await runProcess('yt-dlp', ['--ignore-config', '--no-plugin-dirs', '--no-remote-components', ...runtimeArgs, '--dump-single-json', '--flat-playlist', '--socket-timeout', '15', '--retries', '0', '--extractor-retries', '0', '--', `ytsearch5:${cleanQuery}`], { timeoutMs: 60_000, signal });
    const data = z.object({ entries: z.array(z.unknown()).nullable().optional() }).parse(JSON.parse(result.stdout.toString()));
    const candidates: Candidate[] = [];
    for (const raw of data.entries ?? []) {
      const entry = EntrySchema.safeParse(raw);
      if (!entry.success || !VideoIdSchema.safeParse(entry.data.id).success) continue;
      candidates.push(toCandidate(entry.data));
      if (candidates.length === 5) break;
    }
    return SearchResponseSchema.parse({ candidates });
  } catch (error) { throw sourceError(error); }
}
