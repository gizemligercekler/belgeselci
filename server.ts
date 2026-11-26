import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 3000;

const DEEPGRAM_LISTEN_BASE_URL = 'https://api.deepgram.com/v1/listen';
const ALLOWED_DEEPGRAM_MODELS = new Set(['nova-3', 'nova-2']);

function resolveGeminiKey(req: Request): string {
  const headerKey = req.header('x-gemini-api-key')?.trim();
  if (headerKey) return headerKey;
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey && envKey !== 'MY_GEMINI_API_KEY') return envKey;
  return '';
}

function resolveDeepgramKey(req: Request, bodyKey?: string): string {
  const headerKey = req.header('x-deepgram-api-key')?.trim();
  if (headerKey) return headerKey;
  const directKey = typeof bodyKey === 'string' ? bodyKey.trim() : '';
  if (directKey) return directKey;
  const envKey = process.env.DEEPGRAM_API_KEY?.trim();
  if (envKey && envKey !== 'MY_DEEPGRAM_API_KEY') return envKey;
  return '';
}

function parseRetryAfterSec(rawHeader: string | null): number {
  if (!rawHeader) return 10;
  const trimmed = rawHeader.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.min(120, Math.max(1, Math.ceil(numeric)));
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const diffSec = Math.ceil((dateMs - Date.now()) / 1000);
    if (diffSec > 0) return Math.min(120, diffSec);
  }
  return 10;
}

interface DeepgramWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
}

interface DeepgramUtterance {
  start?: number;
  end?: number;
  transcript?: string;
  words?: DeepgramWord[];
}

interface DeepgramSentence {
  start?: number;
  end?: number;
  text?: string;
}

interface DeepgramParagraph {
  sentences?: DeepgramSentence[];
}

interface DeepgramListenResponse {
  results?: {
    utterances?: DeepgramUtterance[];
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        words?: DeepgramWord[];
        paragraphs?: {
          paragraphs?: DeepgramParagraph[];
        };
      }>;
    }>;
  };
}

interface RawRelativeSegment {
  start: number;
  end: number;
  text: string;
}

const SENTENCE_END_RE = /[.!?…]["'”’)\]]*$/;
const CLAUSE_BREAK_RE = /[,;:]["'”’)\]]*$/;

/**
 * Splits a Deepgram utterance cleanly at sentence boundaries (. ? !) using word-level
 * timestamps so long continuous documentary narration stays crisp and readable for subtitles.
 */
function splitUtteranceBySentences(utt: DeepgramUtterance): RawRelativeSegment[] {
  const words = Array.isArray(utt.words) ? utt.words : [];
  if (words.length === 0) {
    const text = typeof utt.transcript === 'string' ? utt.transcript.trim() : '';
    const start = Number(utt.start);
    const end = Number(utt.end);
    if (text && Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return [{ start, end, text }];
    }
    return [];
  }

  const out: RawRelativeSegment[] = [];
  let tokens: string[] = [];
  let segStart = -1;
  let segEnd = -1;

  const flush = () => {
    const text = tokens.join(' ').replace(/\s+/g, ' ').trim();
    if (text && Number.isFinite(segStart) && Number.isFinite(segEnd) && segEnd > segStart) {
      out.push({ start: segStart, end: segEnd, text });
    }
    tokens = [];
    segStart = -1;
    segEnd = -1;
  };

  for (const w of words) {
    const token = String(w.punctuated_word || w.word || '').trim();
    if (!token) continue;
    const wStart = Number(w.start);
    const wEnd = Number(w.end);
    if (!Number.isFinite(wStart) || !Number.isFinite(wEnd)) continue;

    if (segStart < 0) segStart = wStart;
    segEnd = Math.max(segEnd, wEnd);
    tokens.push(token);

    if (SENTENCE_END_RE.test(token)) {
      flush();
    } else if (tokens.length >= 22 && CLAUSE_BREAK_RE.test(token)) {
      flush();
    }
  }
  flush();

  return out;
}

/**
 * 3-tier Deepgram segment extraction:
 * 1. results.utterances (split cleanly at sentence boundaries for subtitles)
 * 2. Fallback: results.channels[0].alternatives[0].paragraphs.paragraphs[].sentences[]
 * 3. Fallback: group words[] into ~12-word timestamped segments
 */
function extractDeepgramRelativeSegments(data: DeepgramListenResponse): RawRelativeSegment[] {
  const rawSegments: RawRelativeSegment[] = [];

  // Tier 1: Utterances (with sentence-boundary splitting)
  const utterances = data.results?.utterances;
  if (Array.isArray(utterances) && utterances.length > 0) {
    for (const utt of utterances) {
      rawSegments.push(...splitUtteranceBySentences(utt));
    }
  }
  if (rawSegments.length > 0) return rawSegments;

  const firstAlt = data.results?.channels?.[0]?.alternatives?.[0];

  // Tier 2: Paragraphs -> Sentences
  const paragraphs = firstAlt?.paragraphs?.paragraphs;
  if (Array.isArray(paragraphs) && paragraphs.length > 0) {
    for (const para of paragraphs) {
      const sentences = Array.isArray(para.sentences) ? para.sentences : [];
      for (const s of sentences) {
        const text = typeof s.text === 'string' ? s.text.trim() : '';
        const start = Number(s.start);
        const end = Number(s.end);
        if (text && Number.isFinite(start) && Number.isFinite(end) && end > start) {
          rawSegments.push({ start, end, text });
        }
      }
    }
  }
  if (rawSegments.length > 0) return rawSegments;

  // Tier 3: Group words[] into ~12-word segments
  const words = firstAlt?.words;
  if (Array.isArray(words) && words.length > 0) {
    let tokens: string[] = [];
    let segStart = -1;
    let segEnd = -1;

    const flush = () => {
      const text = tokens.join(' ').replace(/\s+/g, ' ').trim();
      if (text && Number.isFinite(segStart) && Number.isFinite(segEnd) && segEnd > segStart) {
        rawSegments.push({ start: segStart, end: segEnd, text });
      }
      tokens = [];
      segStart = -1;
      segEnd = -1;
    };

    for (const w of words) {
      const token = String(w.punctuated_word || w.word || '').trim();
      if (!token) continue;
      const wStart = Number(w.start);
      const wEnd = Number(w.end);
      if (!Number.isFinite(wStart) || !Number.isFinite(wEnd)) continue;

      if (segStart < 0) segStart = wStart;
      segEnd = Math.max(segEnd, wEnd);
      tokens.push(token);

      if ((tokens.length >= 8 && SENTENCE_END_RE.test(token)) || tokens.length >= 12) {
        flush();
      }
    }
    flush();
  }

  return rawSegments;
}

function createGenAIClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractInnerMessage(raw: string): { message: string; code?: number; status?: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: { code?: number; status?: string; message?: string };
        message?: string;
      };
      if (parsed?.error?.message) {
        return {
          message: parsed.error.message,
          code: parsed.error.code,
          status: parsed.error.status,
        };
      }
      if (parsed?.message) {
        return { message: parsed.message };
      }
    } catch {
      // not JSON
    }
  }
  return { message: raw };
}

