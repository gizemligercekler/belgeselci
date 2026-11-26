import {
  EditorSettings,
  GeneratedScenePlanItem,
  TimelineScene,
  TimingPlanEntry,
  TranscriptSegment,
  UploadedImage,
} from '../types/editor';
import { sliceAudioIntoWavChunks } from '../utils/mediaUtils';
import { buildValidatedTimeline, round2 } from '../utils/timelineMath';

export interface ServerHealth {
  ok: boolean;
  hasServerGeminiKey: boolean;
  hasDeepgramKey: boolean;
}

export interface TranscribeProgress {
  phase: 'decoding' | 'transcribing' | 'aligning';
  currentChunk: number;
  totalChunks: number;
  message: string;
}

export interface RetryNotice {
  secondsLeft: number;
  reason: string;
}

export interface ApiCallOptions {
  signal?: AbortSignal;
  onRetryWait?: (notice: RetryNotice | null) => void;
}

const DEEPGRAM_INTER_CHUNK_DELAY_MS = 1000;
const DEEPGRAM_FALLBACK_RETRY_DELAYS_SEC = [10, 15, 25, 30, 45];
const GEMINI_ALIGN_RETRY_DELAYS_SEC = [8, 18, 30];

// In-memory resume cache keyed by file signature + deepgramModel
// so completed chunks are NEVER wasted if a later chunk pauses or is retried.
const completedChunksCache = new Map<string, Map<number, TranscriptSegment[]>>();

export function clearTranscriptionCache(): void {
  completedChunksCache.clear();
}

export async function fetchServerHealth(): Promise<ServerHealth> {
  try {
    const res = await fetch('/api/health', { credentials: 'same-origin' });
    if (!res.ok) return { ok: false, hasServerGeminiKey: false, hasDeepgramKey: false };
    const text = await res.text();
    const parsed = JSON.parse(text) as Partial<ServerHealth>;
    return {
      ok: Boolean(parsed.ok),
      hasServerGeminiKey: Boolean(parsed.hasServerGeminiKey),
      hasDeepgramKey: Boolean(parsed.hasDeepgramKey),
    };
  } catch {
    return { ok: false, hasServerGeminiKey: false, hasDeepgramKey: false };
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
  reason: string,
  options?: ApiCallOptions
): Promise<void> {
  const secs = Math.max(1, Math.ceil(totalSeconds));
  for (let remaining = secs; remaining > 0; remaining--) {
    options?.onRetryWait?.({ secondsLeft: remaining, reason });
    await sleepWithAbort(1000, options?.signal);
  }
  options?.onRetryWait?.(null);
}

interface SingleAttemptResult<T> {
  ok: true;
  data: T;
}

interface SingleAttemptFail {
  ok: false;
  retryable: boolean;
  isQuotaOrBusy: boolean;
  retryAfterSec?: number;
  reason: string;
  errorMessage: string;
}

async function runSingleFetch<T>(
  url: string,
  init: RequestInit,
  label: string,
  signal?: AbortSignal
): Promise<SingleAttemptResult<T> | SingleAttemptFail> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      credentials: 'same-origin',
      signal,
    });
  } catch (netErr) {
    if ((netErr as { name?: string })?.name === 'AbortError' || signal?.aborted) {
      throw new DOMException('İşlem kullanıcı tarafından iptal edildi.', 'AbortError');
    }
    return {
      ok: false,
      retryable: true,
      isQuotaOrBusy: false,
      reason: `Ağ bağlantısı kesildi (${label})`,
      errorMessage: `Sunucuya ulaşılamadı (Failed to fetch · ${label}). İnternet bağlantınızı kontrol edip tekrar deneyin.`,
    };
  }

  const rawText = await res.text();
  const looksLikeHtml = /^\s*<!doctype\s+html|^\s*<html/i.test(rawText);

  if (looksLikeHtml) {
    return {
      ok: false,
      retryable: true,
      isQuotaOrBusy: true,
      reason: 'Sunucu geçici olarak meşgul (HTML yanıtı)',
      errorMessage:
        'Sunucudan geçici olarak JSON yerine HTML yanıtı döndü. Birkaç saniye sonra tekrar deneyin.',
    };
  }

  let parsedBody: Record<string, unknown> | null = null;
  try {
    parsedBody = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
  } catch {
    parsedBody = null;
  }

  if (res.ok && parsedBody !== null) {
    return { ok: true, data: parsedBody as T };
  }

  const errMsg =
    (typeof parsedBody?.error === 'string' && parsedBody.error) ||
    `Sunucu hatası (${res.status})`;
  const isQuotaOrBusy =
    res.status === 429 ||
    res.status === 502 ||
    res.status === 503 ||
    res.status === 504 ||
    parsedBody?.retryable === true;

  const rawRetryAfter = Number(parsedBody?.retryAfterSec);
  const retryAfterSec =
    Number.isFinite(rawRetryAfter) && rawRetryAfter > 0
      ? Math.ceil(rawRetryAfter)
      : undefined;

  const upstream = Number(parsedBody?.upstreamStatus || res.status);
  const reason =
    upstream === 503 || upstream === 502 || upstream === 504
      ? `Sunucu geçici olarak yoğun (${upstream})`
      : 'Hız sınırına ulaşıldı (429)';

  return {
    ok: false,
    retryable: isQuotaOrBusy,
    isQuotaOrBusy,
    retryAfterSec,
    reason,
    errorMessage: errMsg,
  };
}

