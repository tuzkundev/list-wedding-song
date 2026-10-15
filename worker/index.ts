import { AssetSchema, HealthSchema, IdSchema, SearchRequestSchema, SearchResponseSchema, VideoIdSchema, type Candidate } from '../packages/shared/src/api';
import { sanitizeSearchQuery } from '../packages/shared/src/playlist';

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}
interface KVNamespace {
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer | string, options?: { expirationTtl?: number }): Promise<void>;
}
interface Env {
  wedding_music_db: D1Database;
  WEDDING_KV: KVNamespace;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function parseDurationText(raw: string | undefined): number | null {
  if (!raw) return null;
  const parts = raw.trim().split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function collectVideoRenderers(node: unknown, out: Record<string, unknown>[]): void {
  if (!node || typeof node !== 'object' || out.length >= 10) return;
  if (Array.isArray(node)) {
    for (const item of node) collectVideoRenderers(item, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.videoRenderer && typeof obj.videoRenderer === 'object') {
    out.push(obj.videoRenderer as Record<string, unknown>);
    return;
  }
  for (const val of Object.values(obj)) collectVideoRenderers(val, out);
}

async function searchYouTubeInnerTube(query: string): Promise<Candidate[]> {
  const response = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20241120.01.00',
          hl: 'vi',
          gl: 'VN',
        },
      },
      query,
    }),
  });
  if (!response.ok) throw new Error(`YouTube HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const renderers: Record<string, unknown>[] = [];
  collectVideoRenderers(payload, renderers);
  const candidates: Candidate[] = [];
  for (const item of renderers) {
    const videoId = typeof item.videoId === 'string' ? item.videoId : '';
    if (!VideoIdSchema.safeParse(videoId).success) continue;
    const titleRuns = (item.title as { runs?: Array<{ text?: string }> } | undefined)?.runs;
    const title = titleRuns?.map(r => r.text ?? '').join('') || null;
    const ownerRuns = ((item.ownerText ?? item.longBylineText ?? item.shortBylineText) as { runs?: Array<{ text?: string }> } | undefined)?.runs;
    const channel = ownerRuns?.map(r => r.text ?? '').join('') || null;
    const lengthText = (item.lengthText as { simpleText?: string } | undefined)?.simpleText;
    const durationSeconds = parseDurationText(lengthText);
    const thumbs = (item.thumbnail as { thumbnails?: Array<{ url?: string }> } | undefined)?.thumbnails;
    const thumbUrl = thumbs?.find(t => typeof t.url === 'string' && t.url.startsWith('https://'))?.url ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    candidates.push({
      videoId,
      title,
      channel,
      durationSeconds,
      thumbnailUrl: thumbUrl,
      webpageUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
    if (candidates.length === 5) break;
  }
  return candidates;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonResponse(HealthSchema.parse({
        ready: true,
        dependencies: {
          ytDlp: { available: true, version: 'cloudflare-innertube', error: null },
          ffmpeg: { available: true, version: 'cloudflare-webaudio', error: null },
          ffprobe: { available: true, version: 'cloudflare-webaudio', error: null },
        },
        version: '2.0.0-cloudflare',
      }));
    }

    if (url.pathname === '/api/state' && request.method === 'GET') {
      const row = await env.wedding_music_db
        .prepare('SELECT text_content, playlist_json, rights_accepted, updated_at FROM playlists_state WHERE id = ?')
        .bind('default')
        .first<{ text_content: string; playlist_json: string | null; rights_accepted: number; updated_at: number }>();
      if (!row) {
        return jsonResponse({ text: '', playlist: null, rightsAccepted: true, updatedAt: 0 });
      }
      return jsonResponse({
        text: row.text_content,
        playlist: row.playlist_json ? JSON.parse(row.playlist_json) : null,
        rightsAccepted: Boolean(row.rights_accepted),
        updatedAt: row.updated_at,
      });
    }

    if (url.pathname === '/api/state' && request.method === 'PUT') {
      const body = (await request.json().catch(() => null)) as { text?: string; playlist?: unknown; rightsAccepted?: boolean } | null;
      if (!body || typeof body !== 'object') return errorResponse(400, 'INVALID_INPUT', 'Dữ liệu trạng thái không hợp lệ.');
      const text = typeof body.text === 'string' ? body.text : '';
      const playlistJson = body.playlist ? JSON.stringify(body.playlist) : null;
      const rightsAccepted = body.rightsAccepted === false ? 0 : 1;
      const now = Date.now();
      await env.wedding_music_db
        .prepare(
          `INSERT INTO playlists_state (id, text_content, playlist_json, rights_accepted, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             text_content = excluded.text_content,
             playlist_json = excluded.playlist_json,
             rights_accepted = excluded.rights_accepted,
             updated_at = excluded.updated_at`,
        )
        .bind('default', text, playlistJson, rightsAccepted, now)
        .run();
      return jsonResponse({ ok: true, updatedAt: now });
    }

    if (url.pathname === '/api/search' && request.method === 'POST') {
      const parsed = SearchRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return errorResponse(400, 'INVALID_INPUT', 'Query tìm kiếm không hợp lệ.');
      const cleanQuery = sanitizeSearchQuery(parsed.data.query) || parsed.data.query;
      const cached = await env.wedding_music_db
        .prepare('SELECT candidates_json, updated_at FROM search_cache WHERE query = ?')
        .bind(cleanQuery)
        .first<{ candidates_json: string; updated_at: number }>();
      if (cached && Date.now() - cached.updated_at < 7 * 24 * 3600 * 1000) {
        const candidates = JSON.parse(cached.candidates_json) as unknown;
        const valid = SearchResponseSchema.safeParse({ candidates });
        if (valid.success && valid.data.candidates.length > 0) return jsonResponse(valid.data);
      }
      try {
        const candidates = await searchYouTubeInnerTube(cleanQuery);
        const result = SearchResponseSchema.parse({ candidates });
        if (candidates.length > 0) {
          await env.wedding_music_db
            .prepare(
              `INSERT INTO search_cache (query, candidates_json, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(query) DO UPDATE SET candidates_json = excluded.candidates_json, updated_at = excluded.updated_at`,
            )
            .bind(cleanQuery, JSON.stringify(result.candidates), Date.now())
            .run();
        }
        return jsonResponse(result);
      } catch {
        return errorResponse(502, 'SOURCE_ERROR', 'Không tìm kiếm được trên YouTube. Hãy thử lại.');
      }
    }

    const byVideoMatch = /^\/api\/cloud-assets\/by-video\/([A-Za-z0-9_-]{11})$/.exec(url.pathname);
    if (byVideoMatch && request.method === 'GET') {
      const row = await env.wedding_music_db
        .prepare('SELECT asset_id, duration_seconds, peaks_json FROM cloud_assets WHERE video_id = ?')
        .bind(byVideoMatch[1])
        .first<{ asset_id: string; duration_seconds: number; peaks_json: string }>();
      if (!row) return errorResponse(404, 'ASSET_NOT_FOUND', 'Chưa có âm thanh trên Cloudflare.');
      const audio = await env.WEDDING_KV.get(`audio:${row.asset_id}`, 'arrayBuffer');
      if (!audio) return errorResponse(404, 'ASSET_NOT_FOUND', 'File âm thanh không còn trong KV.');
      return jsonResponse(AssetSchema.parse({
        assetId: row.asset_id,
        durationSeconds: row.duration_seconds,
        peaks: JSON.parse(row.peaks_json),
      }));
    }

    const assetMetaMatch = /^\/api\/(?:cloud-)?assets\/([0-9a-fA-F-]{36})$/.exec(url.pathname);
    if (assetMetaMatch && request.method === 'GET') {
      const id = assetMetaMatch[1];
      if (!IdSchema.safeParse(id).success) return errorResponse(400, 'INVALID_ID', 'Mã âm thanh không hợp lệ.');
      const row = await env.wedding_music_db
        .prepare('SELECT asset_id, duration_seconds, peaks_json FROM cloud_assets WHERE asset_id = ?')
        .bind(id)
        .first<{ asset_id: string; duration_seconds: number; peaks_json: string }>();
      if (!row) return errorResponse(404, 'ASSET_NOT_FOUND', 'Chưa có âm thanh này trên Cloudflare.');
      return jsonResponse(AssetSchema.parse({
        assetId: row.asset_id,
        durationSeconds: row.duration_seconds,
        peaks: JSON.parse(row.peaks_json),
      }));
    }

    if (assetMetaMatch && request.method === 'PUT') {
      const id = assetMetaMatch[1];
      const body = (await request.json().catch(() => null)) as { videoId?: string; durationSeconds?: number; peaks?: unknown } | null;
      const parsedAsset = AssetSchema.safeParse({ assetId: id, durationSeconds: body?.durationSeconds, peaks: body?.peaks });
      const parsedVideoId = VideoIdSchema.safeParse(body?.videoId);
      if (!parsedAsset.success || !parsedVideoId.success) {
        return errorResponse(400, 'INVALID_ASSET', 'Metadata âm thanh không hợp lệ.');
      }
      await env.wedding_music_db
        .prepare(
          `INSERT INTO cloud_assets (asset_id, video_id, duration_seconds, peaks_json, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(asset_id) DO UPDATE SET
             video_id = excluded.video_id,
             duration_seconds = excluded.duration_seconds,
             peaks_json = excluded.peaks_json`,
        )
        .bind(id, parsedVideoId.data, parsedAsset.data.durationSeconds, JSON.stringify(parsedAsset.data.peaks), Date.now())
        .run();
      return jsonResponse(parsedAsset.data);
    }

    const assetAudioMatch = /^\/api\/(?:cloud-)?assets\/([0-9a-fA-F-]{36})\/audio$/.exec(url.pathname);
    if (assetAudioMatch && request.method === 'GET') {
      const id = assetAudioMatch[1];
      const audio = await env.WEDDING_KV.get(`audio:${id}`, 'arrayBuffer');
      if (!audio) return errorResponse(404, 'ASSET_NOT_FOUND', 'File âm thanh không có trên Cloudflare KV.');
      return new Response(audio, {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'public, max-age=31536000, immutable',
          ...CORS_HEADERS,
        },
      });
    }

    if (assetAudioMatch && request.method === 'PUT') {
      const id = assetAudioMatch[1];
      const buf = await request.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 24 * 1024 * 1024) {
        return errorResponse(400, 'INVALID_AUDIO', 'Dung lượng file âm thanh không hợp lệ (tối đa 24MB trên KV Free).');
      }
      await env.WEDDING_KV.put(`audio:${id}`, buf);
      return jsonResponse({ ok: true, bytes: buf.byteLength });
    }

    if (url.pathname.startsWith('/api/')) {
      return errorResponse(404, 'NOT_FOUND', 'Không tìm thấy API được yêu cầu.');
    }

    return env.ASSETS.fetch(request);
  },
};
