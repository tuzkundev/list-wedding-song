import type { Asset, ExportRequest } from '@wedding/shared/api';
import { formatSectionFolder, formatTrackEntry } from '@wedding/shared/filenames';

export async function analyzeAudioBufferInBrowser(arrayBuffer: ArrayBuffer): Promise<{ durationSeconds: number; peaks: [number, number][] }> {
  const ctx = new AudioContext();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const durationSeconds = Number(audioBuffer.duration.toFixed(4));
    const channel = audioBuffer.getChannelData(0);
    const sampleCount = channel.length;
    const bins = Math.min(1000, Math.max(1, sampleCount));
    const peaks: [number, number][] = [];
    for (let index = 0; index < bins; ++index) {
      const start = Math.floor((index * sampleCount) / bins);
      const end = Math.max(start + 1, Math.floor(((index + 1) * sampleCount) / bins));
      let low = 1;
      let high = -1;
      for (let cursor = start; cursor < end; ++cursor) {
        const sample = Math.max(-1, Math.min(1, channel[cursor]));
        if (sample < low) low = sample;
        if (sample > high) high = sample;
      }
      peaks.push([Number(low.toFixed(4)), Number(high.toFixed(4))]);
    }
    return { durationSeconds, peaks };
  } finally {
    void ctx.close();
  }
}

function encodeWavFromAudioBuffer(buffer: AudioBuffer): Uint8Array {
  const numChannels = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; ++i) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = Array.from({ length: numChannels }, (_, ch) => buffer.getChannelData(ch));
  let offset = 44;
  for (let i = 0; i < numFrames; ++i) {
    for (let ch = 0; ch < numChannels; ++ch) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(out);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; ++i) {
    let c = i;
    for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; ++i) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipArchive(entries: Array<{ name: string; data: Uint8Array }>): Blob {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, entry.name.endsWith('/') ? 0x10 : 0, true);
    cv.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const allParts: BlobPart[] = [...localParts, ...centralParts, eocd].map(p => new Uint8Array(p));
  return new Blob(allParts, { type: 'application/zip' });
}

export async function renderExportZipInBrowser(
  request: ExportRequest,
  audioUrls: Record<string, string>,
  onTrack: (completed: number, total: number) => void,
): Promise<string> {
  const totalTracks = request.sections.reduce((sum, s) => sum + s.tracks.length, 0);
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  let completed = 0;

  for (let sIndex = 0; sIndex < request.sections.length; ++sIndex) {
    const section = request.sections[sIndex];
    const folder = formatSectionFolder(sIndex, request.sections.length, section.title);
    if (!section.tracks.length) {
      entries.push({ name: folder, data: new Uint8Array(0) });
      continue;
    }
    for (let tIndex = 0; tIndex < section.tracks.length; ++tIndex) {
      const track = section.tracks[tIndex];
      const url = audioUrls[track.assetId];
      if (!url) throw new Error(`Chưa có dữ liệu âm thanh cho bài "${track.title}".`);
      const rawBuffer = await (await fetch(url)).arrayBuffer();
      const decodeCtx = new AudioContext();
      let decoded: AudioBuffer;
      try {
        decoded = await decodeCtx.decodeAudioData(rawBuffer.slice(0));
      } finally {
        void decodeCtx.close();
      }
      const duration = Math.max(0.1, track.endSeconds - track.startSeconds);
      const sampleRate = decoded.sampleRate;
      const offline = new OfflineAudioContext(Math.min(2, decoded.numberOfChannels), Math.ceil(duration * sampleRate), sampleRate);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      const gain = offline.createGain();
      if (track.fadeInSeconds > 0) {
        gain.gain.setValueAtTime(0, 0);
        gain.gain.linearRampToValueAtTime(1, track.fadeInSeconds);
      } else {
        gain.gain.setValueAtTime(1, 0);
      }
      if (track.fadeOutSeconds > 0) {
        gain.gain.setValueAtTime(1, Math.max(0, duration - track.fadeOutSeconds));
        gain.gain.linearRampToValueAtTime(0, duration);
      }
      source.connect(gain).connect(offline.destination);
      source.start(0, track.startSeconds, duration);
      const rendered = await offline.startRendering();
      const wavBytes = encodeWavFromAudioBuffer(rendered);
      const entryName = formatTrackEntry(folder, tIndex, section.tracks.length, track.title).replace(/\.mp3$/i, '.wav');
      entries.push({ name: entryName, data: wavBytes });
      onTrack(++completed, totalTracks);
    }
  }

  return URL.createObjectURL(buildZipArchive(entries));
}

export type { Asset };