/**
 * Sends a Gemini alignment request with automatic Free Tier model failover
 * (gemini-4-hydrogen -> gemini-3.8-flash -> gemini-3.1-flash-lite) and countdown retries.
 */
async function sendWithModelFailover<T>(
  url: string,
  modelChain: string[],
  startModelIndex: number,
  initForModel: (model: string) => RequestInit,
  label: string,
  options?: ApiCallOptions & { onModelSwitch?: (newModel: string) => void }
): Promise<{ data: T; usedModelIndex: number }> {
  let round = 0;
  let currentIdx = startModelIndex;
  let lastError = 'İstek başarısız oldu.';

  while (true) {
    for (let offset = 0; offset < modelChain.length; offset++) {
      const idx = (currentIdx + offset) % modelChain.length;
      const model = modelChain[idx];

      if (options?.signal?.aborted) {
        throw new DOMException('İşlem kullanıcı tarafından iptal edildi.', 'AbortError');
      }

      if (offset > 0) {
        options?.onModelSwitch?.(model);
      }

      const result = await runSingleFetch<T>(url, initForModel(model), `${label} · ${model}`, options?.signal);

      if (result.ok) {
        options?.onRetryWait?.(null);
        return { data: result.data, usedModelIndex: idx };
      }

      lastError = result.errorMessage;

      if (!result.retryable) {
        options?.onRetryWait?.(null);
        throw new Error(result.errorMessage);
      }

      if (result.isQuotaOrBusy && offset < modelChain.length - 1) {
        await sleepWithAbort(1500, options?.signal);
        continue;
      }

      if (!result.isQuotaOrBusy) {
        break;
      }
    }

    if (round < GEMINI_ALIGN_RETRY_DELAYS_SEC.length) {
      const waitSec = GEMINI_ALIGN_RETRY_DELAYS_SEC[round];
      round += 1;
      await countdownRetryWait(
        waitSec,
        `Gemini eşleştirme kotası/yoğunluğu (429/503) — yeniden deneme ${round}/${GEMINI_ALIGN_RETRY_DELAYS_SEC.length}`,
        options
      );
      continue;
    }

    options?.onRetryWait?.(null);
    throw new Error(
      `${lastError} (Tüm yedek Gemini modeller de denendi. Kısa süre bekleyip tekrar deneyebilir veya Ayarlar'dan kendi Gemini API anahtarınızı girebilirsiniz.)`
    );
  }
}

/**
 * Slices the user's audio in browser into 5-minute (300s) 16kHz mono binary WAV chunks (~9.6 MB),
 * sends each chunk sequentially to Deepgram Pre-Recorded Audio API with 1s polite pacing,
 * automatic 429 retry-after countdown, and per-chunk resume cache.
 */
