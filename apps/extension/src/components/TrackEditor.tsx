import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Asset } from '@wedding/shared/api';
import type { Track } from '@wedding/shared/playlist';
import { formatTimestamp, gainAtPosition, gainAtSegments, getEditErrors, resolveSegments, segmentsLength, type AudioSegment, type CutMode } from '@wedding/shared/edit';

type PlaybackMode = 'none' | 'full' | 'segment';

class PreviewAudio {
  readonly element = new Audio();
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private activeTrackId: string | null = null;
  private activeMode: PlaybackMode = 'none';
  private isActive = false;
  private currentSrc: string | null = null;
  private rafId: number | null = null;
  private segments: AudioSegment[] | null = null;
  private segIndex = 0;
  private onStop: (() => void) | undefined;
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

  private startLoop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    const tick = () => {
      if (!this.advance()) return;
      if (!this.element.paused) this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Phát một đoạn [start, end] (end = null: phát nguyên bài). */
  play(trackId: string, url: string, start: number, end: number | null, fadeIn: number, fadeOut: number, onStop?: () => void, mode: PlaybackMode = end === null ? 'full' : 'segment'): void {
    const segments = end === null ? null : [{ startSeconds: start, endSeconds: end, fadeInSeconds: fadeIn, fadeOutSeconds: fadeOut }];
    this.playSegments(trackId, url, segments, start, onStop, mode);
  }

  /** Phát nối tiếp nhiều đoạn của cùng một file, tự nhảy qua phần bị bỏ. */
  playSegments(trackId: string, url: string, segments: AudioSegment[] | null, from: number, onStop?: () => void, mode: PlaybackMode = segments ? 'segment' : 'full'): void {
    this.stop();
    this.unlock();
    this.activeTrackId = trackId;
    this.activeMode = mode;
    this.isActive = true;
    this.segments = segments?.length ? segments : null;
    this.onStop = onStop;
    this.startMark = this.segments?.[0].startSeconds ?? from;
    if (this.currentSrc !== url) {
      this.currentSrc = url;
      this.element.src = url;
    }
    this.element.currentTime = from;
    this.segIndex = this.locate(from);
    this.reschedule(from);
    this.element.ontimeupdate = () => { this.advance(); };
    this.element.onplay = () => {
      this.isActive = true;
      this.startLoop();
      this.emit();
    };
    this.element.onpause = () => {
      if (this.element.paused) this.isActive = false;
      this.emit();
    };
    this.element.onended = () => this.finish();
    void this.element.play().then(() => {
      this.isActive = true;
      this.startLoop();
      this.emit();
    }).catch(() => {
      this.isActive = false;
      this.emit();
    });
    this.emit();
  }

  private locate(position: number): number {
    if (!this.segments) return 0;
    const index = this.segments.findIndex(seg => position < seg.endSeconds);
    return index === -1 ? this.segments.length - 1 : index;
  }

  /** Kiểm tra vị trí phát: nhảy sang đoạn kế tiếp hoặc dừng khi hết. Trả về false nếu đã dừng. */
  private advance(): boolean {
    if (this.segments) {
      const time = this.element.currentTime;
      const seg = this.segments[this.segIndex];
      if (time >= seg.endSeconds) {
        if (this.segIndex + 1 >= this.segments.length) {
          this.finish();
          return false;
        }
        this.segIndex++;
        this.jumpTo(this.segments[this.segIndex].startSeconds);
      } else if (this.segIndex > 0 && time < seg.startSeconds) {
        this.jumpTo(seg.startSeconds);
      }
    }
    this.emit();
    return true;
  }

  private jumpTo(position: number): void {
    this.element.currentTime = position;
    this.reschedule(position);
  }

  private finish(): void {
    const callback = this.onStop;
    this.stop();
    callback?.();
  }

  private reschedule(position: number): void {
    if (!this.ctx || !this.gain) return;
    const gain = this.gain.gain, now = this.ctx.currentTime;
    gain.cancelScheduledValues(now);
    if (!this.segments) {
      gain.setValueAtTime(1, now);
      return;
    }
    const seg = this.segments[this.segIndex];
    const { startSeconds: start, endSeconds: end, fadeInSeconds: fadeIn, fadeOutSeconds: fadeOut } = seg;
    const pos = Math.min(position, end), at = (t: number) => now + Math.max(0, t - pos);
    gain.setValueAtTime(gainAtPosition(pos, seg), now);
    if (pos < start) gain.setValueAtTime(fadeIn > 0 ? 0 : 1, at(start));
    const fadeInEnd = start + fadeIn, fadeOutStart = end - fadeOut;
    if (fadeIn > 0 && pos < fadeInEnd) gain.linearRampToValueAtTime(1, at(fadeInEnd));
    if (fadeOut > 0 && end > pos) {
      if (pos < fadeOutStart) gain.setValueAtTime(1, at(fadeOutStart));
      gain.linearRampToValueAtTime(0, at(end));
    }
  }

  /** Cập nhật các đoạn khi đang phát (ví dụ đổi fade/tay nắm). null = phát nguyên bài. */
  setSegments(segments: AudioSegment[] | null): void {
    this.segments = segments?.length ? segments : null;
    this.segIndex = this.locate(this.element.currentTime);
    this.reschedule(this.element.currentTime);
  }

  seek(position: number): void {
    this.element.currentTime = position;
    this.segIndex = this.locate(position);
    this.reschedule(position);
  }

  stop(): void {
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
    this.activeTrackId = null;
    this.activeMode = 'none';
    this.isActive = false;
    this.segments = null;
    this.onStop = undefined;
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
  const dur = asset.durationSeconds, end = track.endSeconds ?? dur;
  const cutMode: CutMode = track.cutMode ?? 'keep', isRemove = cutMode === 'remove';
  const errors = getEditErrors({ ...track, endSeconds: end }, dur), hasErrors = Object.keys(errors).length > 0;
  const segments = useMemo(
    () => resolveSegments({ startSeconds: track.startSeconds, endSeconds: end, fadeInSeconds: track.fadeInSeconds, fadeOutSeconds: track.fadeOutSeconds, cutMode }, dur),
    [cutMode, dur, end, track.fadeInSeconds, track.fadeOutSeconds, track.startSeconds],
  );
  const resultLength = segmentsLength(segments);
  const startPct = Math.max(0, Math.min(100, (track.startSeconds / dur) * 100)), endPct = Math.max(0, Math.min(100, (end / dur) * 100)), playheadPct = Math.max(0, Math.min(100, (playhead / dur) * 100));
  const segmentLength = Math.max(0, end - track.startSeconds);
  const maxPeak = useMemo(() => Math.max(0.08, ...asset.peaks.map(([l, h]) => Math.max(Math.abs(l), Math.abs(h)))), [asset.peaks]);

  useEffect(() => { if (track.endSeconds === null) onChange({ endSeconds: dur }); }, [dur, onChange, track.endSeconds]);

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
    previewAudio.setSegments(mode === 'segment' ? segments : null);
  }, [mode, segments]);

