import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import archiver from 'archiver';
import { ExportRequestSchema, IdSchema, type ExportRequest } from '@wedding/shared/api';
import { getEditErrors } from '@wedding/shared/edit';
import { formatSectionFolder, formatTrackEntry } from '@wedding/shared/filenames';
import { readAsset, type ResolvedAsset } from './media.js';
import { runProcess } from './process.js';
import { AppError } from './server.js';

export function buildAudioFilter(start: number, end: number, fadeIn: number, fadeOut: number): string {
  const duration = end - start, filters = [`atrim=start=${start}:end=${end}`, 'asetpts=PTS-STARTPTS'];
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn}`);
  if (fadeOut > 0) filters.push(`afade=t=out:st=${duration - fadeOut}:d=${fadeOut}`);
  return filters.join(',');
}

export async function validateExportSnapshot(assetsDir: string, raw: unknown): Promise<{ snapshot: ExportRequest; sources: Map<string, string>; totalTracks: number }> {
  const parsed = ExportRequestSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, 'INVALID_EXPORT', parsed.error.issues.map(issue => issue.message).join('; '));
  const snapshot: ExportRequest = structuredClone(parsed.data), sources = new Map<string, string>();
  let totalTracks = 0;
  for (const section of snapshot.sections) {
    for (const track of section.tracks) {
      ++totalTracks;
      let resolved: ResolvedAsset;
      try { resolved = await readAsset(assetsDir, track.assetId); }
      catch { throw new AppError(400, 'MISSING_ASSET', `Bài "${track.title}" chưa có hoặc đã mất file âm thanh. Hãy chuẩn bị lại.`); }
      const errors = getEditErrors(track, resolved.asset.durationSeconds);
      if (Object.keys(errors).length) throw new AppError(400, 'INVALID_EDIT', `Bài "${track.title}": ${Object.values(errors).join(' ')}`);
      sources.set(track.assetId, resolved.audioPath);
    }
  }
  return { snapshot, sources, totalTracks };
}

export async function renderExportZip(exportsDir: string, snapshot: ExportRequest, sources: Map<string, string>, onTrack: (done: number) => void): Promise<{ exportId: string }> {
  const exportId = crypto.randomUUID(), workDir = join(exportsDir, `${exportId}.work`), zipTmp = join(exportsDir, `${exportId}.tmp`), zipPath = join(exportsDir, `${exportId}.zip`);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const rendered: Array<{ filePath: string; entryName: string }> = [], emptyFolders: string[] = [];
  let completed = 0;
  try {
    for (let sIndex = 0; sIndex < snapshot.sections.length; ++sIndex) {
      const section = snapshot.sections[sIndex], folder = formatSectionFolder(sIndex, snapshot.sections.length, section.title);
      if (!section.tracks.length) emptyFolders.push(folder);
      for (let tIndex = 0; tIndex < section.tracks.length; ++tIndex) {
        const track = section.tracks[tIndex], filePath = join(workDir, `${completed}.mp3`);
        try {
          await runProcess('ffmpeg', ['-v', 'error', '-y', '-i', sources.get(track.assetId)!, '-vn', '-af', buildAudioFilter(track.startSeconds, track.endSeconds, track.fadeInSeconds, track.fadeOutSeconds), '-c:a', 'libmp3lame', '-b:a', '192k', '--', filePath], { timeoutMs: 180_000 });
        } catch { throw new AppError(500, 'TRACK_EXPORT_FAILED', `Không thể xuất bài "${track.title}" trong mục "${section.title}". Chưa tạo ZIP.`); }
        rendered.push({ filePath, entryName: formatTrackEntry(folder, tIndex, section.tracks.length, track.title) });
        onTrack(++completed);
      }
    }
    const done = Promise.withResolvers<void>(), output = createWriteStream(zipTmp, { mode: 0o600 }), archive = archiver('zip', { zlib: { level: 6 } });
    output.once('close', () => done.resolve()); output.once('error', done.reject); archive.once('error', done.reject);
    archive.pipe(output);
    for (const folder of emptyFolders) archive.append('', { name: folder });
    for (const item of rendered) archive.file(item.filePath, { name: item.entryName });
    void archive.finalize();
    await done.promise;
    await rename(zipTmp, zipPath);
    return { exportId };
  } catch (error) {
    await rm(zipTmp, { force: true }); await rm(zipPath, { force: true });
    throw error;
  } finally { await rm(workDir, { recursive: true, force: true }); }
}

export async function readExportPath(exportsDir: string, id: string): Promise<string> {
  const parsed = IdSchema.safeParse(id);
  if (!parsed.success) throw new AppError(400, 'INVALID_ID', 'Mã bản xuất không hợp lệ.');
  const zipPath = join(exportsDir, `${parsed.data}.zip`);
  try { await access(zipPath); return zipPath; }
  catch { throw new AppError(404, 'EXPORT_NOT_FOUND', 'Bản xuất không tồn tại hoặc đã hết hạn.'); }
}
