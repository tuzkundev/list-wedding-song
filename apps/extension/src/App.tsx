import { useCallback, useEffect, useRef, useState } from 'react';
import type { Asset } from '@wedding/shared/api';
import { formatTimestamp, getEditErrors } from '@wedding/shared/edit';
import { buildSearchQuery, cleanTitleText, extractTrailingNote, parsePlaylist, PlaylistSchema, sanitizeSearchQuery, type ParseResult, type Playlist, type Track } from '@wedding/shared/playlist';
import { exportPlaylistZip, fetchBlobUrl, forEachConcurrent, getAsset, getShareLink, prepareTrackAudio, search, uploadCustomAudioFile } from './api';
import { previewAudio, TrackEditor } from './components/TrackEditor';
import { readStorage, writeStorage } from './storage';

const STATE_KEY = 'playlistState', NOTICE_KEY = 'rightsAccepted';
const SAMPLE_PLAYLIST = `Nhạc cưới\n1. Đón khách\n+ Hơn cả yêu\n• Perfect violin & piano instrumental\n2) MC mở đầu\nVideo câu chuyện tình yêu\n3. Cô dâu tiến vào lễ đường (1:07–2:10)\nA thousand years- Phiên bản cinematic orchestral\n(phần cao trào)`;

export default function App() {
  const [copiedShare, setCopiedShare] = useState(false);
  const [text, setText] = useState(''), [parseErrors, setParseErrors] = useState<ParseResult['errors']>([]), [playlist, setPlaylist] = useState<Playlist | null>(null), [dirty, setDirty] = useState(false);
  const [assets, setAssets] = useState<Record<string, Asset>>({}), [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [trackBusy, setTrackBusy] = useState<Record<string, string>>({}), [trackErrors, setTrackErrors] = useState<Record<string, string>>({});
  const [rightsAccepted, setRightsAccepted] = useState(true), [exportStatus, setExportStatus] = useState<{ text: string; snapshotChanged: boolean } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), abortRef = useRef(new AbortController()), exportSnapshotRef = useRef<string | null>(null), audioUrlsRef = useRef(audioUrls), restoredRef = useRef(false);
  audioUrlsRef.current = audioUrls;

  const verifySavedAssets = useCallback(async (current: Playlist) => {
    const musicTracks = current.sections.flatMap(section => section.tracks).filter(track => track.kind === 'music' && track.assetId);
    await forEachConcurrent(musicTracks, async track => {
      try {
        const [asset, url] = await Promise.all([getAsset(track.assetId!), fetchBlobUrl(`/assets/${track.assetId}/audio`)]);
        setAssets(prev => ({ ...prev, [asset.assetId]: asset })); setAudioUrls(prev => ({ ...prev, [asset.assetId]: url }));
      } catch {
        setPlaylist(prev => prev && ({ ...prev, sections: prev.sections.map(s => ({ ...s, tracks: s.tracks.map(t => t.id === track.id ? { ...t, assetId: null, confirmed: false } : t) })) }));
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

  const runTrackSearch = useCallback(async (track: Track) => {
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
  }, []);

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
    setExportStatus(null);
    void writeStorage(STATE_KEY, { text: '', playlist: null });
  };

  const prepareAndPlay = async (track: Track, overrideVideoId?: string) => {
    const targetVideoId = overrideVideoId ?? track.selectedVideoId;
    if (!targetVideoId) return;
    if (!rightsAccepted) { setTrackErrors(prev => ({ ...prev, [track.id]: 'Hãy xác nhận quyền sử dụng nội dung ở thanh thông báo trước khi tải âm thanh.' })); return; }
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
        const nextEnd = track.endSeconds ?? Number(asset.durationSeconds.toFixed(1));
        updateTrack(track.id, { selectedVideoId: targetVideoId, assetId: asset.assetId, endSeconds: nextEnd, ...(videoChanged ? { confirmed: false } : {}) });
        previewAudio.startMark = track.startSeconds;
        const validSegment = Object.keys(getEditErrors({ ...track, endSeconds: nextEnd }, asset.durationSeconds)).length === 0;
        previewAudio.play(track.id, prepared.audioUrl, validSegment ? track.startSeconds : 0, validSegment ? nextEnd : null, validSegment ? track.fadeInSeconds : 0, validSegment ? track.fadeOutSeconds : 0, () => undefined);
        return;
      }
      const url = audioUrls[asset.assetId];
      const nextEnd = track.endSeconds ?? Number(asset.durationSeconds.toFixed(1));
      updateTrack(track.id, { selectedVideoId: targetVideoId, assetId: asset.assetId, endSeconds: nextEnd, ...(videoChanged ? { confirmed: false } : {}) });
      previewAudio.startMark = track.startSeconds;
      const validSegment = Object.keys(getEditErrors({ ...track, endSeconds: nextEnd }, asset.durationSeconds)).length === 0;
      previewAudio.play(track.id, url, validSegment ? track.startSeconds : 0, validSegment ? nextEnd : null, validSegment ? track.fadeInSeconds : 0, validSegment ? track.fadeOutSeconds : 0, () => undefined);
    } catch (error) { setTrackErrors(prev => ({ ...prev, [track.id]: error instanceof Error ? error.message : 'Không chuẩn bị được âm thanh.' })); }
    finally { setTrackBusy(prev => ({ ...prev, [track.id]: '' })); }
  };

  const handleUploadTrackFile = async (track: Track, file: File) => {
    previewAudio.unlock();
    setTrackBusy(prev => ({ ...prev, [track.id]: 'Đang phân tích file nhạc & lưu lên Cloudflare…' })); setTrackErrors(prev => ({ ...prev, [track.id]: '' }));
    try {
      const { asset, audioUrl } = await uploadCustomAudioFile(file, track.selectedVideoId ?? undefined);
      setAssets(prev => ({ ...prev, [asset.assetId]: asset }));
      setAudioUrls(prev => ({ ...prev, [asset.assetId]: audioUrl }));
      const nextEnd = track.endSeconds ?? Number(asset.durationSeconds.toFixed(1));
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

  const allTracks = playlist?.sections.flatMap(section => section.tracks) ?? [], musicTracks = allTracks.filter(track => track.kind === 'music');
  const confirmedTracks = musicTracks.filter(track => track.confirmed && track.assetId && assets[track.assetId] && Object.keys(getEditErrors(track, assets[track.assetId].durationSeconds)).length === 0);
  const canExport = Boolean(musicTracks.length > 0 && confirmedTracks.length === musicTracks.length);

  const handleExport = async () => {
    if (!playlist || !canExport) return;
    const body = { playlistId: playlist.id, sections: playlist.sections.map(s => ({ id: s.id, title: s.title, tracks: s.tracks.filter(t => t.kind === 'music').map(t => ({ id: t.id, title: t.title, assetId: t.assetId!, startSeconds: t.startSeconds, endSeconds: t.endSeconds!, fadeInSeconds: t.fadeInSeconds, fadeOutSeconds: t.fadeOutSeconds, confirmed: true as const })) })) };
    exportSnapshotRef.current = JSON.stringify(body);
    setExportStatus({ text: `Đang chuẩn bị xuất 0/${musicTracks.length} bài…`, snapshotChanged: false });
    try {
      const url = await exportPlaylistZip(body, audioUrls, abortRef.current.signal, (done, total) => setExportStatus(prev => ({ text: `Đang xuất ${done}/${total} bài…`, snapshotChanged: prev?.snapshotChanged ?? false })));
      const link = document.createElement('a'); link.href = url; link.download = 'nhac-cuoi.zip'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setExportStatus(prev => ({ text: `Đã tải nhac-cuoi.zip (${musicTracks.length}/${musicTracks.length} bài).`, snapshotChanged: prev?.snapshotChanged ?? false }));
    } catch (error) { setExportStatus(prev => ({ text: error instanceof Error ? error.message : 'Xuất ZIP thất bại.', snapshotChanged: prev?.snapshotChanged ?? false })); }
    finally { exportSnapshotRef.current = null; }
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
            <p className="composer-subtitle">Hỗ trợ mục đánh số <code>1.</code> hoặc <code>1)</code>, khoảng thời gian <code>(1:07–2:10)</code> và dòng chú thích trong ngoặc đơn.</p>
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
        <textarea id="playlist-input" rows={7} value={text} onChange={e => setText(e.target.value)} placeholder="1. Đón khách&#10;+ Hơn cả yêu&#10;2. Cô dâu (1:07–2:10)&#10;A thousand years" />
        <div className="composer-actions">
          <button type="button" className="primary-button" disabled={!text.trim()} onClick={() => {
            if (playlist && dirty && !window.confirm('Phân tích lại sẽ thay thế danh sách đã chỉnh sửa. Bạn có chắc muốn tiếp tục?')) return;
            abortRef.current.abort(); abortRef.current = new AbortController();
            previewAudio.stop(true); Object.values(audioUrlsRef.current).forEach(url => URL.revokeObjectURL(url));
            setAssets({}); setAudioUrls({}); setTrackBusy({}); setTrackErrors({}); setExportStatus(null);
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
            const sectionConfirmed = sectionMusic.filter(t => t.confirmed).length;
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
                  const candidate = track.candidates.find(c => c.videoId === track.selectedVideoId) ?? null, asset = track.assetId ? assets[track.assetId] : undefined;
                  return (
                    <article className={`track-card ${track.confirmed ? 'is-confirmed' : ''} ${track.kind === 'note' ? 'is-note' : ''}`} key={track.id}>
                      <div className="track-row">
                        <strong className="track-index">#{tIndex + 1}</strong>
                        <label>Tên dòng<input value={track.title} onChange={e => updateTrack(track.id, { title: e.target.value, query: buildSearchQuery(e.target.value), confirmed: false })} /></label>
                        <label>Loại<select value={track.kind} onChange={e => updateTrack(track.id, { kind: e.target.value as Track['kind'], confirmed: false })}><option value="music">Bài nhạc</option><option value="note">Ghi chú / không tìm</option></select></label>
                        <label>Ghi chú<input value={track.note} placeholder="Chú thích (tùy chọn)" onChange={e => mutatePlaylist(cur => ({ ...cur, sections: cur.sections.map(s => ({ ...s, tracks: s.tracks.map(t => t.id === track.id ? { ...t, note: e.target.value } : t) })) }))} /></label>
                        <button type="button" className="danger-ghost-btn" onClick={() => mutatePlaylist(cur => ({ ...cur, sections: cur.sections.map(s => ({ ...s, tracks: s.tracks.filter(t => t.id !== track.id) })) }))}>Xóa dòng</button>
                      </div>

                      {track.kind === 'music' && (
                        <>
                          <div className="search-row">
                            <label>Query tìm kiếm<input value={track.query} onChange={e => updateTrack(track.id, { query: e.target.value })} /></label>
                            <button type="button" disabled={Boolean(trackBusy[track.id])} onClick={() => void runTrackSearch(track)}>Tìm lại</button>
                            <label className="ghost-button file-upload-btn" title="Tải file nhạc MP3/WAV từ máy lên Cloudflare để cắt">
                              📁 Chọn file nhạc
                              <input type="file" accept="audio/*" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void handleUploadTrackFile(track, f); e.currentTarget.value = ''; }} />
                            </label>
                            <span className={`track-state ${track.confirmed ? 'is-ok' : ''}`}>{track.confirmed ? 'Trạng thái: Đã xác nhận' : 'Trạng thái: Chưa xác nhận'}</span>
                          </div>

                          {trackBusy[track.id] && <p className="busy-note" role="status"><span className="spinner-dot" aria-hidden="true" /> {trackBusy[track.id]}</p>}
                          {trackErrors[track.id] && <p className="field-error" role="alert">{trackErrors[track.id]} <button type="button" onClick={() => void (track.candidates.length ? prepareAndPlay(track) : runTrackSearch(track))}>Thử lại</button></p>}

                          {track.candidates.length > 0 && (
                            <div className="candidate-box">
                              <div className="candidate-select-row">
                                <label>Ứng viên YouTube (đề xuất đầu tiên, cần nghe và xác nhận thủ công)
                                  <select value={track.selectedVideoId ?? ''} onChange={e => {
                                    if (track.assetId && audioUrls[track.assetId]) { URL.revokeObjectURL(audioUrls[track.assetId]); setAudioUrls(prev => { const next = { ...prev }; delete next[track.assetId!]; return next; }); }
                                    updateTrack(track.id, { selectedVideoId: e.target.value, assetId: null, confirmed: false });
                                  }}>
                                    {track.candidates.map((c, idx) => <option key={c.videoId} value={c.videoId}>{idx === 0 ? '[Đề xuất] ' : ''}{c.title ?? c.videoId} — {c.channel ?? 'Không rõ kênh'} ({c.durationSeconds ? `${c.durationSeconds}s` : 'không rõ thời lượng'})</option>)}
                                  </select>
                                </label>
                                <div className="candidate-actions">
                                  <button type="button" className="listen-button" disabled={Boolean(trackBusy[track.id])} onClick={() => void prepareAndPlay(track)}>Nghe thử</button>
                                  {candidate && <a className="yt-link" href={candidate.webpageUrl} target="_blank" rel="noreferrer">Mở YouTube gốc</a>}
                                </div>
                              </div>

                              <div className="candidate-cards" aria-label="Danh sách ứng viên trực quan">
                                {track.candidates.map((c, idx) => {
                                  const selected = c.videoId === track.selectedVideoId;
                                  return (
                                    <div key={c.videoId} className={`candidate-pill ${selected ? 'is-selected' : ''}`} onClick={() => {
                                      if (c.videoId === track.selectedVideoId) return;
                                      if (track.assetId && audioUrls[track.assetId]) { URL.revokeObjectURL(audioUrls[track.assetId]); setAudioUrls(prev => { const next = { ...prev }; delete next[track.assetId!]; return next; }); }
                                      updateTrack(track.id, { selectedVideoId: c.videoId, assetId: null, confirmed: false });
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
                            </div>
                          )}

                          {asset && audioUrls[asset.assetId] && <TrackEditor track={track} asset={asset} audioUrl={audioUrls[asset.assetId]} onChange={patch => updateTrack(track.id, patch)} onConfirm={() => updateTrack(track.id, { confirmed: true }, true)} />}
                        </>
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
