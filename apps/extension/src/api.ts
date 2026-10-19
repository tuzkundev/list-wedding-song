import { z } from 'zod';
import { AssetSchema, ErrorSchema, HealthSchema, JobAcceptedSchema, JobSchema, SearchResponseSchema, type Asset, type ExportRequest, type Health, type Job } from '@wedding/shared/api';
import { analyzeAudioBufferInBrowser, renderExportZipInBrowser } from './browserAudio';
import { getWorkspaceId, resolveCloudKey } from './storage';

const LOCAL_BASE = 'http://127.0.0.1:43127/api';
const CLOUD_BASE = '/api';

function hasCloudBackend(): boolean {
  return typeof window !== 'undefined' && (window.location.protocol === 'http:' || window.location.protocol === 'https:');
}

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) { super(message); }
}

async function fetchFromBase(base: string, path: string, options: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    const headers = new Headers(options.headers);
    if (base === CLOUD_BASE) {
      const cloudKey = await resolveCloudKey();
      if (cloudKey) headers.set('Authorization', `Bearer ${cloudKey}`);
      headers.set('X-Workspace-Id', getWorkspaceId());
    }
    response = await fetch(`${base}${path}`, { ...options, headers, signal: options.signal ?? AbortSignal.timeout(70_000) });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError('HELPER_OFFLINE', 'Không kết nối được dịch vụ xử lý.');
  }
  if (!response.ok) {
    const parsed = ErrorSchema.safeParse(await response.json().catch(() => null));
    throw new ApiError(parsed.success ? parsed.data.error.code : 'HTTP_ERROR', parsed.success ? parsed.data.error.message : `HTTP ${response.status}.`, response.status);
  }
  return response;
}

async function requestBase<T>(base: string, path: string, schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetchFromBase(base, path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new ApiError('INVALID_RESPONSE', 'Dữ liệu phản hồi không hợp lệ.');
  return parsed.data;
}

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  if (hasCloudBackend()) {
    try {
      return await requestBase(CLOUD_BASE, '/health', HealthSchema, undefined, signal ?? AbortSignal.timeout(5_000));
    } catch {
      // Fall back to local helper check
    }
  }
  return await requestBase(LOCAL_BASE, '/health', HealthSchema, undefined, signal ?? AbortSignal.timeout(2_500));
}

export async function getShareLink(): Promise<string> {
  const key = await resolveCloudKey();
  const shareKey = key ? key.slice(0, 16) : '';
  const origin = typeof window !== 'undefined' && window.location.protocol.startsWith('http')
    ? window.location.origin
    : 'https://list-wedding-song.nguyenqq611.workers.dev';
  return shareKey ? `${origin}/#key=${shareKey}` : origin;
}

export async function search(query: string, signal?: AbortSignal) {
  if (hasCloudBackend()) {
    let cloudError: unknown = null;
    try {
      const cloudRes = await requestBase(CLOUD_BASE, '/search', SearchResponseSchema, { query }, signal);
      if (cloudRes.candidates.length > 0) return cloudRes;
      try {
        return await requestBase(LOCAL_BASE, '/search', SearchResponseSchema, { query }, AbortSignal.timeout(2_500));
      } catch {
        return cloudRes;
      }
    } catch (err) {
      cloudError = err;
    }
    try {
      return await requestBase(LOCAL_BASE, '/search', SearchResponseSchema, { query }, AbortSignal.timeout(2_500));
    } catch {
      throw cloudError instanceof Error ? cloudError : new ApiError('SOURCE_ERROR', 'Không tìm kiếm được trên YouTube. Hãy thử lại.');
    }
  }
  return await requestBase(LOCAL_BASE, '/search', SearchResponseSchema, { query }, signal);
}

export const startAssetJob = (videoId: string) => requestBase(LOCAL_BASE, '/assets', JobAcceptedSchema, { videoId }, AbortSignal.timeout(2_500));
export const startExportJob = (body: ExportRequest) => requestBase(LOCAL_BASE, '/exports', JobAcceptedSchema, body, AbortSignal.timeout(2_500));
export const getJob = (id: string, signal?: AbortSignal) => requestBase(LOCAL_BASE, `/jobs/${id}`, JobSchema, undefined, signal);

export async function getAsset(id: string): Promise<Asset> {
  if (hasCloudBackend()) {
    try {
      return await requestBase(CLOUD_BASE, `/cloud-assets/${id}`, AssetSchema, undefined, AbortSignal.timeout(6_000));
    } catch {
      // Fall back to local helper
    }
  }
  return await requestBase(LOCAL_BASE, `/assets/${id}`, AssetSchema, undefined, AbortSignal.timeout(2_500));
}

export async function fetchBlobUrl(path: string): Promise<string> {
  if (hasCloudBackend() && path.startsWith('/assets/')) {
    try {
      const cloudResp = await fetchFromBase(CLOUD_BASE, `/cloud${path}`, { signal: AbortSignal.timeout(20_000) });
      return URL.createObjectURL(await cloudResp.blob());
    } catch {
      // Fall back to local helper
    }
  }
  return URL.createObjectURL(await (await fetchFromBase(LOCAL_BASE, path, { signal: AbortSignal.timeout(15_000) })).blob());
}