export async function transcribeAudioInChunks(
  audioFile: File,
  settings: EditorSettings,
  callbacks: {
    signal?: AbortSignal;
    onProgress?: (progress: TranscribeProgress) => void;
    onRetryWait?: (notice: RetryNotice | null) => void;
  }
): Promise<TranscriptSegment[]> {
  const chunks = await sliceAudioIntoWavChunks(audioFile, 300, (msg) => {
    callbacks.onProgress?.({
      phase: 'decoding',
      currentChunk: 0,
      totalChunks: 0,
      message: msg,
    });
  });

  const deepgramModel = settings.deepgramModel === 'nova-2' ? 'nova-2' : 'nova-3';

  const fileKey = `${audioFile.name}:${audioFile.size}:${audioFile.lastModified}:${deepgramModel}`;
  let fileCache = completedChunksCache.get(fileKey);
  if (!fileCache) {
    fileCache = new Map<number, TranscriptSegment[]>();
    completedChunksCache.set(fileKey, fileCache);
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (callbacks.signal?.aborted) {
      throw new DOMException('Transkript işlemi iptal edildi.', 'AbortError');
    }

    // Reuse already-completed chunks so user never wastes credit or time on retry
    if (fileCache.has(chunk.chunkIndex)) {
      callbacks.onProgress?.({
        phase: 'transcribing',
        currentChunk: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
        message: `Deepgram (${deepgramModel}) ile transkript çıkarılıyor: Parça ${chunk.chunkIndex}/${chunk.totalChunks} (önbellekten)...`,
      });
      continue;
    }

    callbacks.onProgress?.({
      phase: 'transcribing',
      currentChunk: chunk.chunkIndex,
      totalChunks: chunk.totalChunks,
      message: `Deepgram (${deepgramModel}) ile transkript çıkarılıyor: Parça ${chunk.chunkIndex}/${chunk.totalChunks}...`,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'audio/wav',
      'x-chunk-offset': String(chunk.offsetSec),
      'x-chunk-duration': String(chunk.durationSec),
      'x-deepgram-model': deepgramModel,
    };
    if (settings.deepgramApiKey.trim()) {
      headers['x-deepgram-api-key'] = settings.deepgramApiKey.trim();
    }

    let attempt = 0;
    let chunkData: { segments: TranscriptSegment[] } | null = null;

    while (true) {
      if (callbacks.signal?.aborted) {
        throw new DOMException('Transkript işlemi iptal edildi.', 'AbortError');
      }

      const wavCopy = new Uint8Array(chunk.wavBytes.byteLength);
      wavCopy.set(chunk.wavBytes);

      const result = await runSingleFetch<{ segments: TranscriptSegment[] }>(
        '/api/transcribe-chunk',
        {
          method: 'POST',
          headers,
          body: new Blob([wavCopy.buffer], { type: 'audio/wav' }),
        },
        `Parça ${chunk.chunkIndex}/${chunk.totalChunks}`,
        callbacks.signal
      );

      if (result.ok) {
        callbacks.onRetryWait?.(null);
        chunkData = result.data;
        break;
      }

      if (!result.retryable) {
        callbacks.onRetryWait?.(null);
        throw new Error(result.errorMessage);
      }

      if (attempt < DEEPGRAM_FALLBACK_RETRY_DELAYS_SEC.length) {
        const waitSec = result.retryAfterSec ?? DEEPGRAM_FALLBACK_RETRY_DELAYS_SEC[attempt];
        attempt += 1;
        await countdownRetryWait(
          waitSec,
          `Deepgram (${deepgramModel}) ${result.reason} — Parça ${chunk.chunkIndex}/${chunk.totalChunks} yeniden denenecek (${attempt}/${DEEPGRAM_FALLBACK_RETRY_DELAYS_SEC.length})`,
          {
            signal: callbacks.signal,
            onRetryWait: callbacks.onRetryWait,
          }
        );
        continue;
      }

      callbacks.onRetryWait?.(null);
      throw new Error(
        `${result.errorMessage} (Tamamlanan önceki parçalar önbellekte korundu; kısa bir süre sonra tekrar başlatırsanız Parça ${chunk.chunkIndex}/${chunk.totalChunks}'ten devam edecektir.)`
      );
    }

    // Backend already applies chunkOffsetSec to startSec & endSec; do not double-offset.
    const normalizedChunkSegments: TranscriptSegment[] = [];
    const chunkSegments = Array.isArray(chunkData?.segments) ? chunkData.segments : [];
    for (const seg of chunkSegments) {
      const startSec = round2(Math.max(0, Number(seg.startSec) || 0));
      const endSec = round2(Math.max(startSec + 0.05, Number(seg.endSec) || 0));
      const text = String(seg.text || '').trim();
      if (text && endSec > startSec) {
        normalizedChunkSegments.push({ startSec, endSec, text });
      }
    }

    fileCache.set(chunk.chunkIndex, normalizedChunkSegments);

    // Polite 1s delay between consecutive chunks
    if (i < chunks.length - 1) {
      await sleepWithAbort(DEEPGRAM_INTER_CHUNK_DELAY_MS, callbacks.signal);
    }
  }

  const allSegments: TranscriptSegment[] = [];
  for (let idx = 1; idx <= chunks.length; idx++) {
    const segs = fileCache.get(idx);
    if (segs) allSegments.push(...segs);
  }

  return allSegments.sort((a, b) => a.startSec - b.startSec);
}

function buildAlignmentModelChain(preferredModel?: string): string[] {
  const primary = preferredModel?.trim() || 'gemini-4-hydrogen';
  const order = [primary, 'gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'];
  return Array.from(new Set(order));
}

/**
 * Aligns sequentially numbered images against the full timestamped Turkish transcript.
 * Prioritizes gemini-4-hydrogen (Free Tier) for higher semantic accuracy and returns which model ran.
 */
export async function alignImagesWithTranscript(
  transcriptSegments: TranscriptSegment[],
  images: Array<Pick<UploadedImage, 'id' | 'orderNumber' | 'filename' | 'cleanTitle' | 'objectUrl'>>,
  totalAudioDuration: number,
  zoomSpeedPerSec: number,
  settings: EditorSettings,
  callbacks?: ApiCallOptions & { timingPlan?: TimingPlanEntry[] }
): Promise<{ scenes: TimelineScene[]; modelUsed: string }> {
  const modelChain = buildAlignmentModelChain(settings.alignmentModel);

  const { data, usedModelIndex } = await sendWithModelFailover<{
    alignments: Array<{ index?: number; startSec?: number; matchedExcerpt?: string }>;
    modelUsed?: string;
  }>(
    '/api/align-images',
    modelChain,
    0,
    (modelName) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (settings.customApiKey.trim()) {
        headers['x-gemini-api-key'] = settings.customApiKey.trim();
      }
      return {
        method: 'POST',
        headers,
        body: JSON.stringify({
          transcriptSegments,
          images: images.map((img) => ({
            orderNumber: img.orderNumber,
            filename: img.filename,
            cleanTitle: img.cleanTitle,
          })),
          totalAudioDuration,
          model: modelName,
          timingPlan: callbacks?.timingPlan ?? [],
        }),
      };
    },
    'Görsel eşleştirme',
    callbacks
  );

  const scenes = buildValidatedTimeline(
    images,
    Array.isArray(data.alignments) ? data.alignments : [],
    totalAudioDuration,
    zoomSpeedPerSec,
    transcriptSegments
  );

  return {
    scenes,
    modelUsed: data.modelUsed || modelChain[usedModelIndex] || 'gemini-4-hydrogen',
  };
}

