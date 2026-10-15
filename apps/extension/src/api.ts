import { z } from 'zod';
import { AssetSchema, ErrorSchema, HealthSchema, JobAcceptedSchema, JobSchema, SearchResponseSchema, type ExportRequest, type Job } from '@wedding/shared/api';

const BASE = 'http://127.0.0.1:43127/api';
export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) { super(message); }
}
export async function authenticatedFetch(path: string, options: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { ...options, signal: options.signal ?? AbortSignal.timeout(70_000) });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError('HELPER_OFFLINE', 'Mất kết nối helper. Chạy npm run dev:helper rồi thử lại.');
  }
  if (!response.ok) {
    const parsed = ErrorSchema.safeParse(await response.json().catch(() => null));
    throw new ApiError(parsed.success ? parsed.data.error.code : 'HTTP_ERROR', parsed.success ? parsed.data.error.message : `Helper trả HTTP ${response.status}.`, response.status);
  }
  return response;
}
export async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await authenticatedFetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new ApiError('INVALID_RESPONSE', 'Helper trả dữ liệu không hợp lệ.');
  return parsed.data;
}
export const getHealth = (signal?: AbortSignal) => request('/health', HealthSchema, undefined, signal);
export const search = (query: string, signal?: AbortSignal) => request('/search', SearchResponseSchema, { query }, signal);
export const startAssetJob = (videoId: string) => request('/assets', JobAcceptedSchema, { videoId });
export const startExportJob = (body: ExportRequest) => request('/exports', JobAcceptedSchema, body);
export const getJob = (id: string, signal?: AbortSignal) => request(`/jobs/${id}`, JobSchema, undefined, signal);
export const getAsset = (id: string) => request(`/assets/${id}`, AssetSchema);
export async function fetchBlobUrl(path: string): Promise<string> {
  return URL.createObjectURL(await (await authenticatedFetch(path, { signal: AbortSignal.timeout(300_000) })).blob());
}
export async function pollJob(jobId: string, signal: AbortSignal, onTick?: (job: Job) => void): Promise<NonNullable<Job['result']>> {
  for (;;) {
    let job: Job;
    try { job = await getJob(jobId, signal); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) throw new ApiError('JOB_INTERRUPTED', 'Tác vụ bị gián đoạn (helper đã khởi động lại). Hãy chạy lại.');
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
