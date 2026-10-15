import { Router } from 'express';
import { AssetRequestSchema, JobAcceptedSchema, SearchRequestSchema } from '@wedding/shared/api';
import type { HelperConfig } from './config.js';
import type { DependencyCheck } from './dependencies.js';
import { readExportPath, renderExportZip, validateExportSnapshot } from './export.js';
import { JobStore, prepareAsset, readAsset } from './media.js';
import { AppError } from './server.js';
import { searchYouTube } from './search.js';

export function createRoutes(config: HelperConfig, dependencies: DependencyCheck, jobs = new JobStore()): Router {
  const router = Router();
  router.use((_request, _response, next) => {
    if (!Object.values(dependencies.dependencies).every(value => value.available)) throw new AppError(409, 'NOT_READY', 'Helper thiếu phụ thuộc. Kiểm tra trạng thái kết nối.');
    next();
  });
  router.post('/search', async (request, response) => {
    const parsed = SearchRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(400, 'INVALID_INPUT', parsed.error.issues.map(issue => issue.message).join('; '));
    const controller = new AbortController();
    const abort = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', abort);
    try { response.json(await searchYouTube(parsed.data.query, dependencies.ytDlpRuntimeArgs, controller.signal)); }
    finally { response.off('close', abort); }
  });
  router.post('/assets', (request, response) => {
    const parsed = AssetRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(400, 'INVALID_INPUT', 'Mã video không hợp lệ.');
    response.status(202).json(JobAcceptedSchema.parse({ jobId: jobs.enqueue('download', 0, () => prepareAsset(config.assetsDir, parsed.data.videoId, dependencies.ytDlpRuntimeArgs)) }));
  });
  router.post('/prepare-sync', async (request, response) => {
    const parsed = AssetRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(400, 'INVALID_INPUT', 'Mã video không hợp lệ.');
    const asset = await prepareAsset(config.assetsDir, parsed.data.videoId, dependencies.ytDlpRuntimeArgs);
    response.json(asset);
  });
  router.get('/jobs/:id', (request, response) => { response.json(jobs.get(request.params.id)); });
  router.get('/assets/:id', async (request, response) => { response.json((await readAsset(config.assetsDir, request.params.id)).asset); });
  router.get('/assets/:id/audio', async (request, response) => {
    const { audioPath } = await readAsset(config.assetsDir, request.params.id);
    response.type('audio/mpeg'); response.sendFile(audioPath, { dotfiles: 'allow' });
  });
  router.post('/exports', async (request, response) => {
    const { snapshot, sources, totalTracks } = await validateExportSnapshot(config.assetsDir, request.body);
    response.status(202).json(JobAcceptedSchema.parse({ jobId: jobs.enqueue('export', totalTracks, onTrack => renderExportZip(config.exportsDir, snapshot, sources, onTrack)) }));
  });
  router.get('/exports/:id/download', async (request, response) => {
    const zipPath = await readExportPath(config.exportsDir, request.params.id);
    response.type('application/zip'); response.setHeader('Content-Disposition', 'attachment; filename="nhac-cuoi.zip"');
    response.sendFile(zipPath, { dotfiles: 'allow' });
  });
  return router;
}