  useEffect(() => {
    const canvas = canvasRef.current, ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const w = canvas.width, h = canvas.height, mid = h / 2, toX = (sec: number) => Math.max(0, Math.min(w, (sec / dur) * w));
    const sX = toX(track.startSeconds), eX = toX(end);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#07254d'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#0c356a';
    segments.forEach(seg => ctx.fillRect(toX(seg.startSeconds), 0, Math.max(2, toX(seg.endSeconds) - toX(seg.startSeconds)), h));
    ctx.strokeStyle = 'rgba(116, 174, 246, 0.14)'; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
    asset.peaks.forEach(([low, high], index) => {
      const ratio = index / asset.peaks.length, x = ratio * w, sec = ratio * dur;
      const inside = segments.some(seg => sec >= seg.startSeconds && sec <= seg.endSeconds);
      const gain = inside && !hasErrors ? gainAtSegments(sec, segments) : 1;
      const norm = Math.min(1, Math.max(Math.abs(low), Math.abs(high)) / maxPeak);
      const amp = Math.max(0.03, norm * (inside ? Math.max(0.15, gain) : 0.8));
      const barH = Math.max(3, amp * (h * 0.84));
      ctx.fillStyle = inside ? '#00f57a' : 'rgba(92, 141, 204, 0.28)';
      ctx.fillRect(x, mid - barH / 2, 2, barH);
      if (inside && barH > 10) { ctx.fillStyle = '#6bffb8'; ctx.fillRect(x, mid - barH * 0.25, 2, barH * 0.5); }
    });
    if (isRemove) {
      // Đoạn giữa 2 tay nắm sẽ bị bỏ: phủ màu đỏ + gạch chéo.
      ctx.fillStyle = 'rgba(70, 8, 24, 0.62)';
      ctx.fillRect(sX, 0, Math.max(0, eX - sX), h);
      ctx.save(); ctx.beginPath(); ctx.rect(sX, 0, Math.max(0, eX - sX), h); ctx.clip();
      ctx.strokeStyle = 'rgba(255, 92, 120, 0.35)'; ctx.lineWidth = 2; ctx.beginPath();
      for (let x = sX - h; x < eX; x += 14) { ctx.moveTo(x, h); ctx.lineTo(x + h, 0); }
      ctx.stroke(); ctx.restore();
    } else {
      ctx.fillStyle = 'rgba(3, 14, 32, 0.58)';
      if (sX > 0) ctx.fillRect(0, 0, sX, h);
      if (eX < w) ctx.fillRect(eX, 0, w - eX, h);
    }
    if (!hasErrors) {
      ctx.strokeStyle = 'rgba(25, 211, 255, 0.72)'; ctx.lineWidth = 2;
      segments.forEach(seg => {
        if (seg.fadeInSeconds <= 0 && seg.fadeOutSeconds <= 0) return;
        const a = toX(seg.startSeconds), b = toX(seg.endSeconds);
        const fiX = Math.min(b, toX(seg.startSeconds + seg.fadeInSeconds)), foX = Math.max(a, toX(seg.endSeconds - seg.fadeOutSeconds));
        ctx.beginPath();
        ctx.moveTo(a, seg.fadeInSeconds > 0 ? h - 6 : 10); ctx.lineTo(fiX, 10); ctx.lineTo(foX, 10); ctx.lineTo(b, seg.fadeOutSeconds > 0 ? h - 6 : 10); ctx.stroke();
      });
    }
  }, [asset, dur, end, hasErrors, isRemove, maxPeak, segments, track.startSeconds]);

