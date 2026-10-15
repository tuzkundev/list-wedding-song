import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Asset } from '@wedding/shared/api';
import type { Track } from '@wedding/shared/playlist';
import { formatTimestamp, gainAtPosition, getEditErrors } from '@wedding/shared/edit';

type PlaybackMode = 'none' | 'full' | 'segment';

class PreviewAudio {
  readonly element = new Audio();
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private activeTrackId: string | null = null;
  private activeMode: PlaybackMode = 'none';
  private isActive = false;
  private blobUrl: string | null = null;
  private rafId: number | null = null;
  private readonly listeners = new Set<() => void>();
  startMark = 0;

  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const source = this.ctx.createMediaElementSource(this.element);
      this.gain = this.ctx.createGain();
      source.connect(this.gain).connect(this.ctx.destination);
    }
    void this.ctx.resume();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.listeners.forEach(listener => listener());
  }

  private startLoop(end: number | null): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    const tick = () => {
      if (end !== null && this.element.currentTime >= end) {
        this.stop();
        return;
      }
      this.emit();
      if (!this.element.paused) this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  play(trackId: string, url: string, start: number, end: number | null, fadeIn: number, fadeOut: number, onStop?: () => void, mode: PlaybackMode = end === null ? 'full' : 'segment'): void {
    this.stop();
    this.unlock();
    this.activeTrackId = trackId;
    this.activeMode = mode;
    this.isActive = true;
    this.startMark = start;
    if (this.blobUrl !== url) {
      this.blobUrl = url;
      this.element.src = url;
    }
    this.element.currentTime = start;
    this.schedule(start, end, fadeIn, fadeOut);
    this.element.ontimeupdate = () => {
      if (end !== null && this.element.currentTime >= end) {
        this.stop();
        onStop?.();
      } else {
        this.emit();
      }
    };
    this.element.onplay = () => {
      this.isActive = true;
      this.startLoop(end);
      this.emit();
    };
    this.element.onpause = () => {
      if (this.element.paused) this.isActive = false;
      this.emit();
    };
    this.element.onended = () => {
      this.stop();
      onStop?.();
    };
    void this.element.play().then(() => {
      this.isActive = true;
      this.startLoop(end);
      this.emit();
    }).catch(() => {
      this.isActive = false;
      this.emit();
    });
    this.emit();
  }

  schedule(position: number, end: number | null, fadeIn: number, fadeOut: number): void {
    if (!this.ctx || !this.gain) return;
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    if (end === null) {
      this.gain.gain.setValueAtTime(1, now);
      return;
    }
    const start = Math.min(position, end);
    const edit = { startSeconds: this.startMark, endSeconds: end, fadeInSeconds: fadeIn, fadeOutSeconds: fadeOut };
    this.gain.gain.setValueAtTime(gainAtPosition(start, edit), now);
    const fadeInEnd = edit.startSeconds + fadeIn, fadeOutStart = end - fadeOut;
    if (fadeIn > 0 && start < fadeInEnd) this.gain.gain.linearRampToValueAtTime(1, now + fadeInEnd - start);
    if (fadeOut > 0 && end > start) {
      if (start < fadeOutStart) this.gain.gain.setValueAtTime(1, now + fadeOutStart - start);
      this.gain.gain.linearRampToValueAtTime(0, now + end - start);
    }
  }

  stop(revoke = false): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.element.pause();
    this.element.ontimeupdate = null;
    this.element.onplay = null;
    this.element.onpause = null;
    this.element.onended = null;
    if (this.ctx && this.gain) {
      this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.gain.gain.setValueAtTime(1, this.ctx.currentTime);
    }
    if (revoke && this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
      this.element.removeAttribute('src');
    }
    this.activeTrackId = null;
    this.activeMode = 'none';
    this.isActive = false;
    this.emit();
  }

  isPlaying(trackId: string): boolean {
    return this.activeTrackId === trackId && (this.isActive || !this.element.paused);
  }

  getMode(trackId: string): PlaybackMode {
    return this.isPlaying(trackId) ? this.activeMode : 'none';
  }
}
export const previewAudio = new PreviewAudio();

