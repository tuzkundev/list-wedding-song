import { useCallback, useEffect, useRef, useState } from 'react';
import type { Asset, ExportTrackPart } from '@wedding/shared/api';
import { formatTimestamp, getEditErrors } from '@wedding/shared/edit';
import { buildSearchQuery, cleanTitleText, extractTrailingNote, parsePlaylist, PlaylistSchema, sanitizeSearchQuery, type ParseResult, type Playlist, type Track, type TrackPart } from '@wedding/shared/playlist';
import { exportPlaylistZip, fetchBlobUrl, forEachConcurrent, getAsset, getShareLink, prepareTrackAudio, search, uploadCustomAudioFile } from './api';
import { previewAudio, TrackEditor } from './components/TrackEditor';
import { readStorage, writeStorage } from './storage';

const STATE_KEY = 'playlistState', NOTICE_KEY = 'rightsAccepted';
const SAMPLE_PLAYLIST = `Nhạc cưới\n1. Đón khách\n+ Hơn cả yêu\n• Em đồng ý + Yes I do + Một nhà\n2) MC mở đầu\nVideo câu chuyện tình yêu\n3. Cô dâu tiến vào lễ đường (1:07–2:10)\nA thousand years- Phiên bản cinematic orchestral\n(phần cao trào)`;