function parseErrorStatus(err: unknown): {
  httpStatus: number;
  upstreamStatus: number;
  message: string;
  code?: string;
  retryable: boolean;
} {
  const anyErr = err as {
    status?: number;
    statusCode?: number;
    message?: string;
    error?: { code?: number; status?: string; message?: string };
  };

  const rawTop =
    anyErr?.error?.message ||
    anyErr?.message ||
    'Gemini API isteği sırasında beklenmeyen bir hata oluştu.';
  const inner = extractInnerMessage(rawTop);
  const cleanMsg = inner.message;

  let upstreamStatus =
    typeof anyErr?.status === 'number'
      ? anyErr.status
      : typeof anyErr?.statusCode === 'number'
        ? anyErr.statusCode
        : typeof anyErr?.error?.code === 'number'
          ? anyErr.error.code
          : typeof inner.code === 'number'
            ? inner.code
            : 500;

  if (upstreamStatus === 500) {
    if (/429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(cleanMsg)) upstreamStatus = 429;
    else if (/503|UNAVAILABLE|high demand|overloaded/i.test(cleanMsg)) upstreamStatus = 503;
    else if (/504|DEADLINE_EXCEEDED|timeout/i.test(cleanMsg)) upstreamStatus = 504;
    else if (/404|NOT_FOUND|not found|not supported/i.test(cleanMsg)) upstreamStatus = 404;
    else if (/403|PERMISSION_DENIED/i.test(cleanMsg)) upstreamStatus = 403;
    else if (/400|INVALID_ARGUMENT|API_KEY_INVALID/i.test(cleanMsg)) upstreamStatus = 400;
  }

  const code =
    anyErr?.error?.status ||
    inner.status ||
    (upstreamStatus === 429
      ? 'RESOURCE_EXHAUSTED'
      : upstreamStatus === 503
        ? 'UNAVAILABLE'
        : undefined);

  const retryable =
    upstreamStatus === 429 ||
    upstreamStatus === 502 ||
    upstreamStatus === 503 ||
    upstreamStatus === 504;

  // CRITICAL: Cloud preview nginx intercepts HTTP 403, 502, 503, 504 and replaces
  // the JSON body with HTML (/forbidden.html or /warmup.html with HTTP 200!).
  // Map those upstream statuses to safe JSON HTTP statuses (401 or 429 / 500).
  let httpStatus = upstreamStatus;
  if (upstreamStatus === 403) {
    httpStatus = 401;
  } else if (upstreamStatus === 502 || upstreamStatus === 503 || upstreamStatus === 504) {
    httpStatus = 429;
  }

  let friendlyTr = cleanMsg;
  if (upstreamStatus === 429) {
    friendlyTr =
      'Gemini Free Tier hız sınırına ulaşıldı (429). Kısa beklemenin ardından otomatik yeniden denenecek.';
  } else if (upstreamStatus === 503 || upstreamStatus === 502 || upstreamStatus === 504) {
    friendlyTr =
      `Seçili Gemini modeli şu an geçici olarak yoğun (${upstreamStatus} ${code || 'UNAVAILABLE'}). Kısa beklemenin ardından otomatik yeniden denenecek; sorun sürerse Ayarlar'dan farklı bir model deneyebilirsiniz.`;
  } else if (upstreamStatus === 404) {
    friendlyTr = `Seçili model bu uç noktada bulunamadı (404). Ayarlar'dan model adını kontrol edin (örn. gemini-3.8-flash veya gemini-4-hydrogen). Detay: ${cleanMsg}`;
  } else if (upstreamStatus === 403 || upstreamStatus === 401 || /API_KEY_INVALID/i.test(cleanMsg)) {
    friendlyTr =
      'Gemini API anahtarı geçersiz veya yetkisiz. Ayarlar penceresindeki anahtarı veya sunucu yapılandırmasını kontrol edin.';
  }

  return {
    httpStatus,
    upstreamStatus,
    message: friendlyTr,
    code,
    retryable,
  };
}


