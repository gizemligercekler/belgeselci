import { TranscriptSegment, UploadedImage } from '../types/editor';

const NATURAL_COLLATOR = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });

/**
 * Extracts leading order number and clean descriptive title from filenames such as:
 *   "1. giris.png" -> orderNumber: 1, cleanTitle: "giris"
 *   "52. sana yazmalari.png" -> orderNumber: 52, cleanTitle: "sana yazmalari"
 *   "003_birmingham-yazmalari.jpg" -> orderNumber: 3, cleanTitle: "birmingham yazmalari"
 */
export function parseImageFilename(filename: string): {
  orderNumber: number;
  hasExplicitNumber: boolean;
  cleanTitle: string;
} {
  const withoutExt = filename.replace(/\.[^.]+$/, '').trim();
  const leadingMatch = withoutExt.match(/^(\d+)\s*[.\-_)\]:\s]*(.*)$/);

  let orderNumber = Number.MAX_SAFE_INTEGER;
  let hasExplicitNumber = false;
  let titleRaw = withoutExt;

  if (leadingMatch) {
    orderNumber = parseInt(leadingMatch[1], 10);
    hasExplicitNumber = true;
    titleRaw = leadingMatch[2] || withoutExt;
  } else {
    const anyNum = withoutExt.match(/(\d+)/);
    if (anyNum) {
      orderNumber = parseInt(anyNum[1], 10);
      hasExplicitNumber = true;
    }
  }

  const cleanTitle =
    titleRaw
      .replace(/[_-]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim() || withoutExt;

  return { orderNumber, hasExplicitNumber, cleanTitle };
}

/**
 * Strictly sorts uploaded image files numerically (1, 2, ... 10, ... 52, 53), NEVER alphabetically.
 */
export function sortAndParseImages(files: File[]): UploadedImage[] {
  const imageFiles = files.filter(
    (f) =>
      f.type.startsWith('image/') ||
      /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(f.name)
  );

  const parsed = imageFiles.map((file) => {
    const meta = parseImageFilename(file.name);
    return { file, meta };
  });

  parsed.sort((a, b) => {
    if (a.meta.hasExplicitNumber && b.meta.hasExplicitNumber) {
      if (a.meta.orderNumber !== b.meta.orderNumber) {
        return a.meta.orderNumber - b.meta.orderNumber;
      }
    } else if (a.meta.hasExplicitNumber) {
      return -1;
    } else if (b.meta.hasExplicitNumber) {
      return 1;
    }
    return NATURAL_COLLATOR.compare(a.file.name, b.file.name);
  });

  return parsed.map((item, idx) => ({
    id: `img_${idx + 1}_${item.file.name}_${item.file.size}`,
    orderNumber: item.meta.hasExplicitNumber ? item.meta.orderNumber : idx + 1,
    filename: item.file.name,
    cleanTitle: item.meta.cleanTitle,
    objectUrl: URL.createObjectURL(item.file),
    file: item.file,
  }));
}

/**
 * Reads exact audio duration in browser without modifying, normalizing, or re-encoding the file.
 */
export function readAudioDuration(file: File): Promise<{ durationSec: number; objectUrl: string }> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';

    const cleanup = () => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
    };

    audio.onloadedmetadata = () => {
      cleanup();
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Ses dosyasının süresi okunamadı. Geçerli bir MP3, WAV veya M4A dosyası seçin.'));
        return;
      }
      resolve({
        durationSec: Number(audio.duration.toFixed(2)),
        objectUrl,
      });
    };

    audio.onerror = () => {
      cleanup();
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Ses dosyası tarayıcı tarafından okunamadı.'));
    };

    audio.src = objectUrl;
  });
}

export interface SlicedAudioChunk {
  chunkIndex: number; // 1-based
  totalChunks: number;
  offsetSec: number;
  durationSec: number;
  wavBase64: string;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE)));
  }
  return btoa(parts.join(''));
}