export default function App() {
  const [copiedShare, setCopiedShare] = useState(false);
  const [text, setText] = useState(''), [parseErrors, setParseErrors] = useState<ParseResult['errors']>([]), [playlist, setPlaylist] = useState<Playlist | null>(null), [dirty, setDirty] = useState(false);
  const [assets, setAssets] = useState<Record<string, Asset>>({}), [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [trackBusy, setTrackBusy] = useState<Record<string, string>>({}), [trackErrors, setTrackErrors] = useState<Record<string, string>>({});
  const [openEditors, setOpenEditors] = useState<Record<string, boolean>>({});
  const [rightsAccepted, setRightsAccepted] = useState(true), [exportStatus, setExportStatus] = useState<{ text: string; snapshotChanged: boolean } | null>(null);
  const [activeEmbed, setActiveEmbed] = useState<{ ownerId: string; videoId: string } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), abortRef = useRef(new AbortController()), exportSnapshotRef = useRef<string | null>(null), audioUrlsRef = useRef(audioUrls), restoredRef = useRef(false);
  audioUrlsRef.current = audioUrls;

  const isPartConfirmable = useCallback((part: TrackPart | Track) => {
    if (!part.selectedVideoId && !part.assetId) return false;
    const asset = part.assetId ? assets[part.assetId] : undefined;
    if (asset && Object.keys(getEditErrors(part, asset.durationSeconds)).length > 0) return false;
    return true;
  }, [assets]);

  const isTrackConfirmable = useCallback((track: Track) => {
    if (track.parts?.length) {
      return track.parts.every(p => isPartConfirmable(p));
    }
    return isPartConfirmable(track);
  }, [isPartConfirmable]);

  const verifySavedAssets = useCallback(async (current: Playlist) => {
    const musicTracks = current.sections.flatMap(section => section.tracks).filter(track => track.kind === 'music');
    const itemsToVerify: Array<{ trackId: string; partId?: string; assetId: string }> = [];
    for (const track of musicTracks) {
      if (track.parts?.length) {
        for (const p of track.parts) {
          if (p.assetId) itemsToVerify.push({ trackId: track.id, partId: p.id, assetId: p.assetId });
        }
      } else if (track.assetId) {
        itemsToVerify.push({ trackId: track.id, assetId: track.assetId });
      }
    }
    await forEachConcurrent(itemsToVerify, async item => {
      try {
        const [asset, url] = await Promise.all([getAsset(item.assetId), fetchBlobUrl(`/assets/${item.assetId}/audio`)]);
        setAssets(prev => ({ ...prev, [asset.assetId]: asset }));
        setAudioUrls(prev => ({ ...prev, [asset.assetId]: url }));
        setOpenEditors(prev => ({ ...prev, [item.partId ?? item.trackId]: true }));
      } catch {
        setPlaylist(prev => prev && ({
          ...prev,
          sections: prev.sections.map(s => ({
            ...s,
            tracks: s.tracks.map(t => {
              if (t.id !== item.trackId) return t;
              if (item.partId && t.parts?.length) {
                const nextParts = t.parts.map(p => p.id === item.partId ? { ...p, assetId: null, confirmed: Boolean(p.selectedVideoId && p.confirmed) } : p);
                return { ...t, parts: nextParts, confirmed: nextParts.every(p => p.confirmed) };
              }
              return { ...t, assetId: null, confirmed: Boolean(t.selectedVideoId && t.confirmed) };
            }),
          })),
        }));
      }
    });
  }, []);

  const mutatePlaylist = (updater: (current: Playlist) => Playlist, flush = false) => {
    setDirty(true);
    if (exportSnapshotRef.current) setExportStatus(prev => prev && ({ ...prev, snapshotChanged: true }));
    setPlaylist(current => {
      if (!current) return null;
      const next = updater(current);
      if (flush) { clearTimeout(saveTimer.current); void writeStorage(STATE_KEY, { text, playlist: next }); }
      return next;
    });
  };

  const updateTrack = (trackId: string, patch: Partial<Track>, flush = false) => mutatePlaylist(current => ({
    ...current, sections: current.sections.map(s => ({ ...s, tracks: s.tracks.map(t => t.id === trackId ? { ...t, ...patch } : t) })),
  }), flush);

  const updateTrackPart = (trackId: string, partId: string, patch: Partial<TrackPart>, flush = false) => mutatePlaylist(current => ({
    ...current,
    sections: current.sections.map(s => ({
      ...s,
      tracks: s.tracks.map(t => {
        if (t.id !== trackId || !t.parts?.length) return t;
        const nextParts = t.parts.map(p => p.id === partId ? { ...p, ...patch } : p);
        const nextTitle = patch.title !== undefined ? nextParts.map(p => p.title).join(' + ') : t.title;
        return {
          ...t,
          title: nextTitle,
          parts: nextParts,
          confirmed: nextParts.every(p => p.confirmed),
        };
      }),
    })),
  }), flush);

  const runPartSearch = useCallback(async (trackId: string, part: TrackPart) => {
    const cleanQuery = sanitizeSearchQuery(part.query) || buildSearchQuery(part.title);
    if (!cleanQuery) { setTrackErrors(prev => ({ ...prev, [part.id]: 'Query tìm kiếm đang trống.' })); return; }
    if (cleanQuery !== part.query) updateTrackPart(trackId, part.id, { query: cleanQuery });
    setTrackBusy(prev => ({ ...prev, [part.id]: 'Đang tìm YouTube…' })); setTrackErrors(prev => ({ ...prev, [part.id]: '' }));
    try {
      const response = await search(cleanQuery, abortRef.current.signal);
      if (!response.candidates.length) { setTrackErrors(prev => ({ ...prev, [part.id]: 'Không tìm thấy kết quả phù hợp. Hãy sửa query rồi thử lại.' })); return; }
      const keep = response.candidates.some(c => c.videoId === part.selectedVideoId);
      updateTrackPart(trackId, part.id, { query: cleanQuery, candidates: response.candidates, selectedVideoId: keep ? part.selectedVideoId : response.candidates[0].videoId, assetId: keep ? part.assetId : null, confirmed: false });
    } catch (error) { setTrackErrors(prev => ({ ...prev, [part.id]: error instanceof Error ? error.message : 'Tìm kiếm thất bại.' })); }
    finally { setTrackBusy(prev => ({ ...prev, [part.id]: '' })); }
  }, []);

  const runTrackSearch = useCallback(async (track: Track) => {
    if (track.parts?.length) {
      await forEachConcurrent(track.parts, part => runPartSearch(track.id, part));
      return;
    }
    const cleanQuery = sanitizeSearchQuery(track.query) || buildSearchQuery(track.title);
    if (!cleanQuery) { setTrackErrors(prev => ({ ...prev, [track.id]: 'Query tìm kiếm đang trống.' })); return; }
    if (cleanQuery !== track.query) updateTrack(track.id, { query: cleanQuery });
    setTrackBusy(prev => ({ ...prev, [track.id]: 'Đang tìm YouTube…' })); setTrackErrors(prev => ({ ...prev, [track.id]: '' }));
    try {
      const response = await search(cleanQuery, abortRef.current.signal);
      if (!response.candidates.length) { setTrackErrors(prev => ({ ...prev, [track.id]: 'Không tìm thấy kết quả phù hợp. Hãy sửa query rồi thử lại.' })); return; }
      const keep = response.candidates.some(c => c.videoId === track.selectedVideoId);
      updateTrack(track.id, { query: cleanQuery, candidates: response.candidates, selectedVideoId: keep ? track.selectedVideoId : response.candidates[0].videoId, assetId: keep ? track.assetId : null, confirmed: false });
    } catch (error) { setTrackErrors(prev => ({ ...prev, [track.id]: error instanceof Error ? error.message : 'Tìm kiếm thất bại.' })); }
    finally { setTrackBusy(prev => ({ ...prev, [track.id]: '' })); }
  }, [runPartSearch]);

  useEffect(() => {
    const controller = new AbortController(); abortRef.current = controller;
    void (async () => {
      const [savedState, savedNotice] = await Promise.all([readStorage<{ text?: string; playlist?: unknown }>(STATE_KEY), readStorage<boolean>(NOTICE_KEY)]);
      if (typeof savedNotice === 'boolean') setRightsAccepted(savedNotice);
      const parsed = PlaylistSchema.safeParse(savedState?.playlist);
      if (typeof savedState?.text === 'string') setText(savedState.text);
      const staleSearchTracks: Track[] = [];
      let initialPlaylist: Playlist | null = null;
      if (parsed.success) {
        initialPlaylist = {
          ...parsed.data,
          sections: parsed.data.sections.map(s => ({
            ...s,
            title: cleanTitleText(s.title),
            tracks: s.tracks.map(t => {
              const ext = extractTrailingNote(t.title);
              const nextTitle = ext.title || cleanTitleText(t.title);
              const nextNote = [t.note, ext.note].filter(Boolean).join(' ').trim();
              const nextQuery = sanitizeSearchQuery(t.query) || buildSearchQuery(nextTitle);
              const nextTrack: Track = { ...t, title: nextTitle, note: nextNote, query: nextQuery };
              if (t.kind === 'music' && nextQuery !== t.query && !t.confirmed) staleSearchTracks.push(nextTrack);
              return nextTrack;
            }),
          })),
        };
        setPlaylist(initialPlaylist);
      }
      restoredRef.current = true;
      if (initialPlaylist) {
        await verifySavedAssets(initialPlaylist);
        if (staleSearchTracks.length) await forEachConcurrent(staleSearchTracks, runTrackSearch);
      }
    })();
    return () => { controller.abort(); previewAudio.stop(true); Object.values(audioUrlsRef.current).forEach(url => URL.revokeObjectURL(url)); };
  }, [runTrackSearch, verifySavedAssets]);

  useEffect(() => {
    if (!restoredRef.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void writeStorage(STATE_KEY, { text, playlist }); }, 300);
  }, [playlist, text]);

  const handleResetAll = () => {
    if ((playlist || text.trim()) && !window.confirm('Làm mới tất cả sẽ xóa danh sách hiện tại để bạn nhập danh sách mới. Tiếp tục?')) return;
    abortRef.current.abort();
    abortRef.current = new AbortController();
    previewAudio.stop(true);
    Object.values(audioUrlsRef.current).forEach(url => URL.revokeObjectURL(url));
    clearTimeout(saveTimer.current);
    setText('');
    setParseErrors([]);
    setPlaylist(null);
    setDirty(false);
    setAssets({});
    setAudioUrls({});
    setTrackBusy({});
    setTrackErrors({});
    setOpenEditors({});
    setExportStatus(null);
    setActiveEmbed(null);
    void writeStorage(STATE_KEY, { text: '', playlist: null });
  };

  const prepareAndPlay = async (track: Track, overrideVideoId?: string) => {
    const targetVideoId = overrideVideoId ?? track.selectedVideoId;
    if (!targetVideoId) return;
    if (!rightsAccepted) { setTrackErrors(prev => ({ ...prev, [track.id]: 'Hãy xác nhận quyền sử dụng nội dung ở thanh thông báo trước khi tải âm thanh.' })); return; }
    setActiveEmbed(null);
    previewAudio.unlock();
    setTrackBusy(prev => ({ ...prev, [track.id]: 'Đang tải và dựng sóng nhạc (waveform)…' })); setTrackErrors(prev => ({ ...prev, [track.id]: '' }));
    try {
      const videoChanged = Boolean(overrideVideoId && overrideVideoId !== track.selectedVideoId);
      let asset = !videoChanged && track.assetId ? assets[track.assetId] : undefined;
      if (!asset || !audioUrls[asset.assetId]) {
        const prepared = await prepareTrackAudio(targetVideoId, abortRef.current.signal);
        asset = prepared.asset;
        setAssets(prev => ({ ...prev, [asset!.assetId]: asset! }));
        setAudioUrls(prev => ({ ...prev, [asset!.assetId]: prepared.audioUrl }));
        setOpenEditors(prev => ({ ...prev, [track.id]: true }));
        const nextEnd = track.endSeconds ?? asset.durationSeconds;
        updateTrack(track.id, { selectedVideoId: targetVideoId, assetId: asset.assetId, endSeconds: nextEnd, ...(videoChanged ? { confirmed: false } : {}) });
        previewAudio.startMark = track.startSeconds;
        const validSegment = Object.keys(getEditErrors({ ...track, endSeconds: nextEnd }, asset.durationSeconds)).length === 0;
        previewAudio.play(track.id, prepared.audioUrl, validSegment ? track.startSeconds : 0, validSegment ? nextEnd : null, validSegment ? track.fadeInSeconds : 0, validSegment ? track.fadeOutSeconds : 0, () => undefined);
        return;
      }
      setOpenEditors(prev => ({ ...prev, [track.id]: true }));
      const url = audioUrls[asset.assetId];
      const nextEnd = track.endSeconds ?? asset.durationSeconds;
      updateTrack(track.id, { selectedVideoId: targetVideoId, assetId: asset.assetId, endSeconds: nextEnd, ...(videoChanged ? { confirmed: false } : {}) });
      previewAudio.startMark = track.startSeconds;
      const validSegment = Object.keys(getEditErrors({ ...track, endSeconds: nextEnd }, asset.durationSeconds)).length === 0;
      previewAudio.play(track.id, url, validSegment ? track.startSeconds : 0, validSegment ? nextEnd : null, validSegment ? track.fadeInSeconds : 0, validSegment ? track.fadeOutSeconds : 0, () => undefined);
    } catch (error) { setTrackErrors(prev => ({ ...prev, [track.id]: error instanceof Error ? error.message : 'Không chuẩn bị được âm thanh.' })); }
    finally { setTrackBusy(prev => ({ ...prev, [track.id]: '' })); }
  };

  const prepareAndPlayPart = async (trackId: string, part: TrackPart, overrideVideoId?: string) => {
    const targetVideoId = overrideVideoId ?? part.selectedVideoId;
    if (!targetVideoId) return;
    if (!rightsAccepted) { setTrackErrors(prev => ({ ...prev, [part.id]: 'Hãy xác nhận quyền sử dụng nội dung ở thanh thông báo trước khi tải âm thanh.' })); return; }
    setActiveEmbed(null);
    previewAudio.unlock();
    setTrackBusy(prev => ({ ...prev, [part.id]: 'Đang tải và dựng sóng nhạc (waveform)…' })); setTrackErrors(prev => ({ ...prev, [part.id]: '' }));
    try {
      const videoChanged = Boolean(overrideVideoId && overrideVideoId !== part.selectedVideoId);
      let asset = !videoChanged && part.assetId ? assets[part.assetId] : undefined;
      if (!asset || !audioUrls[asset.assetId]) {
        const prepared = await prepareTrackAudio(targetVideoId, abortRef.current.signal);
        asset = prepared.asset;
        setAssets(prev => ({ ...prev, [asset!.assetId]: asset! }));
        setAudioUrls(prev => ({ ...prev, [asset!.assetId]: prepared.audioUrl }));
        setOpenEditors(prev => ({ ...prev, [part.id]: true }));
        const nextEnd = part.endSeconds ?? asset.durationSeconds;
        updateTrackPart(trackId, part.id, { selectedVideoId: targetVideoId, assetId: asset.assetId, endSeconds: nextEnd, ...(videoChanged ? { confirmed: false } : {}) });
        previewAudio.startMark = part.startSeconds;
        const validSegment = Object.keys(getEditErrors({ ...part, endSeconds: nextEnd }, asset.durationSeconds)).length === 0;
        previewAudio.play(part.id, prepared.audioUrl, validSegment ? part.startSeconds : 0, validSegment ? nextEnd : null, validSegment ? part.fadeInSeconds : 0, validSegment ? part.fadeOutSeconds : 0, () => undefined);
        return;
      }
      setOpenEditors(prev => ({ ...prev, [part.id]: true }));
      const url = audioUrls[asset.assetId];
      const nextEnd = part.endSeconds ?? asset.durationSeconds;
      updateTrackPart(trackId, part.id, { selectedVideoId: targetVideoId, assetId: asset.assetId, endSeconds: nextEnd, ...(videoChanged ? { confirmed: false } : {}) });
      previewAudio.startMark = part.startSeconds;
      const validSegment = Object.keys(getEditErrors({ ...part, endSeconds: nextEnd }, asset.durationSeconds)).length === 0;
      previewAudio.play(part.id, url, validSegment ? part.startSeconds : 0, validSegment ? nextEnd : null, validSegment ? part.fadeInSeconds : 0, validSegment ? part.fadeOutSeconds : 0, () => undefined);
    } catch (error) { setTrackErrors(prev => ({ ...prev, [part.id]: error instanceof Error ? error.message : 'Không chuẩn bị được âm thanh.' })); }
    finally { setTrackBusy(prev => ({ ...prev, [part.id]: '' })); }
  };

  const playMedleyChain = async (track: Track) => {
    if (!track.parts?.length) return;
    if (!rightsAccepted) { setTrackErrors(prev => ({ ...prev, [track.id]: 'Hãy xác nhận quyền sử dụng nội dung ở thanh thông báo trước khi tải âm thanh.' })); return; }
    setActiveEmbed(null);
    previewAudio.unlock();
    setTrackBusy(prev => ({ ...prev, [track.id]: 'Đang chuẩn bị các đoạn để phát nối tiếp…' })); setTrackErrors(prev => ({ ...prev, [track.id]: '' }));
    try {
      const chainItems: Array<{ part: TrackPart; asset: Asset; url: string; end: number }> = [];
      for (const part of track.parts) {
        let asset = part.assetId ? assets[part.assetId] : undefined;
        let url = part.assetId ? audioUrls[part.assetId] : undefined;
        if (!asset || !url) {
          if (!part.selectedVideoId) throw new Error(`Phần "${part.title}" chưa chọn ứng viên YouTube.`);
          const prepared = await prepareTrackAudio(part.selectedVideoId, abortRef.current.signal);
          asset = prepared.asset;
          url = prepared.audioUrl;
          setAssets(prev => ({ ...prev, [asset!.assetId]: asset! }));
          setAudioUrls(prev => ({ ...prev, [asset!.assetId]: url! }));
          const nextEnd = part.endSeconds ?? asset.durationSeconds;
          updateTrackPart(track.id, part.id, { assetId: asset.assetId, endSeconds: nextEnd });
        }
        const end = part.endSeconds ?? asset.durationSeconds;
        chainItems.push({ part, asset, url, end });
      }
      const playStep = (index: number) => {
        if (index >= chainItems.length) return;
        const { part, asset, url, end } = chainItems[index];
        const valid = Object.keys(getEditErrors({ ...part, endSeconds: end }, asset.durationSeconds)).length === 0;
        previewAudio.startMark = valid ? part.startSeconds : 0;
        previewAudio.play(
          part.id,
          url,
          valid ? part.startSeconds : 0,
          valid ? end : null,
          valid ? part.fadeInSeconds : 0,
          valid ? part.fadeOutSeconds : 0,
          () => playStep(index + 1),
        );
      };
      playStep(0);
    } catch (error) {
      setTrackErrors(prev => ({ ...prev, [track.id]: error instanceof Error ? error.message : 'Không phát được bản ghép.' }));
    } finally {
      setTrackBusy(prev => ({ ...prev, [track.id]: '' }));
    }
  };

  const handleUploadTrackFile = async (track: Track, file: File) => {
    previewAudio.unlock();
    setTrackBusy(prev => ({ ...prev, [track.id]: 'Đang phân tích file nhạc & lưu lên Cloudflare…' })); setTrackErrors(prev => ({ ...prev, [track.id]: '' }));
    try {
      const { asset, audioUrl } = await uploadCustomAudioFile(file, track.selectedVideoId ?? undefined);
      setAssets(prev => ({ ...prev, [asset.assetId]: asset }));
      setAudioUrls(prev => ({ ...prev, [asset.assetId]: audioUrl }));
      setOpenEditors(prev => ({ ...prev, [track.id]: true }));
      const nextEnd = track.endSeconds ?? asset.durationSeconds;
      updateTrack(track.id, { assetId: asset.assetId, endSeconds: nextEnd, confirmed: false });
      previewAudio.startMark = track.startSeconds;
      const validSegment = Object.keys(getEditErrors({ ...track, endSeconds: nextEnd }, asset.durationSeconds)).length === 0;
      previewAudio.play(track.id, audioUrl, validSegment ? track.startSeconds : 0, validSegment ? nextEnd : null, validSegment ? track.fadeInSeconds : 0, validSegment ? track.fadeOutSeconds : 0, () => undefined);
    } catch (error) {
      setTrackErrors(prev => ({ ...prev, [track.id]: error instanceof Error ? error.message : 'Không đọc được file âm thanh.' }));
    } finally {
      setTrackBusy(prev => ({ ...prev, [track.id]: '' }));
    }
  };

  const handleUploadPartFile = async (trackId: string, part: TrackPart, file: File) => {
    previewAudio.unlock();
    setTrackBusy(prev => ({ ...prev, [part.id]: 'Đang phân tích file nhạc & lưu lên Cloudflare…' })); setTrackErrors(prev => ({ ...prev, [part.id]: '' }));
    try {
      const { asset, audioUrl } = await uploadCustomAudioFile(file, part.selectedVideoId ?? undefined);
      setAssets(prev => ({ ...prev, [asset.assetId]: asset }));
      setAudioUrls(prev => ({ ...prev, [asset.assetId]: audioUrl }));
      setOpenEditors(prev => ({ ...prev, [part.id]: true }));
      const nextEnd = part.endSeconds ?? asset.durationSeconds;
      updateTrackPart(trackId, part.id, { assetId: asset.assetId, endSeconds: nextEnd, confirmed: false });
      previewAudio.startMark = part.startSeconds;
      const validSegment = Object.keys(getEditErrors({ ...part, endSeconds: nextEnd }, asset.durationSeconds)).length === 0;
      previewAudio.play(part.id, audioUrl, validSegment ? part.startSeconds : 0, validSegment ? nextEnd : null, validSegment ? part.fadeInSeconds : 0, validSegment ? part.fadeOutSeconds : 0, () => undefined);
    } catch (error) {
      setTrackErrors(prev => ({ ...prev, [part.id]: error instanceof Error ? error.message : 'Không đọc được file âm thanh.' }));
    } finally {
      setTrackBusy(prev => ({ ...prev, [part.id]: '' }));
    }
  };

  const addPartToTrack = (track: Track) => {
    const newPart: TrackPart = {
      id: crypto.randomUUID(),
      title: 'Bài ghép mới',
      query: 'Bài ghép mới lyrics',
      note: '',
      startSeconds: 0,
      endSeconds: null,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
      selectedVideoId: null,
      assetId: null,
      confirmed: false,
      candidates: [],
    };
    if (track.parts?.length) {
      const nextParts = [...track.parts, newPart];
      updateTrack(track.id, { parts: nextParts, title: nextParts.map(p => p.title).join(' + '), confirmed: false });
    } else {
      const firstPart: TrackPart = {
        id: crypto.randomUUID(),
        title: track.title,
        query: track.query,
        note: track.note,
        startSeconds: track.startSeconds,
        endSeconds: track.endSeconds,
        fadeInSeconds: track.fadeInSeconds,
        fadeOutSeconds: track.fadeOutSeconds,
        selectedVideoId: track.selectedVideoId,
        assetId: track.assetId,
        confirmed: track.confirmed,
        candidates: track.candidates,
      };
      const nextParts = [firstPart, newPart];
      updateTrack(track.id, { parts: nextParts, title: nextParts.map(p => p.title).join(' + '), confirmed: false });
    }
  };

  const removePartFromTrack = (track: Track, partId: string) => {
    if (!track.parts?.length) return;
    const remaining = track.parts.filter(p => p.id !== partId);
    if (remaining.length <= 1) {
      const sole = remaining[0];
      updateTrack(track.id, {
        title: sole?.title ?? track.title,
        query: sole?.query ?? track.query,
        note: sole?.note ?? track.note,
        startSeconds: sole?.startSeconds ?? 0,
        endSeconds: sole?.endSeconds ?? null,
        fadeInSeconds: sole?.fadeInSeconds ?? 0,
        fadeOutSeconds: sole?.fadeOutSeconds ?? 0,
        selectedVideoId: sole?.selectedVideoId ?? null,
        assetId: sole?.assetId ?? null,
        confirmed: sole?.confirmed ?? false,
        candidates: sole?.candidates ?? [],
        parts: undefined,
      });
    } else {
      updateTrack(track.id, {
        parts: remaining,
        title: remaining.map(p => p.title).join(' + '),
        confirmed: remaining.every(p => p.confirmed),
      });
    }
  };

  const allTracks = playlist?.sections.flatMap(section => section.tracks) ?? [], musicTracks = allTracks.filter(track => track.kind === 'music');
  const confirmedTracks = musicTracks.filter(track => track.confirmed && isTrackConfirmable(track));
  const canExport = Boolean(musicTracks.length > 0 && confirmedTracks.length === musicTracks.length);

  const handleExport = async () => {
    if (!playlist || !canExport) return;
    setExportStatus({ text: `Đang chuẩn bị xuất 0/${musicTracks.length} bài…`, snapshotChanged: false });
    try {
      const resolvedAssets: Record<string, Asset> = { ...assets };
      const resolvedAudioUrls: Record<string, string> = { ...audioUrls };
      const trackAssetMap: Record<string, { assetId: string; endSeconds: number; parts?: ExportTrackPart[] }> = {};

      const allSegmentsToPrep: Array<{ title: string; videoId: string | null; assetId: string | null }> = [];
      for (const t of musicTracks) {
        if (t.parts?.length) {
          for (const p of t.parts) {
            if (!p.assetId || !resolvedAssets[p.assetId] || !resolvedAudioUrls[p.assetId]) {
              allSegmentsToPrep.push({ title: p.title, videoId: p.selectedVideoId, assetId: p.assetId });
            }
          }
        } else if (!t.assetId || !resolvedAssets[t.assetId] || !resolvedAudioUrls[t.assetId]) {
          allSegmentsToPrep.push({ title: t.title, videoId: t.selectedVideoId, assetId: t.assetId });
        }
      }
      if (allSegmentsToPrep.length > 0 && !rightsAccepted) {
        throw new Error('Hãy xác nhận quyền sử dụng nội dung ở thanh thông báo trước khi xuất âm thanh.');
      }

      let prepCount = 0;
      for (const t of musicTracks) {
        if (t.parts?.length) {
          const exportParts: ExportTrackPart[] = [];
          for (const p of t.parts) {
            let asset = p.assetId ? resolvedAssets[p.assetId] : undefined;
            let url = p.assetId ? resolvedAudioUrls[p.assetId] : undefined;
            if (!asset || !url) {
              if (!p.selectedVideoId) throw new Error(`Phần "${p.title}" trong bài "${t.title}" chưa chọn video YouTube.`);
              ++prepCount;
              setExportStatus(prev => ({ text: `Đang tải nhạc chuẩn bị xuất (${prepCount}/${allSegmentsToPrep.length}): ${p.title}…`, snapshotChanged: prev?.snapshotChanged ?? false }));
              const prepared = await prepareTrackAudio(p.selectedVideoId, abortRef.current.signal);
              asset = prepared.asset;
              url = prepared.audioUrl;
              resolvedAssets[asset.assetId] = asset;
              resolvedAudioUrls[asset.assetId] = url;
              setAssets(prev => ({ ...prev, [asset!.assetId]: asset! }));
              setAudioUrls(prev => ({ ...prev, [asset!.assetId]: url! }));
            }
            const endSeconds = p.endSeconds ?? asset.durationSeconds;
            const errs = getEditErrors({ ...p, endSeconds }, asset.durationSeconds);
            if (Object.keys(errs).length > 0) {
              throw new Error(`Phần "${p.title}": ${Object.values(errs).join(' ')}`);
            }
            exportParts.push({
              id: p.id,
              title: p.title,
              assetId: asset.assetId,
              startSeconds: p.startSeconds,
              endSeconds,
              fadeInSeconds: p.fadeInSeconds,
              fadeOutSeconds: p.fadeOutSeconds,
              confirmed: true as const,
            });
          }
          trackAssetMap[t.id] = {
            assetId: exportParts[0].assetId,
            endSeconds: exportParts[0].endSeconds,
            parts: exportParts,
          };
        } else {
          let asset = t.assetId ? resolvedAssets[t.assetId] : undefined;
          let url = t.assetId ? resolvedAudioUrls[t.assetId] : undefined;
          if (!asset || !url) {
            if (!t.selectedVideoId) throw new Error(`Bài "${t.title}" chưa chọn video YouTube.`);
            ++prepCount;
            setExportStatus(prev => ({ text: `Đang tải nhạc chuẩn bị xuất (${prepCount}/${allSegmentsToPrep.length}): ${t.title}…`, snapshotChanged: prev?.snapshotChanged ?? false }));
            const prepared = await prepareTrackAudio(t.selectedVideoId, abortRef.current.signal);
            asset = prepared.asset;
            url = prepared.audioUrl;
            resolvedAssets[asset.assetId] = asset;
            resolvedAudioUrls[asset.assetId] = url;
            setAssets(prev => ({ ...prev, [asset!.assetId]: asset! }));
            setAudioUrls(prev => ({ ...prev, [asset!.assetId]: url! }));
          }
          const endSeconds = t.endSeconds ?? asset.durationSeconds;
          const errs = getEditErrors({ ...t, endSeconds }, asset.durationSeconds);
          if (Object.keys(errs).length > 0) {
            throw new Error(`Bài "${t.title}": ${Object.values(errs).join(' ')}`);
          }
          trackAssetMap[t.id] = { assetId: asset.assetId, endSeconds };
        }
      }

      const body = {
        playlistId: playlist.id,
        sections: playlist.sections.map(s => ({
          id: s.id,
          title: s.title,
          tracks: s.tracks.filter(t => t.kind === 'music').map(t => ({
            id: t.id,
            title: t.title,
            assetId: trackAssetMap[t.id].assetId,
            startSeconds: t.startSeconds,
            endSeconds: trackAssetMap[t.id].endSeconds,
            fadeInSeconds: t.fadeInSeconds,
            fadeOutSeconds: t.fadeOutSeconds,
            confirmed: true as const,
            ...(trackAssetMap[t.id].parts ? { parts: trackAssetMap[t.id].parts } : {}),
          })),
        })),
      };
      exportSnapshotRef.current = JSON.stringify(body);
      const url = await exportPlaylistZip(body, resolvedAudioUrls, abortRef.current.signal, (done, total) => setExportStatus(prev => ({ text: `Đang xuất ${done}/${total} bài…`, snapshotChanged: prev?.snapshotChanged ?? false })));
      const link = document.createElement('a'); link.href = url; link.download = 'nhac-cuoi.zip'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setExportStatus(prev => ({ text: `Đã tải nhac-cuoi.zip (${musicTracks.length}/${musicTracks.length} bài).`, snapshotChanged: prev?.snapshotChanged ?? false }));
    } catch (error) { setExportStatus(prev => ({ text: error instanceof Error ? error.message : 'Xuất ZIP thất bại.', snapshotChanged: prev?.snapshotChanged ?? false })); }
    finally { exportSnapshotRef.current = null; }
  };

  const renderCandidatePanel = (
    ownerId: string,
    item: Track | TrackPart,
    onSelectVideo: (videoId: string) => void,
    onConfirmItem: () => void,
    onPrepareAndPlayItem: () => void,
    confirmLabel: string,
    confirmedLabel: string,
  ) => {
    const candidate = item.candidates.find(c => c.videoId === item.selectedVideoId) ?? null;
    if (!item.candidates.length) return null;
    return (
      <div className="candidate-box">
        <div className="candidate-select-row">
          <label>Ứng viên YouTube (đề xuất đầu tiên, cần nghe và xác nhận thủ công)
            <select value={item.selectedVideoId ?? ''} onChange={e => {
              const nextVid = e.target.value;
              onSelectVideo(nextVid);
              if (activeEmbed?.ownerId === ownerId) setActiveEmbed({ ownerId, videoId: nextVid });
            }}>
              {item.candidates.map((c, idx) => <option key={c.videoId} value={c.videoId}>{idx === 0 ? '[Đề xuất] ' : ''}{c.title ?? c.videoId} — {c.channel ?? 'Không rõ kênh'} ({c.durationSeconds ? `${c.durationSeconds}s` : 'không rõ thời lượng'})</option>)}
            </select>
          </label>
          <div className="candidate-actions">
            <button
              type="button"
              className={`candidate-confirm-btn ${item.confirmed ? 'is-confirmed' : ''}`}
              disabled={Boolean(trackBusy[ownerId]) || item.confirmed || !isPartConfirmable(item)}
              onClick={onConfirmItem}
            >
              {item.confirmed ? confirmedLabel : confirmLabel}
            </button>
            <button type="button" className="listen-button" disabled={Boolean(trackBusy[ownerId])} onClick={onPrepareAndPlayItem}>Nghe thử</button>
            {candidate && <a className="yt-link" href={candidate.webpageUrl} target="_blank" rel="noreferrer">Mở YouTube gốc</a>}
          </div>
        </div>

        <div className="candidate-cards" aria-label="Danh sách ứng viên trực quan">
          {item.candidates.map((c, idx) => {
            const selected = c.videoId === item.selectedVideoId;
            return (
              <div key={c.videoId} className={`candidate-pill ${selected ? 'is-selected' : ''}`} onClick={() => {
                previewAudio.stop(true);
                setActiveEmbed({ ownerId, videoId: c.videoId });
                if (c.videoId === item.selectedVideoId) return;
                onSelectVideo(c.videoId);
              }}>
                {c.thumbnailUrl ? <img src={c.thumbnailUrl} alt="" className="candidate-thumb" loading="lazy" /> : <div className="candidate-thumb candidate-thumb--empty">♪</div>}
                <div className="candidate-meta">
                  <p className="candidate-title">{idx === 0 && <span className="recommend-tag">Đề xuất</span>}{c.title ?? c.videoId}</p>
                  <p className="candidate-sub">{c.channel ?? 'Không rõ kênh'} · {c.durationSeconds ? formatTimestamp(c.durationSeconds) : '—'}</p>
                </div>
              </div>
            );
          })}
        </div>

        {activeEmbed?.ownerId === ownerId && (
          <div className="yt-embed-box" aria-label="Trình phát YouTube nhúng">
            <div className="yt-embed-header">
              <span className="yt-embed-title">▶ {candidate?.title ?? activeEmbed.videoId}</span>
              <button type="button" className="yt-embed-close" onClick={() => setActiveEmbed(null)}>Đóng video ✕</button>
            </div>
            <div className="yt-embed-frame-wrap">
              <iframe
                key={activeEmbed.videoId}
                className="yt-embed-iframe"
                src={`https://www.youtube.com/embed/${activeEmbed.videoId}?autoplay=1&rel=0${typeof window !== 'undefined' && window.location.protocol.startsWith('http') ? `&origin=${encodeURIComponent(window.location.origin)}` : ''}`}
                title={candidate?.title ?? `YouTube ${activeEmbed.videoId}`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <img src="./icons/icon-128.png" alt="" className="brand-icon" />
          <div>
            <p className="brand-kicker">WEDDING AUDIO STUDIO · CLOUDFLARE</p>
            <h1 className="brand-name">Nhạc cưới theo mục</h1>
          </div>
        </div>
        <div className="token-bar">
          <span className="status-pill ok" role="status">☁️ Tự động lưu trên Cloudflare</span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              void getShareLink().then(url => {
                void navigator.clipboard.writeText(url);
                setCopiedShare(true);
                setTimeout(() => setCopiedShare(false), 2_500);
              });
            }}
          >
            {copiedShare ? '✓ Đã sao chép link chia sẻ!' : '🔗 Sao chép link chia sẻ cho bạn bè'}
          </button>
        </div>
      </header>

      <section className="notice-banner" aria-label="Quyền sử dụng nội dung">
        <label htmlFor="rights-check" className="rights-label">
          <input id="rights-check" type="checkbox" checked={rightsAccepted} onChange={e => { setRightsAccepted(e.target.checked); void writeStorage(NOTICE_KEY, e.target.checked); }} />
          <span>Tôi xác nhận chỉ tải và xử lý nội dung âm thanh mà mình có quyền sử dụng.</span>
        </label>
        <span className="notice-chip">Chuẩn xuất: MP3 / WAV · Chia theo thư mục ZIP</span>
      </section>

      <section className="composer-card" aria-labelledby="input-heading">
        <div className="composer-top">
          <div>
            <h2 id="input-heading">1. Dán danh sách và rà soát cấu trúc</h2>
            <p className="composer-subtitle">Dán danh sách từ ghi chú, Word hoặc chat: tên mục có hoặc không đánh số, bài hát xuống dòng, đánh số hay gạch đầu dòng. Ghép nhiều bài trong 1 dòng bằng dấu <code>+</code> (vd: <code>Em đồng ý + Yes I do + Một nhà</code>). Hỗ trợ khoảng thời gian <code>(1:07–2:10)</code>.</p>
          </div>
          <div className="composer-top-actions">
            {!text.trim() && (
              <button type="button" className="ghost-button" onClick={() => setText(SAMPLE_PLAYLIST)}>Điền danh sách mẫu</button>
            )}
            {(playlist !== null || text.trim().length > 0) && (
              <button type="button" className="danger-ghost-btn" onClick={handleResetAll}>↻ Làm mới tất cả</button>
            )}
          </div>
        </div>
        <label htmlFor="playlist-input" className="input-label">Danh sách nhạc cưới dạng văn bản</label>
        <textarea id="playlist-input" rows={7} value={text} onChange={e => setText(e.target.value)} placeholder="Đón khách&#10;1. Em đồng ý + Yes I do + Một nhà&#10;2. Ba kể con nghe&#10;MC dẫn (1:07–2:10)&#10;1. A thousand years" />
        <div className="composer-actions">
          <button type="button" className="primary-button" disabled={!text.trim()} onClick={() => {
            if (playlist && dirty && !window.confirm('Phân tích lại sẽ thay thế danh sách đã chỉnh sửa. Bạn có chắc muốn tiếp tục?')) return;
            abortRef.current.abort(); abortRef.current = new AbortController();
            previewAudio.stop(true); Object.values(audioUrlsRef.current).forEach(url => URL.revokeObjectURL(url));
            setAssets({}); setAudioUrls({}); setTrackBusy({}); setTrackErrors({}); setOpenEditors({}); setExportStatus(null); setActiveEmbed(null);
            const res = parsePlaylist(text); setParseErrors(res.errors);
            setPlaylist(res.playlist); setDirty(false);
            clearTimeout(saveTimer.current); void writeStorage(STATE_KEY, { text, playlist: res.playlist });
          }}>Phân tích danh sách</button>
          <button type="button" className="secondary-button" disabled={!musicTracks.length} onClick={() => void forEachConcurrent(musicTracks, runTrackSearch)}>Tìm nhạc cho {musicTracks.length} bài</button>
          {(playlist !== null || text.trim().length > 0) && (
            <button type="button" className="danger-ghost-btn" onClick={handleResetAll}>↻ Làm mới tất cả</button>
          )}
          {playlist && (
            <div className="playlist-stats" aria-label="Tóm tắt danh sách">
              <span><strong>{playlist.sections.length}</strong> mục</span>
              <span><strong>{musicTracks.length}</strong> bài nhạc</span>
              <span><strong>{confirmedTracks.length}</strong> đã chốt</span>
            </div>
          )}
        </div>
        {parseErrors.length > 0 && <ul className="error-list" role="alert">{parseErrors.map(err => <li key={err.line}>Dòng {err.line}: {err.message}</li>)}</ul>}
      </section>

      {playlist && (
        <main className="sections-list">
          {playlist.sections.map((section, sIndex) => {
            const sectionMusic = section.tracks.filter(t => t.kind === 'music');
            const sectionConfirmed = sectionMusic.filter(t => t.confirmed && isTrackConfirmable(t)).length;
            return (
              <section className="section-card" key={section.id} aria-label={`Mục ${sIndex + 1}`}>
                <div className="section-header">
                  <span className="section-number">Mục {String(sIndex + 1).padStart(2, '0')}</span>
                  <label className="section-title-field">
                    <span>Tiêu đề mục</span>
                    <input value={section.title} onChange={e => mutatePlaylist(cur => ({ ...cur, sections: cur.sections.map(s => s.id === section.id ? { ...s, title: e.target.value } : s) }))} />
                  </label>
                  <span className="section-badge">{sectionMusic.length ? `${sectionConfirmed}/${sectionMusic.length} bài đã chốt` : 'Mục ghi chú (thư mục rỗng)'}</span>
                </div>

                {section.tracks.map((track, tIndex) => {
                  const asset = track.assetId ? assets[track.assetId] : undefined;
                  const isMedley = Boolean(track.parts && track.parts.length >= 2);
                  return (
                    <article className={`track-card ${track.confirmed && isTrackConfirmable(track) ? 'is-confirmed' : ''} ${track.kind === 'note' ? 'is-note' : ''} ${isMedley ? 'is-medley' : ''}`} key={track.id}>
                      <div className="track-row">
                        <strong className="track-index">#{tIndex + 1}</strong>
                        <label>Tên dòng / File xuất<input value={track.title} onChange={e => updateTrack(track.id, { title: e.target.value, ...(isMedley ? {} : { query: buildSearchQuery(e.target.value), confirmed: false }) })} /></label>
                        <label>Loại<select value={track.kind} onChange={e => updateTrack(track.id, { kind: e.target.value as Track['kind'], confirmed: false })}><option value="music">Bài nhạc</option><option value="note">Ghi chú / không tìm</option></select></label>
                        <label>Ghi chú<input value={track.note} placeholder="Chú thích (tùy chọn)" onChange={e => mutatePlaylist(cur => ({ ...cur, sections: cur.sections.map(s => ({ ...s, tracks: s.tracks.map(t => t.id === track.id ? { ...t, note: e.target.value } : t) })) }))} /></label>
                        <button type="button" className="danger-ghost-btn" onClick={() => mutatePlaylist(cur => ({ ...cur, sections: cur.sections.map(s => ({ ...s, tracks: s.tracks.filter(t => t.id !== track.id) })) }))}>Xóa dòng</button>
                      </div>

                      {track.kind === 'music' && !isMedley && (
                        <>
                          <div className="search-row">
                            <label>Query tìm kiếm<input value={track.query} onChange={e => updateTrack(track.id, { query: e.target.value })} /></label>
                            <button type="button" disabled={Boolean(trackBusy[track.id])} onClick={() => void runTrackSearch(track)}>Tìm lại</button>
                            <label className="ghost-button file-upload-btn" title="Tải file nhạc MP3/WAV từ máy lên Cloudflare để cắt">
                              📁 Chọn file nhạc
                              <input type="file" accept="audio/*" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void handleUploadTrackFile(track, f); e.currentTarget.value = ''; }} />
                            </label>
                            <button type="button" className="ghost-button" onClick={() => addPartToTrack(track)} title="Ghép nối tiếp thêm bài nhạc khác vào cùng 1 file">+ Ghép thêm bài</button>
                            <span className={`track-state ${track.confirmed ? 'is-ok' : ''}`}>{track.confirmed ? 'Trạng thái: Đã xác nhận' : 'Trạng thái: Chưa xác nhận'}</span>
                          </div>

                          {trackBusy[track.id] && <p className="busy-note" role="status"><span className="spinner-dot" aria-hidden="true" /> {trackBusy[track.id]}</p>}
                          {trackErrors[track.id] && <p className="field-error" role="alert">{trackErrors[track.id]} <button type="button" onClick={() => void (track.candidates.length ? prepareAndPlay(track) : runTrackSearch(track))}>Thử lại</button></p>}

                          {renderCandidatePanel(
                            track.id,
                            track,
                            nextVid => {
                              if (track.assetId && audioUrls[track.assetId]) { URL.revokeObjectURL(audioUrls[track.assetId]); setAudioUrls(prev => { const next = { ...prev }; delete next[track.assetId!]; return next; }); }
                              setOpenEditors(prev => ({ ...prev, [track.id]: false }));
                              updateTrack(track.id, { selectedVideoId: nextVid, assetId: null, confirmed: false });
                            },
                            () => updateTrack(track.id, { confirmed: true }, true),
                            () => void prepareAndPlay(track),
                            'Đúng bản này',
                            'Đã xác nhận bản này',
                          )}

                          {openEditors[track.id] && asset && audioUrls[asset.assetId] && (
                            <TrackEditor
                              track={track}
                              asset={asset}
                              audioUrl={audioUrls[asset.assetId]}
                              onChange={patch => updateTrack(track.id, patch)}
                              onConfirm={() => updateTrack(track.id, { confirmed: true }, true)}
                            />
                          )}
                        </>
                      )}

                      {track.kind === 'music' && isMedley && track.parts && (
                        <div className="medley-container" aria-label={`Bản ghép ${track.parts.length} bài`}>
                          <div className="medley-banner">
                            <div className="medley-banner-info">
                              <span className="medley-badge">🔗 Ghép {track.parts.length} bài nối tiếp</span>
                              <span className="medley-summary">
                                Đã chốt {track.parts.filter(p => p.confirmed && isPartConfirmable(p)).length}/{track.parts.length} phần · Xuất thành 1 file nối tiếp
                              </span>
                            </div>
                            <div className="medley-banner-actions">
                              <button type="button" className="ghost-button" onClick={() => addPartToTrack(track)}>+ Ghép thêm bài</button>
                              <button
                                type="button"
                                className="listen-button"
                                disabled={Boolean(trackBusy[track.id]) || track.parts.some(p => !p.selectedVideoId && !p.assetId)}
                                onClick={() => void playMedleyChain(track)}
                              >
                                ▶ Nghe thử cả bản ghép
                              </button>
                              <button
                                type="button"
                                className={`candidate-confirm-btn ${track.confirmed && isTrackConfirmable(track) ? 'is-confirmed' : ''}`}
                                disabled={(track.confirmed && isTrackConfirmable(track)) || !isTrackConfirmable(track)}
                                onClick={() => mutatePlaylist(cur => ({
                                  ...cur,
                                  sections: cur.sections.map(s => ({
                                    ...s,
                                    tracks: s.tracks.map(t => t.id === track.id && t.parts ? {
                                      ...t,
                                      confirmed: true,
                                      parts: t.parts.map(p => ({ ...p, confirmed: true })),
                                    } : t),
                                  })),
                                }), true)}
                              >
                                {track.confirmed && isTrackConfirmable(track) ? 'Đã xác nhận cả bản ghép' : 'Đúng bản này (tất cả phần)'}
                              </button>
                            </div>
                          </div>

                          {trackBusy[track.id] && <p className="busy-note" role="status"><span className="spinner-dot" aria-hidden="true" /> {trackBusy[track.id]}</p>}
                          {trackErrors[track.id] && <p className="field-error" role="alert">{trackErrors[track.id]}</p>}

                          <div className="medley-parts-list">
                            {track.parts.map((part, pIndex) => {
                              const partAsset = part.assetId ? assets[part.assetId] : undefined;
                              return (
                                <div className={`medley-part-card ${part.confirmed && isPartConfirmable(part) ? 'is-confirmed' : ''}`} key={part.id}>
                                  <div className="medley-part-header">
                                    <span className="medley-part-step">Phần {pIndex + 1}/{track.parts!.length}</span>
                                    <label className="medley-part-title">
                                      <span>Tên bài phần {pIndex + 1}</span>
                                      <input
                                        value={part.title}
                                        onChange={e => updateTrackPart(track.id, part.id, { title: e.target.value, query: buildSearchQuery(e.target.value), confirmed: false })}
                                      />
                                    </label>
                                    <label className="medley-part-query">
                                      <span>Query tìm kiếm</span>
                                      <input
                                        value={part.query}
                                        onChange={e => updateTrackPart(track.id, part.id, { query: e.target.value })}
                                      />
                                    </label>
                                    <button type="button" disabled={Boolean(trackBusy[part.id])} onClick={() => void runPartSearch(track.id, part)}>Tìm lại</button>
                                    <label className="ghost-button file-upload-btn" title="Tải file nhạc MP3/WAV từ máy cho phần này">
                                      📁 Chọn file nhạc
                                      <input type="file" accept="audio/*" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void handleUploadPartFile(track.id, part, f); e.currentTarget.value = ''; }} />
                                    </label>
                                    <span className={`track-state ${part.confirmed ? 'is-ok' : ''}`}>{part.confirmed ? 'Đã chốt phần này' : 'Chưa chốt'}</span>
                                    <button type="button" className="danger-ghost-btn" onClick={() => removePartFromTrack(track, part.id)} title="Bỏ phần này khỏi bản ghép">Bỏ phần</button>
                                  </div>

                                  {trackBusy[part.id] && <p className="busy-note" role="status"><span className="spinner-dot" aria-hidden="true" /> {trackBusy[part.id]}</p>}
                                  {trackErrors[part.id] && <p className="field-error" role="alert">{trackErrors[part.id]} <button type="button" onClick={() => void (part.candidates.length ? prepareAndPlayPart(track.id, part) : runPartSearch(track.id, part))}>Thử lại</button></p>}

                                  {renderCandidatePanel(
                                    part.id,
                                    part,
                                    nextVid => {
                                      if (part.assetId && audioUrls[part.assetId]) { URL.revokeObjectURL(audioUrls[part.assetId]); setAudioUrls(prev => { const next = { ...prev }; delete next[part.assetId!]; return next; }); }
                                      setOpenEditors(prev => ({ ...prev, [part.id]: false }));
                                      updateTrackPart(track.id, part.id, { selectedVideoId: nextVid, assetId: null, confirmed: false });
                                    },
                                    () => updateTrackPart(track.id, part.id, { confirmed: true }, true),
                                    () => void prepareAndPlayPart(track.id, part),
                                    `Đúng phần ${pIndex + 1}`,
                                    `Đã xác nhận phần ${pIndex + 1}`,
                                  )}

                                  {openEditors[part.id] && partAsset && audioUrls[partAsset.assetId] && (
                                    <TrackEditor
                                      track={{ ...part, kind: 'music' }}
                                      asset={partAsset}
                                      audioUrl={audioUrls[partAsset.assetId]}
                                      onChange={patch => updateTrackPart(track.id, part.id, patch)}
                                      onConfirm={() => updateTrackPart(track.id, part.id, { confirmed: true }, true)}
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
              </section>
            );
          })}
        </main>
      )}

      <footer className="export-bar">
        <div className="export-summary">
          <div className="export-progress-row">
            <strong>Đã xác nhận: {confirmedTracks.length}/{musicTracks.length} bài nhạc</strong>
            <div className="export-meter" aria-hidden="true">
              <div className="export-meter-fill" style={{ width: `${musicTracks.length ? (confirmedTracks.length / musicTracks.length) * 100 : 0}%` }} />
            </div>
          </div>
          {exportStatus && <p role="status" className="export-status-text">{exportStatus.text}{exportStatus.snapshotChanged ? ' (Danh sách đã sửa sau khi bấm xuất; file ZIP giữ theo bản chốt lúc bắt đầu xuất.)' : ''}</p>}
        </div>
        <button type="button" className="primary-button export-cta" disabled={!canExport} onClick={() => void handleExport()}>Tải tất cả theo thư mục (ZIP)</button>
      </footer>
    </div>
  );
}