export async function syncAssetToCloudflare(videoId: string, asset: Asset, audioBlob: Blob): Promise<void> {
  if (!hasCloudBackend()) return;
  try {
    await fetchFromBase(CLOUD_BASE, `/cloud-assets/${asset.assetId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, durationSeconds: asset.durationSeconds, peaks: asset.peaks }),
    });
    await fetchFromBase(CLOUD_BASE, `/cloud-assets/${asset.assetId}/audio`, {
      method: 'PUT',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: await audioBlob.arrayBuffer(),
    });
  } catch {
    // Best-effort cloud sync
  }
}

export async function prepareTrackAudio(videoId: string, signal: AbortSignal): Promise<{ asset: Asset; audioUrl: string }> {
  if (hasCloudBackend()) {
    try {
      const cloudAsset = await requestBase(CLOUD_BASE, `/cloud-assets/by-video/${videoId}`, AssetSchema, undefined, AbortSignal.timeout(5_000));
      const cloudAudio = await fetchFromBase(CLOUD_BASE, `/cloud-assets/${cloudAsset.assetId}/audio`, { signal });
      return { asset: cloudAsset, audioUrl: URL.createObjectURL(await cloudAudio.blob()) };
    } catch {
      // Not cached in Cloudflare yet
    }
  }

  try {
    const accepted = await startAssetJob(videoId);
    const result = await pollJob(accepted.jobId, signal);
    if (!('assetId' in result)) throw new ApiError('INVALID_JOB', 'Kết quả tải âm thanh không hợp lệ.');
    const localAudioResp = await fetchFromBase(LOCAL_BASE, `/assets/${result.assetId}/audio`, { signal: AbortSignal.timeout(300_000) });
    const blob = await localAudioResp.blob();
    void syncAssetToCloudflare(videoId, result, blob);
    return { asset: result, audioUrl: URL.createObjectURL(blob) };
  } catch {
    if (hasCloudBackend()) {
      const bridgedAsset = await requestBase(CLOUD_BASE, '/prepare-youtube', AssetSchema, { videoId }, AbortSignal.timeout(180_000));
      const cloudAudio = await fetchFromBase(CLOUD_BASE, `/cloud-assets/${bridgedAsset.assetId}/audio`, { signal });
      return { asset: bridgedAsset, audioUrl: URL.createObjectURL(await cloudAudio.blob()) };
    }
    throw new ApiError('SOURCE_ERROR', 'Không tải được âm thanh YouTube này. Hãy thử lại hoặc chọn file nhạc từ máy.');
  }
}

export async function uploadCustomAudioFile(file: File, videoId?: string): Promise<{ asset: Asset; audioUrl: string }> {
  const arrayBuffer = await file.arrayBuffer();
  const { durationSeconds, peaks } = await analyzeAudioBufferInBrowser(arrayBuffer);
  const assetId = crypto.randomUUID();
  const asset: Asset = { assetId, durationSeconds, peaks };
  const blob = new Blob([arrayBuffer], { type: file.type || 'audio/mpeg' });
  const syntheticVideoId = videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : assetId.replace(/-/g, '').slice(0, 11);
  await syncAssetToCloudflare(syntheticVideoId, asset, blob);
  return { asset, audioUrl: URL.createObjectURL(blob) };
}

export async function exportPlaylistZip(
  body: ExportRequest,
  audioUrls: Record<string, string>,
  signal: AbortSignal,
  onTick: (completed: number, total: number) => void,
): Promise<string> {
  try {
    const accepted = await startExportJob(body);
    const result = await pollJob(accepted.jobId, signal, (job: Job) => onTick(job.completedTracks, job.totalTracks));
    if (!('exportId' in result)) throw new ApiError('INVALID_EXPORT', 'Không nhận được mã ZIP.');
    return await fetchBlobUrl(`/exports/${result.exportId}/download`);
  } catch {
    return await renderExportZipInBrowser(body, audioUrls, onTick);
  }
}

export async function pollJob(jobId: string, signal: AbortSignal, onTick?: (job: Job) => void): Promise<NonNullable<Job['result']>> {
  for (;;) {
    let job: Job;
    try { job = await getJob(jobId, signal); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) throw new ApiError('JOB_INTERRUPTED', 'Tác vụ bị gián đoạn. Hãy chạy lại.');
      throw error;
    }
    onTick?.(job);
    if (job.status === 'done' && job.result) return job.result;
    if (job.status === 'error') throw new ApiError(job.error?.code ?? 'JOB_ERROR', job.error?.message ?? 'Tác vụ thất bại.');
    const wait = Promise.withResolvers<void>();
    const timer = setTimeout(wait.resolve, 1_000);
    signal.addEventListener('abort', () => { clearTimeout(timer); wait.reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    await wait.promise;
  }
}

export async function forEachConcurrent<T>(items: readonly T[], action: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
    while (next < items.length) { const item = items[next++]; await action(item); }
  }));
}
