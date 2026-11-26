import {
  GeneratedScenePlanItem,
  TimingPlanEntry,
  TranscriptSegment,
  UploadedImage,
} from '../types/editor';

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
  const leadingMatch = withoutExt.match(/^[#(\[\s]*(\d+)\s*[.\-_)\]:\s]*(.*)$/);

  let orderNumber = Number.MAX_SAFE_INTEGER;
  let hasExplicitNumber = false;
  let titleRaw = withoutExt;

  if (leadingMatch) {
    orderNumber = parseInt(leadingMatch[1], 10);
    hasExplicitNumber = true;
    titleRaw = leadingMatch[2] || withoutExt;
  } else {
    const labeledNum = withoutExt.match(
      /(?:sahne|resim|g[öo]rsel|foto|kare|scene|image|img|slide|no|#)\s*[:._\-\s]*(\d+)/i
    );
    if (labeledNum) {
      orderNumber = parseInt(labeledNum[1], 10);
      hasExplicitNumber = true;
    } else {
      const allNums = Array.from(withoutExt.matchAll(/\d+/g)).map((m) => parseInt(m[0], 10));
      const nonYear = allNums.find((n) => n < 1800 || n > 2100);
      const chosen = nonYear ?? allNums[0];
      if (chosen !== undefined) {
        orderNumber = chosen;
        hasExplicitNumber = true;
      }
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

    const fallbackDecodeDuration = async () => {
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioCtx();
        try {
          const buf = await file.arrayBuffer();
          const decoded = await ctx.decodeAudioData(buf.slice(0));
          if (Number.isFinite(decoded.duration) && decoded.duration > 0) {
            resolve({
              durationSec: Number(decoded.duration.toFixed(2)),
              objectUrl,
            });
            return;
          }
        } finally {
          await ctx.close().catch(() => undefined);
        }
      } catch {
        // fall through to reject
      }
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Ses dosyasının süresi okunamadı. Geçerli bir MP3, WAV veya M4A dosyası seçin.'));
    };

    const cleanup = () => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
    };

    audio.onloadedmetadata = () => {
      cleanup();
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
        void fallbackDecodeDuration();
        return;
      }
      resolve({
        durationSec: Number(audio.duration.toFixed(2)),
        objectUrl,
      });
    };

    audio.onerror = () => {
      cleanup();
      void fallbackDecodeDuration();
    };

    audio.src = objectUrl;
  });
}

export interface SlicedAudioChunk {
  chunkIndex: number; // 1-based
  totalChunks: number;
  offsetSec: number;
  durationSec: number;
  wavBytes: Uint8Array;
}

function encodeMonoWavBytes(samplesFloat: Float32Array, sampleRate = 16000): Uint8Array {
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

  return new Uint8Array(buffer);
}

/**
 * Decodes the documentary audio via Web Audio API and slices it into
 * 5-minute (300s) 16kHz mono 16-bit binary WAV chunks (~9.6 MB each) for fast,
 * drift-free speech transcription. Never alters the user's original audio file.
 */