  const segmentsFor = (customStart: number, customEnd: number, customMode: CutMode = cutMode) =>
    resolveSegments({ startSeconds: customStart, endSeconds: customEnd, fadeInSeconds: track.fadeInSeconds, fadeOutSeconds: track.fadeOutSeconds, cutMode: customMode }, dur);

  /** from: vị trí bắt đầu phát (mặc định là đầu đoạn được giữ đầu tiên). */
  const startPlayback = (nextMode: 'full' | 'segment', customStart = track.startSeconds, customEnd = end, from?: number, customMode: CutMode = cutMode) => {
    if (nextMode === 'full') {
      setPlayhead(0);
      previewAudio.playSegments(track.id, audioUrl, null, 0, () => setMode('none'), 'full');
      return;
    }
    const checkErrors = getEditErrors({ ...track, cutMode: customMode, startSeconds: customStart, endSeconds: customEnd }, dur);
    if (Object.keys(checkErrors).length > 0) return;
    const segs = segmentsFor(customStart, customEnd, customMode);
    const position = from ?? segs[0].startSeconds;
    setPlayhead(position);
    previewAudio.playSegments(track.id, audioUrl, segs, position, () => setMode('none'), 'segment');
  };

  /** Ở chế độ bỏ đoạn: phát từ trước chỗ nối vài giây để nghe mối nối. */
  const replayFrom = (nextStart: number, nextEnd: number, customMode: CutMode = cutMode) =>
    customMode === 'remove' ? (nextStart > 0.05 ? Math.max(0, nextStart - 3) : nextEnd) : nextStart;

  const adjustTrimAndReplay = (nextStart: number, nextEnd: number, immediate = true) => {
    const from = replayFrom(nextStart, nextEnd);
    setPlayhead(from);
    onChange({ startSeconds: nextStart, endSeconds: nextEnd, confirmed: false });
    clearTimeout(dragReplayTimer.current);
    if (immediate) {
      startPlayback('segment', nextStart, nextEnd, from);
    } else {
      dragReplayTimer.current = setTimeout(() => startPlayback('segment', nextStart, nextEnd, from), 90);
    }
  };

  const changeCutMode = (nextMode: CutMode) => {
    if (nextMode === cutMode) return;
    onChange({ cutMode: nextMode, confirmed: false });
    if (mode !== 'none') startPlayback('segment', track.startSeconds, end, replayFrom(track.startSeconds, end, nextMode), nextMode);
  };

