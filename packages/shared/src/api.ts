import { z } from 'zod';

export const IdSchema = z.string().uuid();
export const VideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const seconds = z.number().finite().nonnegative();
export const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).strict();
export const DependencySchema = z.object({ available: z.boolean(), version: z.string().nullable(), error: z.string().nullable() }).strict();
export const HealthSchema = z.object({ ready: z.boolean(), dependencies: z.object({ ytDlp: DependencySchema, ffmpeg: DependencySchema, ffprobe: DependencySchema }).strict(), version: z.string() }).strict();
export const SearchRequestSchema = z.object({ query: z.string().trim().min(1) }).strict();
export const CandidateSchema = z.object({
  videoId: VideoIdSchema, title: z.string().nullable(), channel: z.string().nullable(), durationSeconds: seconds.nullable(),
  thumbnailUrl: z.string().url().nullable(), webpageUrl: z.string().url(),
}).strict();
export const SearchResponseSchema = z.object({ candidates: z.array(CandidateSchema).max(5) }).strict();
export const AssetRequestSchema = z.object({ videoId: VideoIdSchema }).strict();
export const AssetSchema = z.object({ assetId: IdSchema, durationSeconds: z.number().finite().positive(), peaks: z.array(z.tuple([z.number().min(-1).max(1), z.number().min(-1).max(1)])).max(1100) }).strict();
export const JobAcceptedSchema = z.object({ jobId: IdSchema }).strict();
export const JobSchema = z.object({
  status: z.enum(['queued', 'running', 'done', 'error']), progress: z.number().min(0).max(1).nullable(),
  completedTracks: z.number().int().nonnegative(), totalTracks: z.number().int().nonnegative(),
  result: z.union([AssetSchema, z.object({ exportId: IdSchema }).strict()]).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
}).strict();
export const ExportTrackSchema = z.object({
  id: IdSchema, title: z.string(), assetId: IdSchema, startSeconds: seconds, endSeconds: seconds,
  fadeInSeconds: seconds, fadeOutSeconds: seconds, confirmed: z.literal(true),
}).strict().superRefine((track, ctx) => {
  if (track.endSeconds <= track.startSeconds) ctx.addIssue({ code: 'custom', path: ['endSeconds'], message: 'Điểm kết thúc phải sau điểm bắt đầu.' });
  if (track.fadeInSeconds + track.fadeOutSeconds > track.endSeconds - track.startSeconds) ctx.addIssue({ code: 'custom', path: ['fadeOutSeconds'], message: 'Tổng fade vượt độ dài đoạn.' });
});
export const ExportRequestSchema = z.object({ playlistId: IdSchema, sections: z.array(z.object({ id: IdSchema, title: z.string(), tracks: z.array(ExportTrackSchema).max(1000) }).strict()).min(1).max(200) }).strict().refine(value => value.sections.some(section => section.tracks.length), 'Cần ít nhất một bài nhạc.');
export type Candidate = z.infer<typeof CandidateSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Job = z.infer<typeof JobSchema>;
export type Health = z.infer<typeof HealthSchema>;
export type ExportRequest = z.infer<typeof ExportRequestSchema>;