function encodeMono16kWavBase64(samplesFloat: Float32Array, sampleRate = 16000): string {
  const numSamples = samplesFloat.length;
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samplesFloat[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return uint8ToBase64(new Uint8Array(buffer));
}

/**
 * Decodes the documentary audio via Web Audio API and slices it into lightweight
 * 5-minute (300s) 16kHz mono 16-bit WAV chunks for drift-free cloud & local transcription.
 * Never alters the user's original audio file.
 */
export async function sliceAudioInto5MinWavChunks(
  file: File,
  chunkSeconds = 300,
  onDecodeProgress?: (message: string) => void
): Promise<SlicedAudioChunk[]> {
  onDecodeProgress?.('Ses dosyası belleğe çözülüyor...');
  const arrayBuffer = await file.arrayBuffer();

  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioCtx();

  let decoded: AudioBuffer;
  try {
    decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await audioCtx.close().catch(() => undefined);
  }

  const srcRate = decoded.sampleRate;
  const totalDuration = decoded.duration;
  const numChannels = decoded.numberOfChannels;
  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channelData.push(decoded.getChannelData(ch));
  }

  const targetRate = 16000;
  const totalChunks = Math.max(1, Math.ceil(totalDuration / chunkSeconds));
  const chunks: SlicedAudioChunk[] = [];

  for (let idx = 0; idx < totalChunks; idx++) {
    const offsetSec = idx * chunkSeconds;
    const endSec = Math.min(totalDuration, offsetSec + chunkSeconds);
    const durationSec = Math.max(0.1, endSec - offsetSec);

    onDecodeProgress?.(
      `5 dakikalık hafif WAV parçaları hazırlanıyor (${idx + 1}/${totalChunks})...`
    );

    const startSample = Math.floor(offsetSec * srcRate);
    const endSample = Math.min(decoded.length, Math.floor(endSec * srcRate));
    const srcLen = Math.max(1, endSample - startSample);
    const outLen = Math.max(1, Math.floor((srcLen / srcRate) * targetRate));
    const outSamples = new Float32Array(outLen);
    const ratio = srcRate / targetRate;

    for (let i = 0; i < outLen; i++) {
      const srcPos = startSample + i * ratio;
      const i0 = Math.min(decoded.length - 1, Math.floor(srcPos));
      const i1 = Math.min(decoded.length - 1, i0 + 1);
      const frac = srcPos - i0;

      let mixed = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const buf = channelData[ch];
        mixed += buf[i0] * (1 - frac) + buf[i1] * frac;
      }
      outSamples[i] = mixed / numChannels;
    }

    chunks.push({
      chunkIndex: idx + 1,
      totalChunks,
      offsetSec: Number(offsetSec.toFixed(2)),
      durationSec: Number(durationSec.toFixed(2)),
      wavBase64: encodeMono16kWavBase64(outSamples, targetRate),
    });
  }

  return chunks;
}

function srtTimestampToSec(ts: string): number {
  const m = ts.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return 0;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, '0'), 10);
  return Number((h * 3600 + min * 60 + sec + ms / 1000).toFixed(2));
}

export function parseSrtToSegments(srtContent: string): TranscriptSegment[] {
  const normalized = srtContent.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];

  const blocks = normalized.split(/\n{2,}/);
  const segments: TranscriptSegment[] = [];

  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) continue;

    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx < 0) continue;

    const [startRaw, endRaw] = lines[timeLineIdx].split('-->').map((s) => s.trim());
    const startSec = srtTimestampToSec(startRaw);
    const endSec = Math.max(startSec + 0.1, srtTimestampToSec(endRaw));
    const text = lines
      .slice(timeLineIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();

    if (text) {
      segments.push({ startSec, endSec, text });
    }
  }

  return segments.sort((a, b) => a.startSec - b.startSec);
}

function secToSrtTimestamp(sec: number): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(
    Math.min(999, ms)
  ).padStart(3, '0')}`;
}

export function segmentsToSrt(segments: TranscriptSegment[]): string {
  return segments
    .map(
      (seg, idx) =>
        `${idx + 1}\n${secToSrtTimestamp(seg.startSec)} --> ${secToSrtTimestamp(seg.endSec)}\n${seg.text}`
    )
    .join('\n\n');
}