  const timeFromClientX = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return 0;
    return Math.min(dur, Number((Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * dur).toFixed(1)));
  };

  const applyDrag = (target: 'start' | 'end' | 'playhead', sec: number, finalCommit = false) => {
    if (target === 'start') {
      const nextStart = Math.min(sec, Number(Math.max(0, end - 0.1).toFixed(1)));
      adjustTrimAndReplay(nextStart, end, finalCommit);
    } else if (target === 'end') {
      const nextEnd = Math.max(sec, Math.min(dur, Number((track.startSeconds + 0.1).toFixed(1))));
      adjustTrimAndReplay(track.startSeconds, nextEnd, finalCommit);
    } else {
      setPlayhead(sec);
      if (previewAudio.isPlaying(track.id)) previewAudio.seek(sec);
    }
  };

  const stepValue = (field: 'startSeconds' | 'endSeconds', delta: number) => {
    const nextStart = field === 'startSeconds' ? Math.max(0, Math.min(dur, Number((track.startSeconds + delta).toFixed(1)))) : track.startSeconds;
    const nextEnd = field === 'endSeconds' ? Math.max(0, Math.min(dur, Number((end + delta).toFixed(1)))) : end;
    adjustTrimAndReplay(nextStart, nextEnd, true);
  };

  return (
    <div className="track-editor mp3cut-studio" aria-label={`Trình cắt nhạc ${track.title}`}>
      <div className="mp3cut-topbar">
        <div className="mp3cut-tools" role="toolbar" aria-label="Công cụ cắt nhạc">
          <div className="mp3cut-cutmode" role="radiogroup" aria-label="Cách xử lý đoạn đã chọn">
            <button type="button" role="radio" aria-checked={!isRemove} className={`mp3cut-cutmode-btn ${!isRemove ? 'is-active' : ''}`} title="Chỉ giữ lại đoạn nằm giữa 2 tay nắm" onClick={() => changeCutMode('keep')}>✂ Giữ đoạn chọn</button>
            <button type="button" role="radio" aria-checked={isRemove} className={`mp3cut-cutmode-btn is-remove ${isRemove ? 'is-active' : ''}`} title="Bỏ đoạn nằm giữa 2 tay nắm, nối phần trước và sau lại" onClick={() => changeCutMode('remove')}>✕ Bỏ đoạn chọn</button>
          </div>
          <button type="button" className={`mp3cut-tool-btn ${mode === 'segment' ? 'is-active' : ''}`} disabled={hasErrors} onClick={() => startPlayback('segment')}>{isRemove ? 'Nghe phần còn lại' : 'Nghe đoạn đã chọn'}</button>
          <button type="button" className={`mp3cut-tool-btn ${mode === 'full' ? 'is-active' : ''}`} onClick={() => startPlayback('full')}>Nghe nguyên bài</button>
        </div>
        <div className="mp3cut-top-actions">
          <button type="button" className="mp3cut-reset-btn" onClick={() => { previewAudio.stop(); setMode('none'); setPlayhead(0); onChange({ startSeconds: 0, endSeconds: dur, fadeInSeconds: 0, fadeOutSeconds: 0, cutMode: 'keep', confirmed: false }); }}>↺ Đặt lại</button>
        </div>
      </div>

      <div className="mp3cut-stage-wrap">
        <div className="mp3cut-floating-times" aria-hidden="true">
          <span className="mp3cut-PlayheadPill" style={{ left: `${playheadPct}%` }}>{formatTimestamp(playhead)}</span>
        </div>

        <div
          ref={stageRef}
          className={`mp3cut-wavebox ${isRemove ? 'is-remove-mode' : ''}`}
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
          <span className="mp3cut-segment-watermark">{isRemove ? `Bỏ ${formatTimestamp(segmentLength)}` : formatTimestamp(segmentLength)}</span>
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
          {isRemove
            ? <span>Bỏ: <strong className="mp3cut-removed-len">{formatTimestamp(segmentLength)}</strong> · Còn lại: <strong>{formatTimestamp(resultLength)}</strong> / Tổng {formatTimestamp(dur)}</span>
            : <span>Đoạn cắt: <strong>{formatTimestamp(segmentLength)}</strong> / Tổng {formatTimestamp(dur)}</span>}
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
            <button type="button" className="mp3cut-play-btn" disabled={hasErrors} onClick={() => startPlayback('segment')} aria-label={isRemove ? 'Phát phần còn lại' : 'Phát đoạn đã chọn'}>▶ Phát</button>
          )}

          <div className="mp3cut-fade-capsule" role="group" aria-label="Tùy chỉnh Fade-in và Fade-out">
            <label htmlFor={`${id}-fi`} className={`mp3cut-fade-item ${track.fadeInSeconds > 0 ? 'is-enabled' : ''}`} title={isRemove ? 'Bật/tắt làm mượt đầu bài sau khi cắt (mặc định 3s)' : 'Bật/tắt làm mượt đầu đoạn (mặc định 3s)'}>
              <input id={`${id}-fi`} type="checkbox" checked={track.fadeInSeconds > 0} onChange={e => onChange({ fadeInSeconds: e.target.checked ? 3 : 0, confirmed: false })} />
              <span className="mp3cut-fade-icon" aria-hidden="true">╭─</span>
              <span className="mp3cut-fade-label">Fade-in</span>
              <input aria-label="Số giây fade-in" className="mp3cut-sec-input" type="number" step="0.1" min="0" disabled={track.fadeInSeconds === 0} value={track.fadeInSeconds} onChange={e => onChange({ fadeInSeconds: Number(e.target.value), confirmed: false })} />
              <span className="mp3cut-unit">s</span>
            </label>
            <label htmlFor={`${id}-fo`} className={`mp3cut-fade-item ${track.fadeOutSeconds > 0 ? 'is-enabled' : ''}`} title={isRemove ? 'Bật/tắt làm mượt cuối bài sau khi cắt (mặc định 3s)' : 'Bật/tắt làm mượt cuối đoạn (mặc định 3s)'}>
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