export function TrackEditor({ track, asset, audioUrl, onChange, onConfirm }: { track: Track; asset: Asset; audioUrl: string; onChange: (patch: Partial<Track>) => void; onConfirm: () => void }) {
  const id = useId(), canvasRef = useRef<HTMLCanvasElement>(null), stageRef = useRef<HTMLDivElement>(null), dragReplayTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [playhead, setPlayhead] = useState(track.startSeconds), [mode, setMode] = useState<PlaybackMode>(() => previewAudio.getMode(track.id));
  const [dragTarget, setDragTarget] = useState<'start' | 'end' | 'playhead' | null>(null);
  const dur = asset.durationSeconds, end = track.endSeconds ?? Number(dur.toFixed(1));
  const errors = getEditErrors({ ...track, endSeconds: end }, dur), hasErrors = Object.keys(errors).length > 0;
  const startPct = Math.max(0, Math.min(100, (track.startSeconds / dur) * 100)), endPct = Math.max(0, Math.min(100, (end / dur) * 100)), playheadPct = Math.max(0, Math.min(100, (playhead / dur) * 100));
  const segmentLength = Math.max(0, end - track.startSeconds);
  const maxPeak = useMemo(() => Math.max(0.08, ...asset.peaks.map(([l, h]) => Math.max(Math.abs(l), Math.abs(h)))), [asset.peaks]);

  useEffect(() => { if (track.endSeconds === null) onChange({ endSeconds: Number(dur.toFixed(1)) }); }, [dur, onChange, track.endSeconds]);

  useEffect(() => {
    const sync = () => {
      const currentMode = previewAudio.getMode(track.id);
      setMode(currentMode);
      if (currentMode !== 'none') setPlayhead(previewAudio.element.currentTime);
    };
    sync();
    return previewAudio.subscribe(sync);
  }, [track.id]);

  useEffect(() => {
    if (mode === 'none') return;
    previewAudio.startMark = track.startSeconds;
    previewAudio.schedule(previewAudio.element.currentTime, mode === 'segment' ? end : null, mode === 'segment' ? track.fadeInSeconds : 0, mode === 'segment' ? track.fadeOutSeconds : 0);
  }, [end, mode, track.fadeInSeconds, track.fadeOutSeconds, track.startSeconds]);

  useEffect(() => {
    const canvas = canvasRef.current, ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const w = canvas.width, h = canvas.height, mid = h / 2, sX = (track.startSeconds / dur) * w, eX = Math.min(w, (end / dur) * w);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#07254d'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#0c356a'; ctx.fillRect(sX, 0, Math.max(2, eX - sX), h);
    ctx.strokeStyle = 'rgba(116, 174, 246, 0.14)'; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
    const edit = { startSeconds: track.startSeconds, endSeconds: end, fadeInSeconds: track.fadeInSeconds, fadeOutSeconds: track.fadeOutSeconds };
    asset.peaks.forEach(([low, high], index) => {
      const ratio = index / asset.peaks.length, x = ratio * w, sec = ratio * dur, inside = sec >= track.startSeconds && sec <= end;
      const gain = inside && !hasErrors ? gainAtPosition(sec, edit) : 1;
      const norm = Math.min(1, Math.max(Math.abs(low), Math.abs(high)) / maxPeak);
      const amp = Math.max(0.03, norm * (inside ? Math.max(0.15, gain) : 0.8));
      const barH = Math.max(3, amp * (h * 0.84));
      ctx.fillStyle = inside ? '#00f57a' : 'rgba(92, 141, 204, 0.28)';
      ctx.fillRect(x, mid - barH / 2, 2, barH);
      if (inside && barH > 10) { ctx.fillStyle = '#6bffb8'; ctx.fillRect(x, mid - barH * 0.25, 2, barH * 0.5); }
    });
    ctx.fillStyle = 'rgba(3, 14, 32, 0.58)';
    if (sX > 0) ctx.fillRect(0, 0, sX, h);
    if (eX < w) ctx.fillRect(eX, 0, w - eX, h);
    if (!hasErrors && (track.fadeInSeconds > 0 || track.fadeOutSeconds > 0)) {
      const fiX = Math.min(eX, ((track.startSeconds + track.fadeInSeconds) / dur) * w), foX = Math.max(sX, ((end - track.fadeOutSeconds) / dur) * w);
      ctx.strokeStyle = 'rgba(25, 211, 255, 0.72)'; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(sX, h - 6); ctx.lineTo(fiX, 10); ctx.lineTo(foX, 10); ctx.lineTo(eX, h - 6); ctx.stroke();
    }
  }, [asset, dur, end, hasErrors, maxPeak, track.fadeInSeconds, track.fadeOutSeconds, track.startSeconds]);

  const startPlayback = (nextMode: 'full' | 'segment', customStart = track.startSeconds, customEnd = end) => {
    const checkErrors = getEditErrors({ ...track, startSeconds: customStart, endSeconds: customEnd }, dur);
    if (nextMode === 'segment' && Object.keys(checkErrors).length > 0) return;
    const from = nextMode === 'segment' ? customStart : 0;
    setPlayhead(from);
    previewAudio.play(track.id, audioUrl, from, nextMode === 'segment' ? customEnd : null, nextMode === 'segment' ? track.fadeInSeconds : 0, nextMode === 'segment' ? track.fadeOutSeconds : 0, () => setMode('none'), nextMode);
  };

  const adjustTrimAndReplay = (nextStart: number, nextEnd: number, immediate = true) => {
    setPlayhead(nextStart);
    onChange({ startSeconds: nextStart, endSeconds: nextEnd, confirmed: false });
    clearTimeout(dragReplayTimer.current);
    if (immediate) {
      startPlayback('segment', nextStart, nextEnd);
    } else {
      dragReplayTimer.current = setTimeout(() => startPlayback('segment', nextStart, nextEnd), 90);
    }
  };

  const timeFromClientX = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return 0;
    return Number((Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * dur).toFixed(1));
  };

  const applyDrag = (target: 'start' | 'end' | 'playhead', sec: number, finalCommit = false) => {
    if (target === 'start') {
      const nextStart = Math.min(sec, Number(Math.max(0, end - 0.1).toFixed(1)));
      adjustTrimAndReplay(nextStart, end, finalCommit);
    } else if (target === 'end') {
      const nextEnd = Math.max(sec, Number(Math.min(dur, track.startSeconds + 0.1).toFixed(1)));
      adjustTrimAndReplay(track.startSeconds, nextEnd, finalCommit);
    } else {
      setPlayhead(sec);
      if (previewAudio.isPlaying(track.id)) {
        previewAudio.element.currentTime = sec;
        previewAudio.schedule(sec, mode === 'segment' ? end : null, track.fadeInSeconds, track.fadeOutSeconds);
      }
    }
  };

  const stepValue = (field: 'startSeconds' | 'endSeconds', delta: number) => {
    const nextStart = field === 'startSeconds' ? Number(Math.max(0, Math.min(dur, track.startSeconds + delta)).toFixed(1)) : track.startSeconds;
    const nextEnd = field === 'endSeconds' ? Number(Math.max(0, Math.min(dur, end + delta)).toFixed(1)) : end;
    adjustTrimAndReplay(nextStart, nextEnd, true);
  };

  return (
    <div className="track-editor mp3cut-studio" aria-label={`Trình cắt nhạc ${track.title}`}>
      <div className="mp3cut-topbar">
        <div className="mp3cut-tools" role="toolbar" aria-label="Công cụ cắt nhạc">
          <span className="mp3cut-tool-pill is-active">✂ Cắt tỉa</span>
          <button type="button" className={`mp3cut-tool-btn ${mode === 'segment' ? 'is-active' : ''}`} disabled={hasErrors} onClick={() => startPlayback('segment')}>Nghe đoạn đã chọn</button>
          <button type="button" className={`mp3cut-tool-btn ${mode === 'full' ? 'is-active' : ''}`} onClick={() => startPlayback('full')}>Nghe nguyên bài</button>
        </div>
        <div className="mp3cut-top-actions">
          <button type="button" className="mp3cut-reset-btn" onClick={() => { previewAudio.stop(); setMode('none'); setPlayhead(0); onChange({ startSeconds: 0, endSeconds: Number(dur.toFixed(1)), fadeInSeconds: 0, fadeOutSeconds: 0, confirmed: false }); }}>↺ Đặt lại</button>
        </div>
      </div>

      <div className="mp3cut-stage-wrap">
        <div className="mp3cut-floating-times" aria-hidden="true">
          <span className="mp3cut-PlayheadPill" style={{ left: `${playheadPct}%` }}>{formatTimestamp(playhead)}</span>
        </div>

        <div
          ref={stageRef}
          className="mp3cut-wavebox"
          onPointerMove={e => { if (dragTarget) applyDrag(dragTarget, timeFromClientX(e.clientX), false); }}
          onPointerUp={e => {
            if (dragTarget) applyDrag(dragTarget, timeFromClientX(e.clientX), true);
            setDragTarget(null);
          }}
          onPointerCancel={() => setDragTarget(null)}
        >
          <span className="mp3cut-track-watermark">{track.title}.mp3</span>
          <canvas
            ref={canvasRef}
            width={1120}
            height={156}
            className="waveform mp3cut-canvas"
            onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); setDragTarget('playhead'); applyDrag('playhead', timeFromClientX(e.clientX), true); }}
          />
          <div className="mp3cut-playhead-line" style={{ left: `${playheadPct}%` }} aria-hidden="true" />
          <span className="mp3cut-segment-watermark">{formatTimestamp(segmentLength)}</span>
          <div
            className="mp3cut-handle mp3cut-handle--start"
            style={{ left: `${startPct}%` }}
            title="Kéo tay nắm đầu (nhạc sẽ phát lại từ điểm đầu)"
            onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setDragTarget('start'); }}
          ><span /></div>
          <div
            className="mp3cut-handle mp3cut-handle--end"
            style={{ left: `${endPct}%` }}
            title="Kéo tay nắm cuối (nhạc sẽ phát lại từ điểm đầu)"
            onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setDragTarget('end'); }}
          ><span /></div>
        </div>

        <div className="mp3cut-scale-row">
          <span>{formatTimestamp(track.startSeconds)}</span>
          <span>Đoạn cắt: <strong>{formatTimestamp(segmentLength)}</strong> / Tổng {formatTimestamp(dur)}</span>
          <span>{formatTimestamp(end)}</span>
        </div>
      </div>

      <div className="range-sliders mp3cut-sr-sliders" aria-label="Tay nắm chọn đoạn">
        <label htmlFor={`${id}-srange`}>Tay nắm đầu<input id={`${id}-srange`} type="range" min={0} max={dur} step={0.1} value={Math.min(track.startSeconds, dur)} onChange={e => adjustTrimAndReplay(Number(e.target.value), end, true)} /></label>
        <label htmlFor={`${id}-erange`}>Tay nắm cuối<input id={`${id}-erange`} type="range" min={0} max={dur} step={0.1} value={Math.min(end, dur)} onChange={e => adjustTrimAndReplay(track.startSeconds, Number(e.target.value), true)} /></label>
      </div>

      <div className="mp3cut-bottom-bar">
        <div className="mp3cut-transport">
          {mode !== 'none' ? (
            <button type="button" className="mp3cut-play-btn is-playing" onClick={() => { previewAudio.stop(); setMode('none'); }}>⏸ Tạm dừng</button>
          ) : (
            <button type="button" className="mp3cut-play-btn" disabled={hasErrors} onClick={() => startPlayback('segment')} aria-label="Phát đoạn đã chọn">▶ Phát</button>
          )}

          <div className="mp3cut-fade-capsule" role="group" aria-label="Tùy chỉnh Fade-in và Fade-out">
            <label htmlFor={`${id}-fi`} className={`mp3cut-fade-item ${track.fadeInSeconds > 0 ? 'is-enabled' : ''}`} title="Bật/tắt làm mượt đầu đoạn (mặc định 3s)">
              <input id={`${id}-fi`} type="checkbox" checked={track.fadeInSeconds > 0} onChange={e => onChange({ fadeInSeconds: e.target.checked ? 3 : 0, confirmed: false })} />
              <span className="mp3cut-fade-icon" aria-hidden="true">╭─</span>
              <span className="mp3cut-fade-label">Fade-in</span>
              <input aria-label="Số giây fade-in" className="mp3cut-sec-input" type="number" step="0.1" min="0" disabled={track.fadeInSeconds === 0} value={track.fadeInSeconds} onChange={e => onChange({ fadeInSeconds: Number(e.target.value), confirmed: false })} />
              <span className="mp3cut-unit">s</span>
            </label>
            <label htmlFor={`${id}-fo`} className={`mp3cut-fade-item ${track.fadeOutSeconds > 0 ? 'is-enabled' : ''}`} title="Bật/tắt làm mượt cuối đoạn (mặc định 3s)">
              <input id={`${id}-fo`} type="checkbox" checked={track.fadeOutSeconds > 0} onChange={e => onChange({ fadeOutSeconds: e.target.checked ? 3 : 0, confirmed: false })} />
              <span className="mp3cut-fade-icon" aria-hidden="true">─╮</span>
              <span className="mp3cut-fade-label">Fade-out</span>
              <input aria-label="Số giây fade-out" className="mp3cut-sec-input" type="number" step="0.1" min="0" disabled={track.fadeOutSeconds === 0} value={track.fadeOutSeconds} onChange={e => onChange({ fadeOutSeconds: Number(e.target.value), confirmed: false })} />
              <span className="mp3cut-unit">s</span>
            </label>
          </div>

          <div className="mp3cut-time-capsule" role="group" aria-label="Thời gian bắt đầu và kết thúc">
            <div className="mp3cut-time-box">
              <label htmlFor={`${id}-start`}>Bắt đầu (giây)</label>
              <div className="mp3cut-time-input-row">
                <span className="mp3cut-mmss">{formatTimestamp(track.startSeconds)}</span>
                <input id={`${id}-start`} type="number" step="0.1" value={track.startSeconds} onChange={e => adjustTrimAndReplay(Number(e.target.value), end, true)} />
                <div className="mp3cut-steppers">
                  <button type="button" tabIndex={-1} aria-label="Tăng điểm bắt đầu 0.1 giây" onClick={() => stepValue('startSeconds', 0.1)}>▲</button>
                  <button type="button" tabIndex={-1} aria-label="Giảm điểm bắt đầu 0.1 giây" onClick={() => stepValue('startSeconds', -0.1)}>▼</button>
                </div>
              </div>
            </div>
            <span className="mp3cut-time-divider" aria-hidden="true">→</span>
            <div className="mp3cut-time-box">
              <label htmlFor={`${id}-end`} title={`Tối đa ${dur.toFixed(1)} giây`}>Kết thúc (giây)</label>
              <div className="mp3cut-time-input-row">
                <span className="mp3cut-mmss">{formatTimestamp(end)}</span>
                <input id={`${id}-end`} type="number" step="0.1" value={end} onChange={e => adjustTrimAndReplay(track.startSeconds, Number(e.target.value), true)} />
                <div className="mp3cut-steppers">
                  <button type="button" tabIndex={-1} aria-label="Tăng điểm kết thúc 0.1 giây" onClick={() => stepValue('endSeconds', 0.1)}>▲</button>
                  <button type="button" tabIndex={-1} aria-label="Giảm điểm kết thúc 0.1 giây" onClick={() => stepValue('endSeconds', -0.1)}>▼</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mp3cut-save-group">
          <span className="mp3cut-format-pill" title="Xuất chuẩn MP3 192 kbps">mp3 · 192k</span>
          <button type="button" className={`mp3cut-save-btn primary-button ${track.confirmed ? 'is-confirmed' : ''}`} disabled={hasErrors || track.confirmed} onClick={onConfirm}>
            {track.confirmed ? 'Đã xác nhận bản này' : 'Đúng bản này'}
          </button>
        </div>
      </div>

      {hasErrors && (
        <div className="mp3cut-errors" role="alert">
          {errors.startSeconds && <span className="field-error">{errors.startSeconds}</span>}
          {errors.endSeconds && <span className="field-error">{errors.endSeconds}</span>}
          {errors.fadeInSeconds && <span className="field-error">{errors.fadeInSeconds}</span>}
          {errors.fadeOutSeconds && <span className="field-error">{errors.fadeOutSeconds}</span>}
          {errors.duration && <span className="field-error">{errors.duration}</span>}
        </div>
      )}
    </div>
  );
}