export async function sliceAudioIntoWavChunks(
  file: File,
  chunkSeconds = 300,
  onDecodeProgress?: (message: string) => void
): Promise<SlicedAudioChunk[]> {
  const yieldTick = () => new Promise<void>((r) => window.setTimeout(r, 0));

  onDecodeProgress?.('Ses dosyası belleğe çözülüyor...');
  await yieldTick();
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

  // 16kHz mono 16-bit PCM = ~9.6 MB per 5-minute chunk (ideal speech clarity for Deepgram)
  const targetRate = 16000;
  const totalChunks = Math.max(1, Math.ceil(totalDuration / chunkSeconds));
  const chunks: SlicedAudioChunk[] = [];

  for (let idx = 0; idx < totalChunks; idx++) {
    const offsetSec = idx * chunkSeconds;
    const endSec = Math.min(totalDuration, offsetSec + chunkSeconds);
    const durationSec = Math.max(0.1, endSec - offsetSec);

    onDecodeProgress?.(
      `5 dakikalık 16kHz WAV parçaları hazırlanıyor (${idx + 1}/${totalChunks})...`
    );
    await yieldTick();

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
      wavBytes: encodeMonoWavBytes(outSamples, targetRate),
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

function parseClockTimestampToSec(raw: string): number | null {
  const cleaned = raw.trim().replace(',', '.');
  const parts = cleaned.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 3) {
    return Number((parts[0] * 3600 + parts[1] * 60 + parts[2]).toFixed(2));
  }
  if (parts.length === 2) {
    return Number((parts[0] * 60 + parts[1]).toFixed(2));
  }
  return null;
}

function parseExplicitDurationSec(line: string): number | null {
  // Supports e.g. "(17 saniye)", "25 sn", "1 dk 20 sn", "1 dakika 15 saniye"
  const minSecMatch = line.match(
    /(\d+(?:[.,]\d+)?)\s*(?:dakika|dk\.?)\s*(\d+(?:[.,]\d+)?)?\s*(?:saniye|sn\.?)?/i
  );
  if (minSecMatch) {
    const mins = Number(minSecMatch[1].replace(',', '.'));
    const secs = minSecMatch[2] ? Number(minSecMatch[2].replace(',', '.')) : 0;
    if (Number.isFinite(mins) && Number.isFinite(secs)) {
      const total = mins * 60 + secs;
      if (total > 0) return Number(total.toFixed(2));
    }
  }

  const secMatch = line.match(/(?:^|[\s(:=\-])(\d+(?:[.,]\d+)?)\s*(?:saniye|sn\.?|sec(?:onds?)?)\b/i);
  if (secMatch) {
    const secs = Number(secMatch[1].replace(',', '.'));
    if (Number.isFinite(secs) && secs > 0) return Number(secs.toFixed(2));
  }
  return null;
}

const TIME_RANGE_RE =
  /(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*(?:-->|->|[-–—])\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)/;
const CLOCK_START_RE = /^\d{1,2}:\d{2}/;
const TIMING_LABEL_RE = /^(?:zaman|süre|sure|aralık|aralik|time|duration)\s*:/i;
const IGNORED_META_LINE_RE =
  /^(?:prompt|g[öo]rsel\s*promptu?|image\s*prompt|d[öo]nem|era|stil|style|not|note|a[çc][ıi]klama)\s*:/i;
const NUMBERED_HEADING_RE =
  /^(?:(?:sahne|görsel|gorsel|resim|klip|kare)\s*#?\s*)?(\d+)\s*[.):\-]\s*(.+)$/i;

/**
 * Parses a Turkish scene timing plan .txt file such as:
 *   1. Ypsilanti Akıl Hastanesi Koğuşu (1959)
 *   Zaman: 00:00:00 - 00:00:17 (17 saniye)
 *   Dönem: 1959, Michigan ABD
 *   Prompt: ...
 *
 * Also handles single-line entries, MM:SS or HH:MM:SS ranges, markdown bold (**1. ...**),
 * and duration-only lines ("Süre: 17 saniye").
 */
export function parseTimingPlanTxt(txtContent: string): TimingPlanEntry[] {
  const normalized = txtContent.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rawLines = normalized
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/^#+\s*/, '')
        .replace(/^\*{1,2}(.+?)\*{1,2}$/, '$1')
        .replace(/^[-•*]\s+/, '')
        .trim()
    )
    .filter(Boolean);

  const entries: TimingPlanEntry[] = [];
  let pending: { orderNumber: number; title: string } | null = null;
  let runningCursor = 0;

  const pushTiming = (
    orderNumber: number,
    title: string,
    startSec: number,
    endSec: number,
    explicitDur: number | null
  ) => {
    const safeStart = Math.max(0, Number(startSec.toFixed(2)));
    let safeEnd = Number(endSec.toFixed(2));
    if (safeEnd <= safeStart && explicitDur && explicitDur > 0) {
      safeEnd = Number((safeStart + explicitDur).toFixed(2));
    }
    const durationSec = Number(Math.max(0.5, safeEnd - safeStart).toFixed(2));
    safeEnd = Number((safeStart + durationSec).toFixed(2));

    entries.push({
      orderNumber,
      title: title.trim() || `Sahne ${orderNumber}`,
      startSec: safeStart,
      endSec: safeEnd,
      durationSec,
    });
    runningCursor = Math.max(runningCursor, safeEnd);
  };

  for (const line of rawLines) {
    if (IGNORED_META_LINE_RE.test(line)) {
      continue;
    }

    const rangeMatch = line.match(TIME_RANGE_RE);
    const explicitDur = parseExplicitDurationSec(line);
    const isTimingLabelLine = TIMING_LABEL_RE.test(line);
    const startsWithClock = CLOCK_START_RE.test(line);

    // Check if this line is a numbered scene header (not a clock timestamp or "Zaman: ...")
    const headingMatch =
      !isTimingLabelLine && !startsWithClock ? line.match(NUMBERED_HEADING_RE) : null;

    if (headingMatch) {
      const orderNumber = parseInt(headingMatch[1], 10);
      const rawTitle = headingMatch[2].trim();

      if (rangeMatch) {
        // Single-line entry: "1. Başlık - 00:00:00 - 00:00:17 (17 saniye)"
        const start = parseClockTimestampToSec(rangeMatch[1]);
        const end = parseClockTimestampToSec(rangeMatch[2]);
        const cleanTitle = rawTitle
          .replace(TIME_RANGE_RE, '')
          .replace(/\(?\s*\d+(?:[.,]\d+)?\s*(?:saniye|sn\.?|dakika|dk\.?)\s*\)?/gi, '')
          .replace(/[\s\-–—|:]+$/, '')
          .trim();

        if (start !== null && end !== null) {
          pushTiming(orderNumber, cleanTitle || rawTitle, start, end, explicitDur);
          pending = null;
          continue;
        }
      }

      if (explicitDur !== null && /saniye|sn\.?|dakika|dk\.?/i.test(rawTitle)) {
        // Single-line duration-only entry: "1. Başlık (17 saniye)"
        const cleanTitle = rawTitle
          .replace(/\(?\s*\d+(?:[.,]\d+)?\s*(?:dakika|dk\.?)\s*\d*\s*(?:saniye|sn\.?)?\s*\)?/gi, '')
          .replace(/\(?\s*\d+(?:[.,]\d+)?\s*(?:saniye|sn\.?)\s*\)?/gi, '')
          .replace(/[\s\-–—|:]+$/, '')
          .trim();
        pushTiming(
          orderNumber,
          cleanTitle || rawTitle,
          runningCursor,
          runningCursor + explicitDur,
          explicitDur
        );
        pending = null;
        continue;
      }

      pending = { orderNumber, title: rawTitle };
      continue;
    }

    if (rangeMatch) {
      const start = parseClockTimestampToSec(rangeMatch[1]);
      const end = parseClockTimestampToSec(rangeMatch[2]);
      if (start !== null && end !== null) {
        const orderNumber = pending ? pending.orderNumber : entries.length + 1;
        const title = pending
          ? pending.title
          : line
              .replace(TIMING_LABEL_RE, '')
              .replace(TIME_RANGE_RE, '')
              .replace(/\(?\s*\d+(?:[.,]\d+)?\s*(?:saniye|sn\.?)\s*\)?/gi, '')
              .trim();
        pushTiming(orderNumber, title, start, end, explicitDur);
        pending = null;
        continue;
      }
    }

    if ((isTimingLabelLine || pending) && explicitDur !== null) {
      const orderNumber = pending ? pending.orderNumber : entries.length + 1;
      const title = pending ? pending.title : `Sahne ${orderNumber}`;
      pushTiming(orderNumber, title, runningCursor, runningCursor + explicitDur, explicitDur);
      pending = null;
    }
  }

  return entries.sort((a, b) => a.orderNumber - b.orderNumber || a.startSec - b.startSec);
}

export function formatHHMMSS(sec: number): string {
  const clamped = Math.max(0, Math.round(sec));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Formats generated Hydrogen scenes into a single unified .txt file containing
 * exact scene timestamps (100% compatible with Step 1 .TXT upload) + 16:9 2K image prompts.
 */
export function scenePlanToUnifiedTxt(items: GeneratedScenePlanItem[]): string {
  return items
    .map((item) => {
      const durRounded = Math.max(1, Math.round(item.durationSec));
      const lines = [
        `${item.orderNumber}. ${item.title}`,
        `Zaman: ${formatHHMMSS(item.startSec)} - ${formatHHMMSS(item.endSec)} (${durRounded} saniye)`,
      ];
      if (item.era?.trim()) {
        lines.push(`Dönem: ${item.era.trim()}`);
      }
      lines.push(`Prompt: ${item.imagePrompt.trim()}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * Formats only numbered image prompts for batch image generation tools.
 */
export function scenePlanToPromptsOnlyTxt(items: GeneratedScenePlanItem[]): string {
  return items
    .map((item) => `${item.orderNumber}. ${item.imagePrompt.trim()}`)
    .join('\n\n');
}