function formatMMSS(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '32mb' }));
  app.use(
    '/api/transcribe-chunk',
    express.raw({
      type: ['audio/wav', 'application/octet-stream'],
      limit: '25mb',
    })
  );

  app.get('/api/health', (_req: Request, res: Response) => {
    const hasGemini =
      Boolean(process.env.GEMINI_API_KEY?.trim()) &&
      process.env.GEMINI_API_KEY?.trim() !== 'MY_GEMINI_API_KEY';
    const hasDeepgramKey =
      Boolean(process.env.DEEPGRAM_API_KEY?.trim()) &&
      process.env.DEEPGRAM_API_KEY?.trim() !== 'MY_DEEPGRAM_API_KEY';
    res.json({ ok: true, hasServerGeminiKey: hasGemini, hasDeepgramKey });
  });

  // 1. Transcribe a 5-minute 16kHz mono WAV audio chunk via Deepgram Pre-Recorded Audio API
  app.post('/api/transcribe-chunk', async (req: Request, res: Response) => {
    try {
      let wavBuffer: Buffer | null = null;
      let chunkOffsetSec = 0;
      let chunkDurationSec = 300;
      let requestedModel = 'nova-3';
      let bodyDeepgramKey: string | undefined;

      if (Buffer.isBuffer(req.body)) {
        wavBuffer = req.body;
        const parsedOffset = Number(req.header('x-chunk-offset') ?? req.query.chunkOffsetSec ?? 0);
        chunkOffsetSec = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

        const parsedDur = Number(req.header('x-chunk-duration') ?? req.query.chunkDurationSec ?? 300);
        chunkDurationSec = Number.isFinite(parsedDur) && parsedDur > 0 ? parsedDur : 300;

        requestedModel = (
          req.header('x-deepgram-model') ||
          String(req.query.deepgramModel || '')
        ).trim();
      } else {
        const body = (req.body || {}) as {
          audioBase64?: string;
          chunkOffsetSec?: number;
          chunkDurationSec?: number;
          deepgramModel?: string;
          deepgramApiKey?: string;
        };
        if (typeof body.audioBase64 === 'string' && body.audioBase64.trim()) {
          wavBuffer = Buffer.from(body.audioBase64, 'base64');
        }
        const parsedOffset = Number(body.chunkOffsetSec ?? 0);
        chunkOffsetSec = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

        const parsedDur = Number(body.chunkDurationSec ?? 300);
        chunkDurationSec = Number.isFinite(parsedDur) && parsedDur > 0 ? parsedDur : 300;

        requestedModel = typeof body.deepgramModel === 'string' ? body.deepgramModel.trim() : '';
        bodyDeepgramKey = body.deepgramApiKey;
      }

      const deepgramApiKey = resolveDeepgramKey(req, bodyDeepgramKey);
      if (!deepgramApiKey) {
        res.status(400).json({
          error:
            "Otomatik transkript için Ayarlar'dan Deepgram API anahtarınızı (console.deepgram.com) girin veya Adım 1'de hazır .srt dosyanızı yükleyin.",
        });
        return;
      }

      if (!wavBuffer || wavBuffer.length === 0) {
        res.status(400).json({ error: 'Ses parçası verisi boş veya eksik.' });
        return;
      }

      const deepgramModel = ALLOWED_DEEPGRAM_MODELS.has(requestedModel)
        ? requestedModel
        : 'nova-3';

      const listenUrl =
        `${DEEPGRAM_LISTEN_BASE_URL}?model=${encodeURIComponent(deepgramModel)}` +
        '&language=tr&smart_format=true&punctuate=true&utterances=true&paragraphs=true';

      const dgRes = await fetch(listenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Token ${deepgramApiKey}`,
          'Content-Type': 'audio/wav',
        },
        body: new Uint8Array(wavBuffer),
      });

      if (dgRes.status === 429) {
        const retryAfterSec = parseRetryAfterSec(dgRes.headers.get('retry-after'));
        res.status(429).json({
          error: `Deepgram hız sınırına ulaşıldı (429). ${retryAfterSec} saniye sonra otomatik yeniden denenecek.`,
          retryAfterSec,
          retryable: true,
          upstreamStatus: 429,
        });
        return;
      }

      if (!dgRes.ok) {
        const rawErrText = await dgRes.text().catch(() => '');
        let upstreamMsg = rawErrText.trim();
        try {
          const parsedErr = JSON.parse(rawErrText) as {
            err_msg?: string;
            message?: string;
            error?: string | { message?: string };
          };
          upstreamMsg =
            parsedErr?.err_msg ||
            parsedErr?.message ||
            (typeof parsedErr?.error === 'string' ? parsedErr.error : parsedErr?.error?.message) ||
            upstreamMsg;
        } catch {
          // keep plain text
        }

        const upstreamStatus = dgRes.status;
        // CRITICAL: Map nginx-intercepted 403/502/503/504 to safe JSON statuses
        if (upstreamStatus === 401 || upstreamStatus === 403) {
          res.status(401).json({
            error: 'Deepgram API anahtarı geçersiz veya yetkisiz.',
            upstreamStatus,
            retryable: false,
          });
          return;
        }
        if (upstreamStatus === 502 || upstreamStatus === 503 || upstreamStatus === 504) {
          const retryAfterSec = parseRetryAfterSec(dgRes.headers.get('retry-after'));
          res.status(429).json({
            error: `Deepgram sunucusu geçici olarak yoğun (${upstreamStatus}). Kısa beklemenin ardından otomatik yeniden denenecek.`,
            retryAfterSec,
            retryable: true,
            upstreamStatus,
          });
          return;
        }

        const safeStatus = upstreamStatus >= 400 && upstreamStatus < 500 ? upstreamStatus : 500;
        res.status(safeStatus).json({
          error: upstreamMsg
            ? `Deepgram hatası (${upstreamStatus}): ${upstreamMsg}`
            : `Deepgram isteği başarısız oldu (${upstreamStatus}).`,
          upstreamStatus,
          retryable: false,
        });
        return;
      }

      const dgData = (await dgRes.json()) as DeepgramListenResponse;
      const relativeSegments = extractDeepgramRelativeSegments(dgData);
      const maxChunkEndSec = chunkOffsetSec + chunkDurationSec + 0.5;
      const segments: Array<{ startSec: number; endSec: number; text: string }> = [];

      for (const seg of relativeSegments) {
        const text = seg.text.trim();
        if (!text) continue;

        const clampedStart = Math.max(
          chunkOffsetSec,
          Math.min(maxChunkEndSec, seg.start + chunkOffsetSec)
        );
        const clampedEnd = Math.min(maxChunkEndSec, seg.end + chunkOffsetSec);

        const startSec = Number(clampedStart.toFixed(2));
        const endSec = Number(clampedEnd.toFixed(2));

        if (endSec <= startSec) continue;
        segments.push({ startSec, endSec, text });
      }

      segments.sort((a, b) => a.startSec - b.startSec);
      res.json({ segments });
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : 'Deepgram isteği sırasında beklenmeyen bir ağ hatası oluştu.';
      console.error('[/api/transcribe-chunk] unexpected error:', errMsg);
      res.status(429).json({
        error: `Deepgram bağlantısı geçici olarak kesildi. Otomatik yeniden denenecek. (${errMsg})`,
        retryAfterSec: 10,
        retryable: true,
      });
    }
  });

  // 2. Strict Sequential Image-to-Transcript Alignment
  app.post('/api/align-images', async (req: Request, res: Response) => {
    try {
      const apiKey = resolveGeminiKey(req);
      if (!apiKey) {
        res.status(401).json({
          error:
            'Gemini API anahtarı bulunamadı. Ayarlar penceresinden anahtar girin veya sunucu GEMINI_API_KEY değişkenini tanımlayın.',
        });
        return;
      }

      const {
        transcriptSegments = [],
        images = [],
        timingPlan = [],
        totalAudioDuration = 0,
        model = 'gemini-4-hydrogen',
      } = req.body as {
        transcriptSegments?: Array<{ startSec: number; endSec: number; text: string }>;
        images?: Array<{ orderNumber: number; filename: string; cleanTitle: string }>;
        timingPlan?: Array<{
          orderNumber: number;
          title: string;
          startSec: number;
          endSec: number;
          durationSec: number;
        }>;
        totalAudioDuration?: number;
        model?: string;
      };

      if (!Array.isArray(images) || images.length === 0) {
        res.status(400).json({ error: 'Eşleştirilecek görsel listesi boş.' });
        return;
      }

      const totalDur = Math.max(2, Number(totalAudioDuration) || 60);
      const ai = createGenAIClient(apiKey);

      const transcriptText = transcriptSegments
        .map((s) => `[${formatMMSS(s.startSec)} - ${formatMMSS(s.endSec)}] (${s.startSec.toFixed(1)}s) ${s.text}`)
        .join('\n');

      const validTimingPlan = Array.isArray(timingPlan)
        ? timingPlan.filter(
            (t) =>
              t &&
              Number.isFinite(Number(t.orderNumber)) &&
              Number.isFinite(Number(t.startSec)) &&
              Number.isFinite(Number(t.endSec))
          )
        : [];

      // Number-first lookup map: image orderNumber is the primary key regardless of title typos/missing words
      const planByOrder = new Map<
        number,
        { orderNumber: number; title: string; startSec: number; endSec: number; durationSec: number }
      >();
      for (const t of validTimingPlan) {
        const num = Number(t.orderNumber);
        if (!planByOrder.has(num)) {
          planByOrder.set(num, {
            orderNumber: num,
            title: String(t.title || ''),
            startSec: Number(t.startSec),
            endSec: Number(t.endSec),
            durationSec: Number(t.durationSec),
          });
        }
      }

      const imageListText = images
        .map((img, idx) => {
          const matchedPlan = planByOrder.get(Number(img.orderNumber));
          const lockTag = matchedPlan
            ? ` | [NUMARA EŞLEŞMESİ KESİN #${matchedPlan.orderNumber} => startSec=${matchedPlan.startSec.toFixed(2)}s, bitiş=${matchedPlan.endSec.toFixed(2)}s (${matchedPlan.durationSec.toFixed(1)} sn)]`
            : '';
          return `${idx + 1}. Görsel Numarası: #${img.orderNumber} | Dosya: ${img.filename} | Konu Başlığı: ${img.cleanTitle}${lockTag}`;
        })
        .join('\n');

      const timingPlanBlock =
        validTimingPlan.length > 0
          ? `\nKULLANICI SÜRE PLANI (.TXT — ÖNCELİKLİ VE KESİN REFERANS):\n` +
            `KRİTİK KURAL (NUMARA ÖNCELİĞİ): Görselleri sürelerle eşleştirirken İLK ÖNCE GÖRSEL NUMARASINA (#1, #2, #3...) bak!\n` +
            `Görsel dosya adlarında veya başlıklarında eksik sözcük, harf hatası, kısaltma veya Türkçe karakter farkı olabilir. Başlık birebir tutmasa bile GÖRSEL NUMARASI (#N) ile plandaki NUMARA (#N) eşleşiyorsa, o görsel KESİNLİKLE plandaki o numaranın startSec değerine sabitlenmelidir.\n` +
            `Listede numarası bulunmayan ara görseller varsa, iki sabit numara çapası arasına doğal biçimde yerleştir:\n` +
            validTimingPlan
              .map(
                (t) =>
                  `- Plan Numarası #${t.orderNumber} | Plan Başlığı: ${t.title} | Zaman: ${formatMMSS(Number(t.startSec))} - ${formatMMSS(Number(t.endSec))} (startSec=${Number(t.startSec).toFixed(2)}s, süre=${Number(t.durationSec).toFixed(1)} sn)`
              )
              .join('\n') +
            '\n'
          : '';

      const prompt = `Sen ödüllü bir Türkçe belgesel kurgu yönetmenisin.
Aşağıda bir belgeselin baştan sona zaman damgalı Türkçe transkripti (toplam süre: ${totalDur.toFixed(2)} saniye) ve sayısal sıraya dizilmiş ${images.length} adet görselin listesi var.

Görevin: Her görseli, ${validTimingPlan.length > 0 ? 'İLK ÖNCE GÖRSEL NUMARASINA (#1, #2, #3...) bakarak kullanıcının yüklediği SÜRE PLANI (.TXT) zamanlarına sabitlemek; numarası planda olmayan görselleri ise ' : ''}anlatıcının o görselin konusundan bahsetmeye BAŞLADIĞI tam saniyeye (startSec) milimetrik anlamsal doğrulukla yerleştirmek.

ADIM ADIM STRATEJİN:
1. ${validTimingPlan.length > 0 ? 'İLK ÖNCELİK NUMARADIR: Görsel listesindeki "Görsel Numarası: #N" değerini SÜRE PLANI (.TXT) içindeki "Plan Numarası #N" ile eşleştir ve startSec değerini birebir uygula. Dosya adında eksik kelime, harf hatası veya küçük isim farkları olsa bile NUMARA EŞLEŞMESİ her zaman başlık metninden önceliklidir.' : `Önce tüm transkripti 0.0 saniyeden ${totalDur.toFixed(1)} saniyeye kadar baştan sona oku ve belgeselin bölüm/konu akışını çıkar.`}
2. Numarası planda yer almayan (veya plan yoksa tüm) görseller için "Görsel Numarası" sırasını koruyarak "Konu Başlığı" (cleanTitle) içindeki anahtar kavramları transkriptle eşleştir. Dosya isimlerinde eksik sözcük, harf hatası veya Türkçe karakter farkı (ş/s, ğ/g, ç/c, ı/i, ö/o, ü/u) olabileceğini hesaba kat ve yaklaşık/anlamsal eşleşme yap.
3. Önce kesin eşleşen (numara çapası veya net konu çapası) görsellerin tam saniyelerini sabitle; arada kalan veya kısa/eksik başlıklı görselleri iki çapa arasındaki doğal cümle başlangıçlarına orantılı biçimde yerleştir. Görselleri asla başa veya sona yığma.

KESİN KURALLAR:
- Görsellerin sırası ASLA değişmez (1'den ${images.length}'e kadar birebir aynı sıra).
- İlk görsel (index 0) KESİNLİKLE 0.0 saniyede başlamalıdır.
- Her görsel i, kendinden önceki görsel i-1'den KESİNLİKLE daha sonra başlamalıdır (startSec[i] >= startSec[i-1] + 2.0).
- Tüm startSec değerleri 0.0 ile ${(totalDur - 2).toFixed(2)} arasında ve tercihen ilgili plan/transkript satırının tam startSec değerinde olmalıdır.
- Her görsel için tam o startSec anındaki transkript cümlesinden (veya süre planı başlığından) birebir kısa alıntı (matchedExcerpt, en fazla 140 karakter) yaz.
${timingPlanBlock}
GÖRSEL LİSTESİ (${images.length} adet):
${imageListText}

ZAMAN DAMGALI TRANSKRİPT:
${transcriptText || '(Transkript metni boş; süre planına göre veya toplam süreye eşit dağıt.)'}

Tam olarak ${images.length} elemanlı JSON dizisi döndür.`;

      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                index: {
                  type: Type.INTEGER,
                  description: '0-based index matching the input image list order.',
                },
                filename: {
                  type: Type.STRING,
                  description: 'Exact filename from input list.',
                },
                startSec: {
                  type: Type.NUMBER,
                  description: 'Exact start timestamp in seconds.',
                },
                matchedExcerpt: {
                  type: Type.STRING,
                  description: 'Short matched Turkish transcript excerpt around startSec.',
                },
              },
              required: ['index', 'startSec', 'matchedExcerpt'],
            },
          },
        },
      });

      const rawText = (response.text ?? '[]')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();

      const parsed = JSON.parse(rawText) as Array<{
        index?: number;
        filename?: string;
        startSec?: number;
        matchedExcerpt?: string;
      }>;

      const aiAlignments = Array.isArray(parsed) ? parsed : [];

      // Hard-enforce number-first matches from timingPlan so typos or missing words
      // in image filenames can NEVER cause Gemini to shift a number-matched scene.
      const finalAlignments =
        planByOrder.size > 0
          ? images.map((img, idx) => {
              const aiItem =
                aiAlignments.find((a) => a.index === idx) || aiAlignments[idx] || {};
              const matchedPlan = planByOrder.get(Number(img.orderNumber));
              if (matchedPlan) {
                return {
                  index: idx,
                  filename: img.filename,
                  startSec: idx === 0 ? 0 : matchedPlan.startSec,
                  matchedExcerpt:
                    (typeof aiItem.matchedExcerpt === 'string' && aiItem.matchedExcerpt.trim()) ||
                    matchedPlan.title ||
                    img.cleanTitle,
                };
              }
              return {
                index: idx,
                filename: img.filename,
                startSec: aiItem.startSec,
                matchedExcerpt: aiItem.matchedExcerpt || img.cleanTitle,
              };
            })
          : aiAlignments;

      res.json({ alignments: finalAlignments, modelUsed: model });
    } catch (err) {
      const parsedErr = parseErrorStatus(err);
      console.error('[/api/align-images] error:', parsedErr.upstreamStatus, parsedErr.code, parsedErr.message);
      res.status(parsedErr.httpStatus).json({
        error: parsedErr.message,
        code: parsedErr.code,
        upstreamStatus: parsedErr.upstreamStatus,
        retryable: parsedErr.retryable,
      });
    }
  });

  // 3. Generate Scene Timing Plan + Historically Accurate 16:9 2K Image Prompts via Gemini 4 Hydrogen
  app.post('/api/generate-scene-plan', async (req: Request, res: Response) => {
    try {
      const apiKey = resolveGeminiKey(req);
      if (!apiKey) {
        res.status(401).json({
          error:
            'Gemini API anahtarı bulunamadı. Ayarlar penceresinden anahtar girin veya sunucu GEMINI_API_KEY değişkenini tanımlayın.',
        });
        return;
      }

      const {
        windowSegments = [],
        windowStartSec = 0,
        windowEndSec = 0,
        totalDurationSec = 0,
        startOrderNumber = 1,
        documentaryContext = '',
        previousSceneSummary = '',
        styleDirection = '',
        targetSceneCount = 0,
        maxSceneDurationSec = 60,
        model = 'gemini-4-hydrogen',
      } = req.body as {
        windowSegments?: Array<{ startSec: number; endSec: number; text: string }>;
        windowStartSec?: number;
        windowEndSec?: number;
        totalDurationSec?: number;
        startOrderNumber?: number;
        documentaryContext?: string;
        previousSceneSummary?: string;
        styleDirection?: string;
        targetSceneCount?: number;
        maxSceneDurationSec?: number;
        model?: string;
      };

      if (!Array.isArray(windowSegments) || windowSegments.length === 0) {
        res.status(400).json({ error: 'Sahne planı üretilecek transkript bölümü boş.' });
        return;
      }

      const safeStart = Math.max(0, Number(windowStartSec) || 0);
      const maxSegEnd = windowSegments.reduce((m, s) => Math.max(m, Number(s.endSec) || 0), 0);
      const safeEnd = Math.max(safeStart + 2, Number(windowEndSec) || maxSegEnd);
      const windowDur = safeEnd - safeStart;
      const safeTotal = Math.max(safeEnd, Number(totalDurationSec) || safeEnd);
      const firstNum = Math.max(1, Math.floor(Number(startOrderNumber) || 1));
      const maxSec = Math.max(15, Math.min(180, Math.round(Number(maxSceneDurationSec) || 60)));

      // Strictly guarantee enough scenes so NO scene needs to exceed maxSec
      const minScenesForCap = Math.max(1, Math.ceil(windowDur / maxSec));
      const autoMinScenes = Math.max(minScenesForCap, Math.round(windowDur / Math.min(42, maxSec * 0.7)));
      const autoMaxScenes = Math.max(autoMinScenes + 2, Math.round(windowDur / 20));
      const explicitTarget =
        Number.isFinite(Number(targetSceneCount)) && Number(targetSceneCount) > 0
          ? Math.max(minScenesForCap, Math.min(80, Math.round(Number(targetSceneCount))))
          : 0;

      const countInstruction =
        explicitTarget > 0
          ? `Bu bölüm (${Math.round(windowDur)} sn) için en az ${minScenesForCap}, yaklaşık ${explicitTarget} sahne oluştur. HİÇBİR sahne ${maxSec} saniyeyi geçmemelidir.`
          : `Bu bölümün (${Math.round(windowDur)} sn) anlatım akışına ve konu değişimlerine göre ideal sahne sayısına karar ver (belgesel temposu için ideal sahne süresi 18–42 saniye arasıdır; bu bölüm için en az ${autoMinScenes}, ideal olarak ${autoMinScenes}–${autoMaxScenes} sahne üret ve HİÇBİR sahne ${maxSec} saniyeyi geçmesin).`;

      const transcriptBlock = windowSegments
        .map(
          (s) =>
            `[${formatMMSS(Number(s.startSec))} - ${formatMMSS(Number(s.endSec))}] (${Number(s.startSec).toFixed(1)}s) ${String(s.text || '').trim()}`
        )
        .join('\n');

      const styleNote = styleDirection.trim()
        ? `KULLANICININ ÖZEL GÖRSEL STİL TERCİHİ: ${styleDirection.trim()}`
        : 'GÖRSEL STİL: Sinematik, gerçekçi, yüksek detaylı tarihi belgesel fotoğrafçılığı / film karesi estetiği (doğal dokular, atmosferik sinematografi, abartısız renk paleti).';

      const sceneResponseSchema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            title: {
              type: Type.STRING,
              description: 'Short descriptive Turkish scene title suitable as an image filename.',
            },
            era: {
              type: Type.STRING,
              description: 'Historical century/decade and geography in Turkish (e.g. "7. Yüzyıl (600\'ler), Hicaz" or "1959, ABD").',
            },
            startSec: {
              type: Type.NUMBER,
              description: 'Exact start time in seconds within the window.',
            },
            endSec: {
              type: Type.NUMBER,
              description: 'Exact end time in seconds within the window.',
            },
            imagePrompt: {
              type: Type.STRING,
              description: 'Detailed English 16:9 2K historically accurate cinematic image generation prompt with zero anachronisms.',
            },
          },
          required: ['title', 'era', 'startSec', 'endSec', 'imagePrompt'],
        },
      };

      const systemInstruction = `Sen ödüllü bir belgesel yönetmeni, tarih danışmanı ve görsel prompt uzmanısın.
Görevin, sana verilen zaman damgalı Türkçe belgesel transkriptinden, hem her sahnenin ekranda kalacağı kesin saniye aralığını hem de her sahne için 16:9 2K çözünürlükte, DÖNEMSEL OLARAK %100 TARİHİ DOĞRULUĞA SAHİP İngilizce görsel üretim promptlarını (imagePrompt) oluşturmaktır.

TARİHSEL DÖNEM VE ANAKRONİZM YASAĞI (EN KRİTİK KURAL):
- Her sahnenin geçtiği yüzyılı, on yılı ve coğrafyayı transkriptten tespit et ve "era" alanına Türkçe yaz (örn: "7. Yüzyıl (600'ler), Hicaz", "1959, Michigan ABD", "15. Yüzyıl, Osmanlı").
- Seçilen dönemde HENÜZ İCAT EDİLMEMİŞ hiçbir nesne, kıyafet, aydınlatma veya mimari öğe prompt içinde ASLA geçmemelidir:
  * 13. yüzyıl öncesi (örn. 600'lü yıllar / 7. yüzyıl, Antik Çağ, Erken Orta Çağ): ASLA gözlük (eyeglasses/spectacles ~1286'da icat edildi), ASLA camlı gaz lambası (kerosene/glass lamp 19. yy'da çıktı), ASLA matbaa baskı kitap, ASLA elektrik, modern düğme, fermuar, kol saati, asfalt, modern pencere camı bulunmamalıdır. Aydınlatma için yalnızca döneme uygun kil/bronz zeytinyağı kandili (clay/bronze oil lamp), balmumu mum, meşale, ocak ateşi veya doğal gün ışığı kullan; yazı malzemesi olarak parşömen/papirüs/deri rulo ve kamış kalem kullan.
  * 1850 öncesi dönemler: Camlı gaz lambası, elektrik ampulü, fotoğraf makinesi, modern sanayi ürünleri yasaktır.
  * 1900–1980 arası dönemler (örn. 1950'ler): Akıllı telefon, LED ekran, modern plastik, çağdaş kıyafetler yasaktır; yalnızca o on yılın gerçek mobilya, araç, giyim ve film dokusunu betimle.
- Promptta hem döneme uygun özgün malzemeleri açıkça belirt hem de anakronizmleri engelleyen ifadeler kullan.

İMAJ PROMPTU FORMAT KURALLARI:
- "imagePrompt" alanı, modern görsel üretim araçlarında (Imagen, Midjourney, Flux, Whisk, Nano Banana) en yüksek kaliteyi vermesi için akıcı, betimleyici ve sinematik İNGİLİZCE yazılmalıdır.
- Her promptta şu unsurlar net biçimde yer almalıdır: kamera açısı/kadraj, ana konu ve eylem, döneme tam uyumlu kıyafet/mimari/nesneler, döneme uygun doğal ışık ve atmosfer, renk/doku kalitesi.
- Her prompt mutlaka "16:9 widescreen aspect ratio, 2K resolution, historically accurate period details, no anachronisms, no text, no watermark" ibarelerini (doğal bütünlük içinde) içermelidir.
- Görsellerde asla metin, yazı, tabela, filigran, çerçeve veya kolaj bölünmesi isteme (tek bir tam çerçeve 16:9 sahne).
- "title" alanı kısa, anlaşılır TÜRKÇE sahne başlığı olmalıdır (dosya adı olarak kullanılacak; örn: "Ypsilanti Akıl Hastanesi Koğuşu (1959)").

ZAMANLAMA VE SÜRE ÜST SINIRI KURALLARI (KESİN):
- İlk sahne KESİNLİKLE ${safeStart.toFixed(2)} saniyesinde başlamalıdır.
- Son sahne KESİNLİKLE ${safeEnd.toFixed(2)} saniyesinde bitmelidir (aralığın tamamını dengeli biçimde kapla; son sahneyi uzatma!).
- Sahneler arasında HİÇ boşluk veya çakışma olmamalıdır: her sahnenin startSec değeri bir önceki sahnenin endSec değerine eşit olmalıdır (kesintisiz akış).
- KESİN ÜST SINIR: HİÇBİR sahne ${maxSec} saniyeden uzun OLMAMALIDIR (endSec - startSec <= ${maxSec})!
- İdeal sahne süresi 18–42 saniye arasıdır (en az 5 saniye, en fazla ${maxSec} saniye).
- Anlatıcı aynı konudan ${maxSec} saniyeden uzun bahsediyorsa, o bölümü mutlaka farklı görsel açılarla birden fazla sahneye böl (örn. 1. geniş mekan atmosferi -> 2. karakter/eylem orta planı -> 3. döneme özgü yakın detay çekimi). Tek bir görsel asla ${maxSec} saniyeden uzun ekranda kalmamalıdır.`;

      const prompt = `BELGESEL GENEL BAĞLAMI (Toplam Süre: ${formatMMSS(safeTotal)}):
${documentaryContext.trim() || '(Genel bağlam transkriptten anlaşılacaktır.)'}
${previousSceneSummary.trim() ? `\nÖNCEKİ BÖLÜMÜN SON SAHNESİ (Görsel devamlılık için):\n${previousSceneSummary.trim()}\n` : ''}
${styleNote}

HEDEF ARALIK: ${formatMMSS(safeStart)} (${safeStart.toFixed(2)}s) – ${formatMMSS(safeEnd)} (${safeEnd.toFixed(2)}s)
BAŞLANGIÇ SAHNE NUMARASI: ${firstNum}
MAKSİMUM SAHNE SÜRESİ: ${maxSec} saniye (HİÇBİR SAHNE ${maxSec} SANİYEYİ GEÇMEMELİDİR!)
${countInstruction}

ZAMAN DAMGALI TRANSKRİPT BÖLÜMÜ:
${transcriptBlock}

Yukarıdaki aralık (${safeStart.toFixed(2)}s -> ${safeEnd.toFixed(2)}s) için kesintisiz, her sahnesi en fazla ${maxSec} saniye süren, dönemsel olarak %100 tutarlı, 16:9 2K görsel promptlu sahne planını JSON dizisi olarak üret.`;

      type RawSceneItem = {
        title?: string;
        era?: string;
        startSec?: number;
        endSec?: number;
        imagePrompt?: string;
      };

      type NormalizedScene = {
        title: string;
        era: string;
        startSec: number;
        endSec: number;
        durationSec: number;
        imagePrompt: string;
      };

      const ensurePromptTags = (rawPrompt: string): string => {
        let imgPrompt = String(rawPrompt || '').trim();
        if (!/16:9/i.test(imgPrompt)) {
          imgPrompt += ', 16:9 widescreen aspect ratio';
        }
        if (!/\b2k\b/i.test(imgPrompt)) {
          imgPrompt += ', 2K resolution';
        }
        return imgPrompt;
      };

      const normalizeWindowScenes = (
        items: RawSceneItem[],
        winStart: number,
        winEnd: number,
        fallbackLabelStart: number
      ): NormalizedScene[] => {
        const n = items.length;
        const dur = Math.max(0.5, winEnd - winStart);
        const minStep = dur >= n * 2.5 ? 2.5 : Number((dur / n).toFixed(2));
        const starts: number[] = new Array(n).fill(winStart);
        starts[0] = Number(winStart.toFixed(2));

        for (let i = 1; i < n; i++) {
          const rawStart = Number(items[i].startSec);
          const minAllowed = Number((starts[i - 1] + minStep).toFixed(2));
          const maxAllowed = Number((winEnd - (n - i) * minStep).toFixed(2));
          let candidate = Number.isFinite(rawStart)
            ? rawStart
            : Number((winStart + (i / n) * dur).toFixed(2));
          if (candidate < minAllowed) candidate = minAllowed;
          if (candidate > maxAllowed) candidate = maxAllowed;
          starts[i] = Number(candidate.toFixed(2));
        }

        return items.map((item, idx) => {
          const sSec = starts[idx];
          const eSec = idx < n - 1 ? starts[idx + 1] : Number(winEnd.toFixed(2));
          const durSec = Number(Math.max(0.5, eSec - sSec).toFixed(2));
          return {
            title:
              String(item.title || '')
                .replace(/^\d+\s*[.):\-]\s*/, '')
                .trim() || `Sahne ${fallbackLabelStart + idx}`,
            era: String(item.era || '').trim(),
            startSec: sSec,
            endSec: eSec,
            durationSec: durSec,
            imagePrompt: ensurePromptTags(item.imagePrompt || ''),
          };
        });
      };

      const parseJsonScenes = (text: string): RawSceneItem[] => {
        const cleaned = (text || '[]')
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/```\s*$/i, '')
          .trim();
        const parsed = JSON.parse(cleaned) as RawSceneItem[];
        return Array.isArray(parsed)
          ? parsed.filter((item) => item && typeof item.imagePrompt === 'string' && item.imagePrompt.trim())
          : [];
      };

      const ai = createGenAIClient(apiKey);
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: sceneResponseSchema,
        },
      });

      const rawItems = parseJsonScenes(response.text ?? '[]');
      if (rawItems.length === 0) {
        res.status(500).json({
          error: 'Hydrogen bu bölüm için sahne planı döndürmedi. Lütfen tekrar deneyin.',
        });
        return;
      }

      const initialScenes = normalizeWindowScenes(rawItems, safeStart, safeEnd, firstNum);

      // Automatic split pass: if any scene STILL exceeds maxSec (e.g., > 60s), ask Hydrogen to break
      // that exact stretch into multiple distinct visual angles (wide -> medium -> close-up detail)
      // and apply a deterministic camera-angle split fallback if anything still exceeds maxSec.
      const framingFallbacks = [
        { suffix: ' (Geniş Plan)', prefix: 'Wide establishing cinematic view, ' },
        { suffix: ' (Orta Plan)', prefix: 'Medium cinematic perspective focusing on subjects and period atmosphere, ' },
        { suffix: ' (Yakın Detay)', prefix: 'Intimate close-up documentary detail shot highlighting authentic period textures and objects, ' },
        { suffix: ' (Alternatif Açı)', prefix: 'Atmospheric low-angle cinematic documentary shot, ' },
      ];

      const enforceDeterministicCap = (sc: NormalizedScene): NormalizedScene[] => {
        if (sc.durationSec <= maxSec + 0.5) return [sc];
        const parts = Math.max(2, Math.ceil(sc.durationSec / maxSec));
        const partDur = sc.durationSec / parts;
        const out: NormalizedScene[] = [];
        for (let p = 0; p < parts; p++) {
          const pStart = p === 0 ? sc.startSec : Number((sc.startSec + p * partDur).toFixed(2));
          const pEnd = p === parts - 1 ? sc.endSec : Number((sc.startSec + (p + 1) * partDur).toFixed(2));
          const fb = framingFallbacks[p % framingFallbacks.length];
          out.push({
            title: `${sc.title}${fb.suffix}`,
            era: sc.era,
            startSec: pStart,
            endSec: pEnd,
            durationSec: Number(Math.max(0.5, pEnd - pStart).toFixed(2)),
            imagePrompt: ensurePromptTags(p === 0 ? sc.imagePrompt : `${fb.prefix}${sc.imagePrompt}`),
          });
        }
        return out;
      };

      const refinedScenes: NormalizedScene[] = [];
      let splitApiCallsUsed = 0;
      const MAX_SPLIT_CALLS_PER_BLOCK = 5;

      for (const sc of initialScenes) {
        if (sc.durationSec <= maxSec + 0.5) {
          refinedScenes.push(sc);
          continue;
        }

        const targetParts = Math.max(2, Math.ceil(sc.durationSec / Math.min(36, maxSec - 10)));
        if (splitApiCallsUsed < MAX_SPLIT_CALLS_PER_BLOCK) {
          splitApiCallsUsed++;
          try {
            const subSegs = windowSegments.filter(
              (seg) => Number(seg.endSec) > sc.startSec + 0.05 && Number(seg.startSec) < sc.endSec
            );
            const subTranscript =
              subSegs.length > 0
                ? subSegs
                    .map(
                      (s) =>
                        `[${formatMMSS(Number(s.startSec))} - ${formatMMSS(Number(s.endSec))}] (${Number(s.startSec).toFixed(1)}s) ${String(s.text || '').trim()}`
                    )
                    .join('\n')
                : `[${formatMMSS(sc.startSec)} - ${formatMMSS(sc.endSec)}] (${sc.startSec.toFixed(1)}s) ${sc.title}`;

            const splitPrompt = `Aşağıdaki belgesel sahnesi ${Math.round(sc.durationSec)} saniye sürdüğü için ${maxSec} saniyelik üst sınırı aşıyor.
Görevin: Bu aralığı (${sc.startSec.toFixed(2)}s – ${sc.endSec.toFixed(2)}s) tam olarak ${targetParts} adet FARKLI ve kesintisiz alt sahneye bölmek!

MEVCUT SAHNE: "${sc.title}" (Dönem: ${sc.era || 'Belgesel dönemi'})
${styleNote}

KURALLAR:
- Tam olarak ${targetParts} sahne üret; her biri en fazla ${maxSec} saniye (ideal ~${Math.round(sc.durationSec / targetParts)} sn) olsun.
- İlk alt sahne ${sc.startSec.toFixed(2)}s'de başlasın, son alt sahne ${sc.endSec.toFixed(2)}s'de bitsin.
- Her alt sahnede FARKLI bir kamera açısı, kadraj ve görsel odak kullan (örn. 1. geniş ortam planı, 2. karakter/eylem orta planı, 3. yakın dönem detayı / nesne / mimari).
- Dönemsel doğruluğu ve anakronizm yasağını %100 koru, her prompt 16:9 2K İngilizce olsun.

BU ARALIĞIN TRANSKRİPTİ:
${subTranscript}`;

            const splitRes = await ai.models.generateContent({
              model,
              contents: splitPrompt,
              config: {
                systemInstruction,
                responseMimeType: 'application/json',
                responseSchema: sceneResponseSchema,
              },
            });

            const splitRaw = parseJsonScenes(splitRes.text ?? '[]');
            if (splitRaw.length >= 2) {
              const splitNormalized = normalizeWindowScenes(splitRaw, sc.startSec, sc.endSec, firstNum);
              for (const sub of splitNormalized) {
                refinedScenes.push(...enforceDeterministicCap(sub));
              }
              continue;
            }
          } catch (splitErr) {
            console.warn(
              '[/api/generate-scene-plan] oversized scene split fallback used:',
              splitErr instanceof Error ? splitErr.message : splitErr
            );
          }
        }

        // Deterministic fallback if split API call failed or budget reached
        refinedScenes.push(...enforceDeterministicCap(sc));
      }

      const scenes = refinedScenes.map((sc, idx) => ({
        orderNumber: firstNum + idx,
        title: sc.title,
        era: sc.era,
        startSec: sc.startSec,
        endSec: sc.endSec,
        durationSec: sc.durationSec,
        imagePrompt: sc.imagePrompt,
      }));

      res.json({ scenes, modelUsed: model });
    } catch (err) {
      const parsedErr = parseErrorStatus(err);
      console.error('[/api/generate-scene-plan] error:', parsedErr.upstreamStatus, parsedErr.code, parsedErr.message);
      res.status(parsedErr.httpStatus).json({
        error: parsedErr.message,
        code: parsedErr.code,
        upstreamStatus: parsedErr.upstreamStatus,
        retryable: parsedErr.retryable,
      });
    }
  });

  // Always return JSON for /api middleware errors (e.g. PayloadTooLargeError / invalid JSON)
  app.use(
    '/api',
    (
      err: { status?: number; type?: string; message?: string },
      _req: Request,
      res: Response,
      _next: express.NextFunction
    ) => {
      const status = err?.type === 'entity.too.large' ? 413 : err?.status && err.status < 500 ? err.status : 500;
      const msg =
        err?.type === 'entity.too.large'
          ? 'Gönderilen ses parçası sunucu boyut sınırını (32 MB) aştı.'
          : err?.message || 'API isteği işlenirken beklenmeyen bir hata oluştu.';
      console.error('[/api middleware error]:', status, msg);
      res.status(status).json({ error: msg });
    }
  );

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Belgesel Kurgu Asistanı sunucusu http://0.0.0.0:${PORT} adresinde hazır.`);
  });
  server.requestTimeout = 300_000;
  server.headersTimeout = 310_000;
  server.keepAliveTimeout = 65_000;
}

startServer().catch((err) => {
  console.error('Sunucu başlatılamadı:', err);
  process.exit(1);
});
