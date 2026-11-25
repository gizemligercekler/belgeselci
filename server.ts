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
