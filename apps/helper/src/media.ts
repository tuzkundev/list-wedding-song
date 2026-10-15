import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AssetSchema, IdSchema, VideoIdSchema, type Asset, type Job } from '@wedding/shared/api';
import { runProcess } from './process.js';
import { sourceError } from './search.js';
import { AppError } from './server.js';

const StoredAssetSchema = AssetSchema.extend({ videoId: VideoIdSchema }).strict();
type StoredAsset = z.infer<typeof StoredAssetSchema>;
export class BoundedQueue {
  private active = 0; private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  run<T>(task: () => Promise<T>): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const start = () => { ++this.active; task().then(resolve, reject).finally(() => { --this.active; this.waiting.shift()?.(); }); };
    if (this.active < this.limit) start(); else this.waiting.push(start);
    return promise;
  }
}

export class JobStore {
  private readonly jobs = new Map<string, Job>(); private readonly downloadQueue = new BoundedQueue(2); private readonly exportQueue = new BoundedQueue(1);
  enqueue(kind: 'download' | 'export', totalTracks: number, work: (onTrack: (done: number) => void) => Promise<NonNullable<Job['result']>>): string {
    const jobId = crypto.randomUUID();
    const job: Job = { status: 'queued', progress: null, completedTracks: 0, totalTracks, result: null, error: null };
    this.jobs.set(jobId, job);
    void (kind === 'download' ? this.downloadQueue : this.exportQueue).run(async () => {
      job.status = 'running';
      try {
        job.result = await work(done => { job.completedTracks = done; job.progress = totalTracks ? done / totalTracks : null; });
        job.progress = 1; job.status = 'done';
      } catch (error) {
        const appError = error instanceof AppError ? error : new AppError(500, 'JOB_FAILED', 'Tác vụ thất bại.');
        job.error = { code: appError.code, message: appError.message }; job.status = 'error';
      }
    });
    return jobId;
  }
  get(id: string): Job {
    const parsed = IdSchema.safeParse(id);
    const job = parsed.success ? this.jobs.get(parsed.data) : undefined;
    if (!job) throw new AppError(404, 'JOB_NOT_FOUND', 'Tác vụ không tồn tại hoặc helper đã khởi động lại. Hãy chạy lại.');
    return job;
  }
}

export interface ResolvedAsset { asset: Asset; audioPath: string }
export async function readAsset(assetsDir: string, id: string): Promise<ResolvedAsset> {
  const parsedId = IdSchema.safeParse(id);
  if (!parsedId.success) throw new AppError(400, 'INVALID_ID', 'Mã âm thanh không hợp lệ.');
  const dir = join(assetsDir, parsedId.data), audioPath = join(dir, 'source.mp3');
  try {
    await access(audioPath);
    const stored = StoredAssetSchema.parse(JSON.parse(await readFile(join(dir, 'asset.json'), 'utf8')));
    return { asset: { assetId: stored.assetId, durationSeconds: stored.durationSeconds, peaks: stored.peaks }, audioPath };
  } catch { throw new AppError(404, 'ASSET_NOT_FOUND', 'File âm thanh không còn trên máy. Hãy chuẩn bị lại bài này.'); }
}

export async function analyzeAudio(assetsDir: string, assetId: string, videoId: string, audioPath: string): Promise<Asset> {
  const [probe, raw] = await Promise.all([
    runProcess('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', '--', audioPath], { timeoutMs: 30_000 }),
    runProcess('ffmpeg', ['-v', 'error', '-i', audioPath, '-ac', '1', '-ar', '2000', '-f', 's16le', 'pipe:1'], { timeoutMs: 120_000, maxBytes: 32 * 1024 * 1024 }),
  ]);
  const durationSeconds = Number(probe.stdout.toString().trim());
  const sampleCount = Math.floor(raw.stdout.length / 2);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !sampleCount) throw new AppError(502, 'INVALID_MEDIA', 'Không đọc được âm thanh đã tải.');
  const bins = Math.min(1000, sampleCount), peaks: [number, number][] = [];
  for (let index = 0; index < bins; ++index) {
    const start = Math.floor(index * sampleCount / bins), end = Math.max(start + 1, Math.floor((index + 1) * sampleCount / bins));
    let low = 1, high = -1;
    for (let cursor = start; cursor < end; ++cursor) {
      const sample = Math.max(-1, Math.min(1, raw.stdout.readInt16LE(cursor * 2) / 32768));
      if (sample < low) low = sample;
      if (sample > high) high = sample;
    }
    peaks.push([Number(low.toFixed(4)), Number(high.toFixed(4))]);
  }
  const stored: StoredAsset = StoredAssetSchema.parse({ assetId, videoId, durationSeconds, peaks });
  const metaPath = join(assetsDir, assetId, 'asset.json');
  await writeFile(`${metaPath}.tmp`, JSON.stringify(stored)); await rename(`${metaPath}.tmp`, metaPath);
  return { assetId, durationSeconds, peaks };
}

const inflight = new Map<string, Promise<Asset>>();
export function prepareAsset(assetsDir: string, videoId: string, runtimeArgs: string[]): Promise<Asset> {
  const validId = VideoIdSchema.parse(videoId);
  const existing = inflight.get(validId);
  if (existing) return existing;
  const task = (async () => {
    for (const entry of await readdir(assetsDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !IdSchema.safeParse(entry.name).success) continue;
      try {
        const meta = StoredAssetSchema.parse(JSON.parse(await readFile(join(assetsDir, entry.name, 'asset.json'), 'utf8')));
        if (meta.videoId === validId) return (await readAsset(assetsDir, entry.name)).asset;
      } catch { continue; }
    }
    const assetId = crypto.randomUUID(), dir = join(assetsDir, assetId), audioPath = join(dir, 'source.mp3');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await runProcess('yt-dlp', ['--ignore-config', '--no-plugin-dirs', '--no-remote-components', ...runtimeArgs, '--no-playlist', '--max-filesize', '150M', '-f', 'bestaudio', '-x', '--audio-format', 'mp3', '--output', join(dir, 'source.%(ext)s'), '--', `https://www.youtube.com/watch?v=${validId}`], { timeoutMs: 600_000 });
      return await analyzeAudio(assetsDir, assetId, validId, audioPath);
    } catch (error) { await rm(dir, { recursive: true, force: true }); throw error instanceof AppError ? error : sourceError(error); }
  })().finally(() => inflight.delete(validId));
  inflight.set(validId, task);
  return task;
}