export interface ScenePlanProgress {
  currentBlock: number;
  totalBlocks: number;
  generatedCount: number;
  message: string;
}

const SCENE_PLAN_SINGLE_CALL_MAX_SEC = 720; // <= 12 minutes -> 1 single Hydrogen call
const SCENE_PLAN_BLOCK_SEC = 600; // 10-minute narrative blocks for longer documentaries
const SCENE_PLAN_INTER_BLOCK_DELAY_MS = 1500;

/**
 * Generates a full documentary scene timing plan + historically accurate 16:9 2K image prompts
 * using Gemini 4 Hydrogen (Free Tier), automatically splitting long transcripts into 10-minute
 * narrative blocks so ~100+ scene documentaries never truncate or lose timeline sync.
 */
export async function generateScenePlanWithHydrogen(
  transcriptSegments: TranscriptSegment[],
  totalDurationSec: number,
  settings: EditorSettings,
  options?: ApiCallOptions & {
    styleDirection?: string;
    targetTotalScenes?: number; // 0 = auto (Hydrogen decides based on transcript)
    maxSceneDurationSec?: number; // default 60s hard ceiling per image
    onProgress?: (progress: ScenePlanProgress) => void;
    onPartialScenes?: (scenes: GeneratedScenePlanItem[]) => void;
  }
): Promise<{ scenes: GeneratedScenePlanItem[]; modelUsed: string }> {
  if (transcriptSegments.length === 0) {
    throw new Error('Sahne planı oluşturmak için önce transkript çıkarılmalı veya .SRT yüklenmelidir.');
  }

  const maxSec = Math.max(15, Math.min(180, Math.round(options?.maxSceneDurationSec ?? 60)));
  const maxSegEnd = transcriptSegments.reduce((m, s) => Math.max(m, s.endSec), 0);
  const effectiveTotal = round2(Math.max(2, totalDurationSec || maxSegEnd));

  // Build chronological time windows covering [0 .. effectiveTotal]
  const windows: Array<{ startSec: number; endSec: number }> = [];
  if (effectiveTotal <= SCENE_PLAN_SINGLE_CALL_MAX_SEC) {
    windows.push({ startSec: 0, endSec: effectiveTotal });
  } else {
    let cursor = 0;
    while (cursor < effectiveTotal - 1) {
      const remaining = effectiveTotal - cursor;
      // Avoid tiny trailing tail (< 3 min): merge into current window
      const nextEnd =
        remaining <= SCENE_PLAN_BLOCK_SEC + 180
          ? effectiveTotal
          : round2(cursor + SCENE_PLAN_BLOCK_SEC);
      windows.push({ startSec: round2(cursor), endSec: nextEnd });
      cursor = nextEnd;
    }
  }

  // Extract overall documentary context (opening ~20 lines + mid + late sample) for era consistency
  const openingSnippet = transcriptSegments
    .slice(0, 18)
    .map((s) => s.text)
    .join(' ')
    .slice(0, 900);
  const midIdx = Math.floor(transcriptSegments.length / 2);
  const midSnippet =
    transcriptSegments.length > 25
      ? transcriptSegments
          .slice(midIdx, midIdx + 8)
          .map((s) => s.text)
          .join(' ')
          .slice(0, 450)
      : '';
  const documentaryContext = midSnippet
    ? `Açılış özeti: ${openingSnippet}\nOrta bölüm örneği: ${midSnippet}`
    : openingSnippet;

  // Always prioritize gemini-4-hydrogen (Free Tier) first
  const modelChain = buildAlignmentModelChain('gemini-4-hydrogen');
  const allScenes: GeneratedScenePlanItem[] = [];
  let lastModelUsed = 'gemini-4-hydrogen';
  let currentModelIdx = 0;

  for (let bIdx = 0; bIdx < windows.length; bIdx++) {
    if (options?.signal?.aborted) {
      throw new DOMException('Sahne planı oluşturma iptal edildi.', 'AbortError');
    }

    const win = windows[bIdx];
    const windowSegments = transcriptSegments.filter(
      (seg) => seg.endSec > win.startSec + 0.05 && seg.startSec < win.endSec
    );
    const effectiveWindowSegs =
      windowSegments.length > 0
        ? windowSegments
        : [
            {
              startSec: win.startSec,
              endSec: win.endSec,
              text: '(Bu aralıkta anlatıcı sessiz veya müzik/geçiş bölümü.)',
            },
          ];

    const windowDur = win.endSec - win.startSec;
    const targetForBlock =
      options?.targetTotalScenes && options.targetTotalScenes > 0
        ? Math.max(1, Math.round((options.targetTotalScenes * windowDur) / effectiveTotal))
        : 0;

    const prevScene = allScenes[allScenes.length - 1];
    const previousSceneSummary = prevScene
      ? `#${prevScene.orderNumber} "${prevScene.title}" (Dönem: ${prevScene.era}) — ${prevScene.endSec.toFixed(1)}s'de bitti.`
      : '';

    options?.onProgress?.({
      currentBlock: bIdx + 1,
      totalBlocks: windows.length,
      generatedCount: allScenes.length,
      message:
        windows.length === 1
          ? `Gemini 4 Hydrogen ile sahne planı (maks. ${maxSec} sn) ve 16:9 2K promptlar yazılıyor...`
          : `Gemini 4 Hydrogen ile sahne planı (maks. ${maxSec} sn): Bölüm ${bIdx + 1}/${windows.length}...`,
    });

    const startOrderNumber = allScenes.length + 1;

    const { data, usedModelIndex } = await sendWithModelFailover<{
      scenes: GeneratedScenePlanItem[];
      modelUsed?: string;
    }>(
      '/api/generate-scene-plan',
      modelChain,
      currentModelIdx,
      (modelName) => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (settings.customApiKey.trim()) {
          headers['x-gemini-api-key'] = settings.customApiKey.trim();
        }
        return {
          method: 'POST',
          headers,
          body: JSON.stringify({
            windowSegments: effectiveWindowSegs,
            windowStartSec: win.startSec,
            windowEndSec: win.endSec,
            totalDurationSec: effectiveTotal,
            startOrderNumber,
            documentaryContext,
            previousSceneSummary,
            styleDirection: options?.styleDirection || '',
            targetSceneCount: targetForBlock,
            maxSceneDurationSec: maxSec,
            model: modelName,
          }),
        };
      },
      `Sahne planı Bölüm ${bIdx + 1}/${windows.length}`,
      options
    );

    currentModelIdx = usedModelIndex;
    lastModelUsed = data.modelUsed || modelChain[usedModelIndex] || 'gemini-4-hydrogen';

    const blockScenes = Array.isArray(data.scenes) ? data.scenes : [];
    for (const sc of blockScenes) {
      allScenes.push({
        orderNumber: allScenes.length + 1,
        title: String(sc.title || `Sahne ${allScenes.length + 1}`).trim(),
        era: String(sc.era || '').trim(),
        startSec: round2(Number(sc.startSec) || win.startSec),
        endSec: round2(Number(sc.endSec) || win.endSec),
        durationSec: round2(Math.max(0.5, (Number(sc.endSec) || win.endSec) - (Number(sc.startSec) || win.startSec))),
        imagePrompt: String(sc.imagePrompt || '').trim(),
      });
    }

    options?.onPartialScenes?.([...allScenes]);

    if (bIdx < windows.length - 1) {
      await sleepWithAbort(SCENE_PLAN_INTER_BLOCK_DELAY_MS, options?.signal);
    }
  }

  // Final zero-gap contiguous normalization across entire documentary [0 .. effectiveTotal]
  const normalized: GeneratedScenePlanItem[] = allScenes.map((sc, idx) => {
    const startSec = idx === 0 ? 0 : round2(allScenes[idx - 1].endSec);
    const endSec =
      idx === allScenes.length - 1
        ? effectiveTotal
        : round2(Math.max(startSec + 1, sc.endSec));
    sc.startSec = startSec;
    sc.endSec = endSec;
    return {
      ...sc,
      orderNumber: idx + 1,
      startSec,
      endSec,
      durationSec: round2(Math.max(0.5, endSec - startSec)),
    };
  });

  return {
    scenes: normalized,
    modelUsed: lastModelUsed,
  };
}
