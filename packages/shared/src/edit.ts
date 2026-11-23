/** 'keep' = chỉ giữ đoạn giữa 2 tay nắm; 'remove' = bỏ đoạn giữa 2 tay nắm, giữ phần còn lại. */
export type CutMode = 'keep' | 'remove';
export interface AudioEdit { startSeconds: number; endSeconds: number | null; fadeInSeconds: number; fadeOutSeconds: number; cutMode?: CutMode }
export interface AudioSegment { startSeconds: number; endSeconds: number; fadeInSeconds: number; fadeOutSeconds: number }
export type EditErrors = Partial<Record<Exclude<keyof AudioEdit, 'cutMode'> | 'duration', string>>;

const MIN_SEGMENT_SECONDS = 0.05;

/** Các đoạn âm thanh thực sự được phát/xuất, theo thứ tự thời gian. */
export function resolveSegments(edit: AudioEdit, duration: number): AudioSegment[] {
  const end = edit.endSeconds ?? duration;
  if (edit.cutMode !== 'remove') {
    return [{ startSeconds: edit.startSeconds, endSeconds: end, fadeInSeconds: edit.fadeInSeconds, fadeOutSeconds: edit.fadeOutSeconds }];
  }
  const ranges: Array<[number, number]> = [[0, edit.startSeconds], [end, duration]];
  const kept = ranges.filter(([s, e]) => e - s >= MIN_SEGMENT_SECONDS);
  return kept.map(([s, e], index) => ({
    startSeconds: s,
    endSeconds: e,
    fadeInSeconds: index === 0 ? edit.fadeInSeconds : 0,
    fadeOutSeconds: index === kept.length - 1 ? edit.fadeOutSeconds : 0,
  }));
}

export function segmentsLength(segments: AudioSegment[]): number {
  return segments.reduce((sum, seg) => sum + Math.max(0, seg.endSeconds - seg.startSeconds), 0);
}

export function gainAtSegments(position: number, segments: AudioSegment[]): number {
  const seg = segments.find(s => position >= s.startSeconds && position < s.endSeconds);
  return seg ? gainAtPosition(position, seg) : 0;
}

export function getEditErrors(edit: AudioEdit, duration: number | null): EditErrors {
  if (edit.cutMode === 'remove') return getRemoveEditErrors(edit, duration);
  const errors: EditErrors = {};
  if (duration === null || !Number.isFinite(duration) || duration <= 0) errors.duration = 'Cần chuẩn bị âm thanh để biết thời lượng thật.';
  if (!Number.isFinite(edit.startSeconds) || edit.startSeconds < 0) errors.startSeconds = 'Bắt đầu phải là số giây không âm.';
  if (edit.endSeconds === null || !Number.isFinite(edit.endSeconds) || edit.endSeconds <= edit.startSeconds) errors.endSeconds = 'Kết thúc phải sau bắt đầu.';
  else if (duration !== null && edit.endSeconds > duration) errors.endSeconds = 'Đoạn vượt thời lượng nguồn. Hãy sửa điểm kết thúc.';
  if (!Number.isFinite(edit.fadeInSeconds) || edit.fadeInSeconds < 0) errors.fadeInSeconds = 'Fade-in phải là số giây không âm.';
  if (!Number.isFinite(edit.fadeOutSeconds) || edit.fadeOutSeconds < 0) errors.fadeOutSeconds = 'Fade-out phải là số giây không âm.';
  if (edit.endSeconds !== null && edit.fadeInSeconds + edit.fadeOutSeconds > edit.endSeconds - edit.startSeconds) errors.fadeOutSeconds = 'Tổng fade-in và fade-out không được vượt độ dài đoạn.';
  return errors;
}
function getRemoveEditErrors(edit: AudioEdit, duration: number | null): EditErrors {
  const errors = getEditErrors({ ...edit, cutMode: 'keep', fadeInSeconds: 0, fadeOutSeconds: 0 }, duration);
  if (!Number.isFinite(edit.fadeInSeconds) || edit.fadeInSeconds < 0) errors.fadeInSeconds = 'Fade-in phải là số giây không âm.';
  if (!Number.isFinite(edit.fadeOutSeconds) || edit.fadeOutSeconds < 0) errors.fadeOutSeconds = 'Fade-out phải là số giây không âm.';
  if (Object.keys(errors).length || duration === null) return errors;
  const segments = resolveSegments(edit, duration);
  if (!segments.length) {
    errors.endSeconds = 'Không thể bỏ toàn bộ bài. Hãy thu hẹp đoạn cần bỏ.';
  } else if (segments.some(seg => seg.fadeInSeconds + seg.fadeOutSeconds > seg.endSeconds - seg.startSeconds)) {
    errors.fadeOutSeconds = 'Fade-in/fade-out vượt độ dài phần nhạc còn lại.';
  }
  return errors;
}
export function gainAtPosition(position: number, edit: AudioEdit): number {
  if (edit.endSeconds === null || position < edit.startSeconds || position >= edit.endSeconds) return 0;
  if (edit.fadeInSeconds > 0 && position < edit.startSeconds + edit.fadeInSeconds) return (position - edit.startSeconds) / edit.fadeInSeconds;
  if (edit.fadeOutSeconds > 0 && position > edit.endSeconds - edit.fadeOutSeconds) return (edit.endSeconds - position) / edit.fadeOutSeconds;
  return 1;
}
export function formatTimestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  const mins = Math.floor(safe / 60), rem = (safe - mins * 60).toFixed(1);
  return `${String(mins).padStart(2, '0')}:${rem.padStart(4, '0')}`;
}
export function parseTimestamp(raw: string): number | null {
  const clean = raw.trim();
  if (!clean) return null;
  const mmss = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(clean);
  if (mmss) {
    const mins = Number(mmss[1]), secs = Number(mmss[2]);
    return secs < 60 ? Number((mins * 60 + secs).toFixed(1)) : null;
  }
  const num = Number(clean);
  return Number.isFinite(num) && num >= 0 ? Number(num.toFixed(1)) : null;
}
