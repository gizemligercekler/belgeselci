import {
  EditorSettings,
  TimelineScene,
  TranscriptSegment,
  UploadedImage,
} from '../types/editor';
import { sliceAudioInto5MinWavChunks } from '../utils/mediaUtils';
import { buildValidatedTimeline, round2 } from '../utils/timelineMath';

export interface ServerHealth {
  ok: boolean;
  hasServerGeminiKey: boolean;
}

export interface TranscribeProgress {
  phase: 'decoding' | 'transcribing' | 'aligning';
  currentChunk: number;
  totalChunks: number;
  message: string;
}

export interface ApiCallOptions {
  signal?: AbortSignal;
  onRetryWait?: (secondsLeft: number | null) => void;
}

const INTER_CHUNK_DELAY_MS = 2000;
const RETRY_DELAYS_SEC = [15, 25, 35];

export async function fetchServerHealth(): Promise<ServerHealth> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return { ok: false, hasServerGeminiKey: false };
    return (await res.json()) as ServerHealth;
  } catch {
    return { ok: false, hasServerGeminiKey: false };
  }
}

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('İşlem iptal edildi.', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('İşlem iptal edildi.', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function countdownRetryWait(
  totalSeconds: number,
  options?: ApiCallOptions
): Promise<void> {
  for (let remaining = totalSeconds; remaining > 0; remaining--) {
    options?.onRetryWait?.(remaining);
    await sleepWithAbort(1000, options?.signal);
  }
  options?.onRetryWait?.(null);
}

async function postJsonWith429Retry<T>(
  url: string,
  payload: unknown,
  settings: EditorSettings,
  options?: ApiCallOptions
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (settings.customApiKey.trim()) {
    headers['x-gemini-api-key'] = settings.customApiKey.trim();
  }

  let attempt = 0;
  while (true) {
    if (options?.signal?.aborted) {
      throw new DOMException('İşlem kullanıcı tarafından iptal edildi.', 'AbortError');
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: options?.signal,
    });

    if (res.ok) {
      options?.onRetryWait?.(null);
      return (await res.json()) as T;
    }

    let errMsg = `Sunucu hatası (${res.status})`;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody?.error) errMsg = errBody.error;
    } catch {
      // keep fallback message
    }

    if (res.status === 429 && attempt < RETRY_DELAYS_SEC.length) {
      const waitSec = RETRY_DELAYS_SEC[attempt];
      attempt += 1;
      await countdownRetryWait(waitSec, options);
      continue;
    }

    options?.onRetryWait?.(null);
    throw new Error(errMsg);
  }
}

/**
 * Slices the user's audio in browser into lightweight 5-minute (300s) 16kHz mono WAV chunks,
 * sends each chunk sequentially with a 2-second inter-chunk delay and automatic 429 countdown retry,
 * and applies exact +chunk.offsetSec to every timestamp for drift-free accuracy.
 */
export async function transcribeAudioInChunks(
  audioFile: File,
  settings: EditorSettings,
  callbacks: {
    signal?: AbortSignal;
    onProgress?: (progress: TranscribeProgress) => void;
    onRetryWait?: (secondsLeft: number | null) => void;
  }
): Promise<TranscriptSegment[]> {
  const chunks = await sliceAudioInto5MinWavChunks(audioFile, 300, (msg) => {
    callbacks.onProgress?.({
      phase: 'decoding',
      currentChunk: 0,
      totalChunks: 0,
      message: msg,
    });
  });

  const allSegments: TranscriptSegment[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (callbacks.signal?.aborted) {
      throw new DOMException('Transkript işlemi iptal edildi.', 'AbortError');
    }

    callbacks.onProgress?.({
      phase: 'transcribing',
      currentChunk: chunk.chunkIndex,
      totalChunks: chunk.totalChunks,
      message: `Parça ${chunk.chunkIndex}/${chunk.totalChunks} transkript çıkarılıyor...`,
    });

    const data = await postJsonWith429Retry<{ segments: TranscriptSegment[] }>(
      '/api/transcribe-chunk',
      {
        audioBase64: chunk.wavBase64,
        mimeType: 'audio/wav',
        chunkDurationSec: chunk.durationSec,
        model: settings.model.trim() || 'gemini-3.8-flash',
      },
      settings,
      {
        signal: callbacks.signal,
        onRetryWait: callbacks.onRetryWait,
      }
    );

    const chunkSegments = Array.isArray(data.segments) ? data.segments : [];
    for (const seg of chunkSegments) {
      const startSec = round2(chunk.offsetSec + Math.max(0, Number(seg.startSec) || 0));
      const endSec = round2(
        chunk.offsetSec + Math.max(Number(seg.startSec) + 0.2, Number(seg.endSec) || 0)
      );
      const text = String(seg.text || '').trim();
      if (text) {
        allSegments.push({ startSec, endSec, text });
      }
    }

    // Wait 2 seconds between consecutive chunks to stay comfortably within Free Tier RPM limits
    if (i < chunks.length - 1) {
      await sleepWithAbort(INTER_CHUNK_DELAY_MS, callbacks.signal);
    }
  }

  return allSegments.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Aligns sequentially numbered images against the full timestamped Turkish transcript.
 * Strictly preserves image numeric order and enforces zero gaps / zero overlaps.
 */
export async function alignImagesWithTranscript(
  transcriptSegments: TranscriptSegment[],
  images: UploadedImage[],
  totalAudioDuration: number,
  zoomSpeedPerSec: number,
  settings: EditorSettings,
  callbacks?: ApiCallOptions
): Promise<TimelineScene[]> {
  const payload = {
    transcriptSegments,
    images: images.map((img) => ({
      orderNumber: img.orderNumber,
      filename: img.filename,
      cleanTitle: img.cleanTitle,
    })),
    totalAudioDuration,
    model: settings.model.trim() || 'gemini-3.8-flash',
  };

  const data = await postJsonWith429Retry<{
    alignments: Array<{ index?: number; startSec?: number; matchedExcerpt?: string }>;
  }>('/api/align-images', payload, settings, callbacks);

  return buildValidatedTimeline(
    images,
    Array.isArray(data.alignments) ? data.alignments : [],
    totalAudioDuration,
    zoomSpeedPerSec,
    transcriptSegments
  );
}
