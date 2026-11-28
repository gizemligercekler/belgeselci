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
      const idealMinSec = Math.min(18, Math.max(6, Math.round(maxSec * 0.45)));
      const idealMaxSec = Math.max(idealMinSec + 4, Math.min(42, Math.round(maxSec * 0.85)));
      const autoMinScenes = Math.max(minScenesForCap, Math.ceil(windowDur / idealMaxSec));
      const autoMaxScenes = Math.max(autoMinScenes + 2, Math.round(windowDur / Math.max(8, idealMinSec)));
      const explicitTarget =
        Number.isFinite(Number(targetSceneCount)) && Number(targetSceneCount) > 0
          ? Math.max(minScenesForCap, Math.min(80, Math.round(Number(targetSceneCount))))
          : 0;

      const countInstruction =
        explicitTarget > 0
          ? `Bu bölüm (${Math.round(windowDur)} sn) için en az ${minScenesForCap}, yaklaşık ${explicitTarget} sahne oluştur. HİÇBİR sahne ${maxSec} saniyeyi geçmemelidir.`
          : `Bu bölümün (${Math.round(windowDur)} sn) anlatım akışına ve konu değişimlerine göre ideal sahne sayısına karar ver (ideal sahne süresi ${idealMinSec}–${idealMaxSec} saniye arasıdır; bu bölüm için en az ${autoMinScenes}, ideal olarak ${autoMinScenes}–${autoMaxScenes} sahne üret ve HİÇBİR sahne ${maxSec} saniyeyi geçmesin).`;

      const transcriptBlock = windowSegments
        .map(
          (s) =>
            `[${formatMMSS(Number(s.startSec))} - ${formatMMSS(Number(s.endSec))}] (${Number(s.startSec).toFixed(1)}s) ${String(s.text || '').trim()}`
        )
        .join('\n');

      const styleNote = styleDirection.trim()
        ? `KULLANICININ ÖZEL GÖRSEL STİL TERCİHİ (Not: Sinema/film/çözünürlük yasaklı kelimelerini kullanmadan belgesel fotoğraf diliyle uygula): ${styleDirection.trim()}`
        : 'GÖRSEL STİL: Gerçekçi tarihsel belgesel fotoğrafçılığı (realistic historical documentary photograph, authentic editorial documentary photography, natural lighting, authentic weathered textures, muted earthy palette, full-frame edge-to-edge photograph).';

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
              description: 'Historical century/year and region in Turkish (e.g. "7. Yüzyıl / 610, Mekke" or "1959, Michigan ABD").',
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
              description:
                'Single-paragraph 55-85 word English positive-only historical documentary photograph prompt ending with "full-frame edge-to-edge photograph", containing zero cinema/film/resolution terms and zero negative "no ..." phrases.',
            },
          },
          required: ['title', 'era', 'startSec', 'endSec', 'imagePrompt'],
        },
      };

      const systemInstruction = `Sen ödüllü bir belgesel yönetmeni, tarih danışmanı ve Nano Banana / Gemini görsel prompt uzmanısın.
Görevin, sana verilen zaman damgalı Türkçe belgesel transkriptinden, hem her sahnenin ekranda kalacağı kesin saniye aralığını hem de her sahne için tarihsel olarak %100 doğru, Nano Banana / Gemini görsel üretim araçlarına optimize edilmiş İngilizce görsel promptlarını (imagePrompt) oluşturmaktır.

GÖRSEL PROMPT ÜRETİM KURALLARI (NANO BANANA / GEMINI OPTİMİZASYONU — KESİNLİKLE UYULACAK):

1. KESİN YASAKLI KELİMELER (Siyah şerit / sinema bandı ve teknik çakışma engeli):
"imagePrompt" içinde aşağıdaki kelimeleri ve türevlerini ASLA kullanma:
- Sinema / çerçeve tetikleyicileri: "film", "film still", "film frame", "movie", "cinema", "cinematic", "cinematography", "anamorphic", "widescreen", "letterbox", "black bars", "borders", "vignette", "screenshot"
- Teknik boyut ve çözünürlük ifadeleri: "16:9", "aspect ratio", "1K", "2K", "4K", "8K", "resolution", "HD", "UHD"
(En-boy oranı ve çözünürlük arayüzden ayarlanır; prompt içine kesinlikle yazılmaz.)

2. YERİNE KULLANILACAK BELGESEL FOTOĞRAFÇILIK DİLİ:
Sinema/film dili yerine her zaman belgesel fotoğrafçılık dili kullan:
- "realistic historical documentary photograph"
- "authentic editorial documentary photography"
- "wide-angle photograph" / "medium shot photograph" / "close-up photograph"
- "natural lighting", "authentic weathered textures", "muted earthy palette"
- Her promptun sonunu KESİNLİKLE şu pozitif tam ekran ifadesiyle bitir: "full-frame edge-to-edge photograph"

3. POZİTİF ANLATIM KURALI VE TARİHSEL DOĞRULUK (Olumsuz "no ..." listesi KESİNLİKLE YASAK):
- Promptların içine "no text", "no watermark", "no black bars", "no letterbox", "no borders", "no anachronisms", "no eyeglasses", "no modern buildings", "no electricity", "no printed books" gibi "no ..." veya "without ..." ile başlayan OLUMSUZ ifadeler ASLA yazma.
- Her sahnenin geçtiği yüzyılı, yılı ve bölgeyi transkriptten tespit et ve "era" alanına Türkçe yaz (örn: "7. Yüzyıl / 610, Mekke", "1959, Michigan ABD").
- Seçilen dönemde henüz icat edilmemiş hiçbir nesneyi (örn. 13. yy öncesi gözlük, 1850 öncesi camlı gaz lambası veya elektrik, matbaa öncesi basılı kitap) sahneye koyma; bunu olumsuz ifade yazmadan SADECE o döneme ait gerçek unsurları pozitif betimleyerek sağla:
  * Aydınlatma: "illuminated solely by flickering clay olive oil lamps" / "pale silver moonlight" / "natural daylight"
  * Çevre: "surrounded exclusively by ancient mudbrick dwellings and untouched desert hills"
  * Yazı araçları: "handwritten aged parchment scrolls and carved reed pens"
  * 9. YÜZYIL ÖNCESİ ARAPÇA YAZI KURALI (MS 800 ÖNCESİ — 6., 7. ve 8. YÜZYIL): Sahne 9. yüzyıldan önce (MS 800 öncesi) geçiyorsa ve promptta Arapça yazı, harf, hat, el yazması, Kur'an sayfası veya "Arabic" ile ilgili herhangi bir sözcük geçiyorsa, bunu MUTLAKA "unvocalized Arabic" şeklinde pozitif olarak yaz (örn. "early unvocalized Arabic Hijazi script", "handwritten unvocalized Arabic lettering on aged parchment"). Çünkü 9. yüzyıl öncesinde hareke yoktu; olumsuz "no diacritics / no harakat" yazma, doğrudan "unvocalized Arabic" kullan.
  * İnsan yüzü: gözlükten hiç bahsetmeden sadece doğal yüz, sakal, göz ve döneme uygun giysi dokularını tarif et.

4. GÜVENLİK FİLTRESİ, DİNİ HASSASİYET VE BELGESEL DİLİ:
- Savaş, yangın, trajedi veya çocuk içeren tarihsel sahneleri her zaman saygılı, atmosferik, uzak veya siluet açılarla ve grafik şiddet içermeden (non-graphic) betimle.
- HZ. MUHAMMED SAHNE KURALI (YALNIZCA HZ. MUHAMMED İÇİN KESİN VE TAVİZSİZ):
  * Bu kural YALNIZCA İslam peygamberi Hz. Muhammed (Resulullah / Peygamber Efendimiz / Son Peygamber) için geçerlidir. Hz. İsa, Hz. Musa, Musa Peygamber, Hz. İbrahim, Hz. Yusuf gibi diğer peygamberlerin sahnelerinde zorunlu arkadan çekim uygulanmaz; normal belgesel kadrajı kullanılabilir.
  * Eğer sahne veya görsel Hz. Muhammed hakkında ise ve sahnede kendisi görünüyorsa, promptta MUTLAKA "from behind" ifadesi yer almalı ve kadraj KESİNLİKLE arkadan çekilmiş olmalıdır (örn. "photographed strictly from behind", "rear-view historical documentary photograph from behind", "back turned away from the camera", "distant rear silhouette viewed from behind").
  * Hz. Muhammed'in yüzü, gözleri, sakalı, yüz ifadesi, önden görünümü veya yan profili ASLA betimlenmemelidir; sadece arkadan duruşu, omuzları, döneme uygun sade yün/keten cübbesinin arkası, sarığı/başörtüsünün arkası ve baktığı manzara/ufuk pozitif olarak tarif edilmelidir (olumsuz "no face" kalıbı yazmadan, tamamen arkadan kadrajla).

5. UZUNLUK, FORMAT VE ÖRNEK PROMPT:
- "title" alanı kısa, anlaşılır TÜRKÇE sahne başlığı olmalıdır (dosya adı olarak kullanılacak).
- "imagePrompt" alanı TEK PARAGRAF, akıcı İngilizce ve KESİNLİKLE 55–85 kelime arasında olmalıdır.
- ÖRNEK DOĞRU PROMPT:
  "Wide-angle historical documentary photograph from behind of a forty-year-old Arab man in a rough woven wool cloak and headwrap descending steep jagged rocky slopes outside Mecca on a summer night in 610 CE, silhouette against barren desert ridges and distant mudbrick dwellings below, illuminated solely by pale silver moonlight, muted earthy nocturnal palette, authentic 7th-century Hijazi textiles and weathered stone textures, full-frame edge-to-edge photograph"

ZAMANLAMA VE SÜRE ÜST SINIRI KURALLARI (KESİN):
- İlk sahne KESİNLİKLE ${safeStart.toFixed(2)} saniyesinde başlamalıdır.
- Son sahne KESİNLİKLE ${safeEnd.toFixed(2)} saniyesinde bitmelidir (aralığın tamamını dengeli biçimde kapla; son sahneyi uzatma!).
- Sahneler arasında HİÇ boşluk veya çakışma olmamalıdır: her sahnenin startSec değeri bir önceki sahnenin endSec değerine eşit olmalıdır (kesintisiz akış).
- KESİN ÜST SINIR: HİÇBİR sahne ${maxSec} saniyeden uzun OLMAMALIDIR (endSec - startSec <= ${maxSec})!
- İdeal sahne süresi ${idealMinSec}–${idealMaxSec} saniye arasıdır (en az 5 saniye, en fazla ${maxSec} saniye).
- Anlatıcı aynı konudan ${maxSec} saniyeden uzun bahsediyorsa, o bölümü mutlaka farklı fotoğraf açılarıyla birden fazla sahneye böl (örn. 1. geniş açı mekan fotoğrafı -> 2. orta plan sahne fotoğrafı -> 3. yakın plan dönem detayı fotoğrafı). Tek bir görsel asla ${maxSec} saniyeden uzun ekranda kalmamalıdır.`;

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

Yukarıdaki aralık (${safeStart.toFixed(2)}s -> ${safeEnd.toFixed(2)}s) için kesintisiz, her sahnesi en fazla ${maxSec} saniye süren, 55-85 kelimelik, yasaklı sinema/çözünürlük/olumsuz "no..." ifadelerinden tamamen arındırılmış, "full-frame edge-to-edge photograph" ile biten, dönemsel olarak %100 doğru sahne planını JSON dizisi olarak üret.`;

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

      const EXPLICIT_MUHAMMAD_RE =
        /(?:^|[^\p{L}])(?:hz\.?\s*muhamm?[ae][dt]|muhamm?[ae][dt]|mohamm?[ae][dt]|resulullah|rasulullah|peygamber\s+efendimiz|peygamberimiz|son\s+peygamber|son\s+el[çc]i|[iİı]slam\s+peygamberi|prophet\s+muhamm?[ae][dt])(?=$|[^\p{L}])/iu;
      const GENERIC_PROPHET_RE =
        /(?:^|[^\p{L}])(?:peygamber(?:in|e|i|'in|'e|'i)?|the\s+prophet)(?=$|[^\p{L}])/iu;
      const OTHER_PROPHET_RE =
        /(?:^|[^\p{L}])(?:[iİ]sa|musa|[iİ]brahim|yusuf|davud|davut|süleyman|nuh|adem|yahya|zekeriya|eyy?[üu]b|eyüp|yakup|yakub|[iİ]smail|[iİ]shak|yunus|harun|lut|salih|hud|şuayb|[iİ]dris|[iİ]lyas|jesus|christ|moses|abraham|joseph|david|solomon|noah|adam|john\s+the\s+baptist|jonah|aaron|isaac|ishmael|jacob|elijah)(?=$|[^\p{L}])/iu;
      const ISLAMIC_CONTEXT_RE =
        /(?:^|[^\p{L}])(?:muhamm?[ae][dt]|mohamm?[ae][dt]|resulullah|mekke|mecca|medine|medina|hira|hicaz|hijaz|kabe|kaaba|hicret|hijra|[iİ]slam)(?=$|[^\p{L}])/iu;

      const isProphetMuhammadScene = (sceneText: string): boolean => {
        if (EXPLICIT_MUHAMMAD_RE.test(sceneText)) return true;
        if (OTHER_PROPHET_RE.test(sceneText)) return false;
        if (
          GENERIC_PROPHET_RE.test(sceneText) &&
          (ISLAMIC_CONTEXT_RE.test(sceneText) || ISLAMIC_CONTEXT_RE.test(documentaryContext))
        ) {
          return true;
        }
        return false;
      };

      const PRE_9TH_CENTURY_RE =
        /(?:^|[^\p{L}\d])(?:[1-8]\.\s*(?:yüzyıl|yy)|(?:[1-8](?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth)[\s-]+century|(?:ms|m\.s\.|ce|ad)\s*[1-7]\d{2}|[1-7]\d{2}\s*(?:ce|ad|yılı(?:nda)?|'ler|'lü|'lar)|m\.?ö\.?|bce|bc)(?=$|[^\p{L}\d])/iu;
      const NINTH_OR_LATER_RE =
        /(?:^|[^\p{L}\d])(?:(?:9|[12]\d)\.\s*(?:yüzyıl|yy)|(?:9th|[12]\d(?:st|nd|rd|th)|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty-first)[\s-]+century|(?:ms|m\.s\.|ce|ad)?\s*(?:[89]\d{2}|[12]\d{3}))(?=$|[^\p{L}\d])/iu;

      const isPreNinthCenturyScene = (
        era: string,
        title: string,
        promptText: string,
        transcript: string
      ): boolean => {
        const cleanEra = String(era || '').trim();
        if (cleanEra) {
          if (NINTH_OR_LATER_RE.test(cleanEra)) return false;
          if (PRE_9TH_CENTURY_RE.test(cleanEra) || /\b[1-7]\d{2}\b/.test(cleanEra)) return true;
        }
        const combined = `${title} ${promptText} ${transcript}`;
        if (NINTH_OR_LATER_RE.test(combined)) return false;
        return PRE_9TH_CENTURY_RE.test(combined);
      };

      // Deterministic sanitizer enforcing all Nano Banana / Gemini rules even if LLM slips a term
      const sanitizeDocumentaryPrompt = (
        rawPrompt: string,
        sceneTitle = '',
        sceneTranscript = '',
        sceneEra = ''
      ): string => {
        let p = String(rawPrompt || '')
          .replace(/\s+/g, ' ')
          .trim();

        // 1. Strip any negative "no ..." or "without ..." clauses (forbidden by Rule 3)
        p = p.replace(
          /(?:^|[.,;]\s*|\s+)(?:no|without)\s+(?:text|watermarks?|black\s+bars?|letterbox(?:ing|ed)?|borders?|frames?|vignettes?|anachronisms?|eyeglasses|spectacles|glasses|glass\s+lamps?|kerosene\s+lamps?|gas\s+lamps?|electric(?:ity|\s+lights?|\s+lamps?)?|printed\s+books?|modern\s+[a-z][a-z\s-]{0,28}|contemporary\s+[a-z][a-z\s-]{0,28}|logos?|captions?|subtitles?|signatures?|artifacts?|people|crowds?|face|faces|facial\s+features?|diacritics?|diacritical\s+marks?|harakat|vowel\s+marks?|vowels?)\b/gi,
          ''
        );
        // Catch any remaining comma-delimited ", no <short phrase>" tails
        p = p.replace(/,\s*no\s+[a-z0-9][a-z0-9\s-]{1,32}(?=,|\.|$)/gi, '');

        // 2. Replace cinema/film multi-word triggers with documentary photography equivalents
        p = p
          .replace(/\b(?:cinematic\s+)?(?:film\s+still|film\s+frame|movie\s+still|movie\s+frame|cinema\s+frame)\b/gi, 'historical documentary photograph')
          .replace(/\bcinematic\s+lighting\b/gi, 'natural lighting')
          .replace(/\bcinematic\s+shot\b/gi, 'documentary photograph')
          .replace(/\bcinematic\s+view\b/gi, 'wide-angle documentary photograph')
          .replace(/\bcinematic\s+photograph(?:y)?\b/gi, 'documentary photograph')
          .replace(/\bcinematography\b/gi, 'editorial documentary photography')
          // Strip remaining banned cinema/frame words (Rule 1)
          .replace(/\b(?:cinematic|cinema|movie|movies|film|films|anamorphic|widescreen|letterbox(?:ed|ing)?|black\s+bars?|borders?|vignette(?:d|ing)?|screenshots?)\b/gi, '')
          // Strip banned aspect ratio & resolution words (Rule 1)
          .replace(/\b(?:16\s*:\s*9|aspect\s+ratio|1k|2k|4k|8k|resolution|uhd|hd)\b/gi, '');

        // 3. Enforce strict rear-view ("from behind") framing ONLY for Prophet Muhammad scenes
        const isProphetScene = isProphetMuhammadScene(`${sceneTitle} ${p} ${sceneTranscript}`);
        if (isProphetScene) {
          // Remove any accidental front-facing or facial descriptions positively
          p = p
            .replace(/\b(?:front[\s-]*view|facing\s+the\s+camera|looking\s+at\s+the\s+camera|side\s+profile|close-up\s+portrait|portrait)\b/gi, 'rear-view photograph from behind')
            .replace(/\bwith\s+(?:a\s+)?(?:weathered|serene|calm|contemplative|bearded|aged|wise|kind|solemn|earnest)?\s*(?:face|expression|facial\s+expression|eyes|beard)(?:\s+and\s+(?:a\s+)?(?:grey|dark|short|long|neatly\s+trimmed)?\s*(?:beard|eyes|expression))?\b/gi, '')
            .replace(/\b(?:facial\s+features?|facial\s+expression)\b/gi, '');

          if (!/\bfrom\s+behind\b/i.test(p)) {
            if (/\bphotograph\b/i.test(p)) {
              p = p.replace(
                /\b(photograph)\b/i,
                '$1 from behind, back turned away from the camera,'
              );
            } else {
              p = `Rear-view historical documentary photograph from behind, back turned away from the camera, ${p}`;
            }
          }
        }

        // 4. Enforce "unvocalized Arabic" for any Arabic script/word mention before the 9th century (< 800 CE)
        if (isPreNinthCenturyScene(sceneEra, sceneTitle, p, sceneTranscript)) {
          if (/\barabic\b/i.test(p) && !/\bunvocalized\s+(?:early\s+)?arabic\b/i.test(p)) {
            p = p.replace(
              /\b(?:(early|ancient|archaic|classical|handwritten|carved|engraved)\s+)?arabic\b/gi,
              (_m, adj) => (adj ? `${adj} unvocalized Arabic` : 'unvocalized Arabic')
            );
          } else if (
            !/\bunvocalized\s+arabic\b/i.test(p) &&
            /\b(?:kufic|hijazi\s+script|islamic\s+calligraphy|quranic\s+(?:manuscript|script|scroll|text|calligraphy))\b/i.test(p)
          ) {
            p = p.replace(
              /\b(kufic|hijazi\s+script|islamic\s+calligraphy|quranic\s+(?:manuscript|script|scroll|text|calligraphy))\b/i,
              'unvocalized Arabic $1'
            );
          }
        }

        // 5. Remove any existing full-frame edge-to-edge suffix so we append cleanly once at the end
        p = p.replace(/(?:,\s*|\.\s*|\s+)?full[\s-]*frame\s+edge[\s-]*to[\s-]*edge\s+photograph\.?$/i, '');

        // 6. Normalize punctuation & whitespace artifacts after stripping
        p = p
          .replace(/\s+([,.;:])/g, '$1')
          .replace(/,\s*,+/g, ',')
          .replace(/\.\s*,/g, ',')
          .replace(/,\s*\./g, '.')
          .replace(/^[,.;:\s-]+/, '')
          .replace(/[,.;:\s-]+$/, '')
          .replace(/\b(photograph|documentary|historical|unvocalized)\s+\1\b/gi, '$1')
          .replace(/\s{2,}/g, ' ')
          .trim();

        if (!p) {
          p = isProphetScene
            ? 'Wide-angle historical documentary photograph from behind, back turned away from the camera, natural lighting and weathered historical textures'
            : 'Authentic editorial documentary photograph with natural lighting and weathered historical textures';
        }

        return `${p}, full-frame edge-to-edge photograph`;
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
          const cleanTitle =
            String(item.title || '')
              .replace(/^\d+\s*[.):\-]\s*/, '')
              .trim() || `Sahne ${fallbackLabelStart + idx}`;
          const sceneSegText = windowSegments
            .filter((seg) => Number(seg.endSec) > sSec + 0.05 && Number(seg.startSec) < eSec)
            .map((seg) => String(seg.text || ''))
            .join(' ');
          const cleanEra = String(item.era || '').trim();
          return {
            title: cleanTitle,
            era: cleanEra,
            startSec: sSec,
            endSec: eSec,
            durationSec: durSec,
            imagePrompt: sanitizeDocumentaryPrompt(item.imagePrompt || '', cleanTitle, sceneSegText, cleanEra),
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
      // that exact stretch into multiple distinct photography angles (wide -> medium -> close-up detail)
      // and apply a deterministic documentary-photography split fallback if anything still exceeds maxSec.
      const framingFallbacks = [
        { suffix: ' (Geniş Plan)', prefix: 'Wide-angle historical documentary photograph, ' },
        { suffix: ' (Orta Plan)', prefix: 'Medium shot historical documentary photograph capturing subjects and authentic period atmosphere, ' },
        { suffix: ' (Yakın Detay)', prefix: 'Close-up historical documentary photograph focusing on authentic weathered textures and period objects, ' },
        { suffix: ' (Alternatif Açı)', prefix: 'Low-angle authentic editorial documentary photograph, ' },
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
            imagePrompt: sanitizeDocumentaryPrompt(
              p === 0 ? sc.imagePrompt : `${fb.prefix}${sc.imagePrompt}`,
              sc.title,
              '',
              sc.era
            ),
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

        const splitTargetDur = Math.max(8, Math.min(36, Math.round(maxSec * 0.72)));
        const targetParts = Math.max(2, Math.ceil(sc.durationSec / splitTargetDur));
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
- Her alt sahnede FARKLI bir fotoğraf açısı ve odak kullan (örn. 1. wide-angle photograph, 2. medium shot photograph, 3. close-up photograph).
- Sinema/film/çözünürlük kelimeleri ve olumsuz "no ..." kalıpları KESİNLİKLE yasak; her prompt 55-85 kelime, pozitif tarihsel betimlemeli ve "full-frame edge-to-edge photograph" ile bitsin.
- Sahne yalnızca Hz. Muhammed hakkında ise tüm alt sahnelerde MUTLAKA "from behind" (arkadan görünüm) kullan ve yüzünü kesinlikle betimleme (Hz. İsa, Hz. Musa gibi diğer peygamberler bu kurala dahil değildir).
- Sahne 9. yüzyıl öncesindeyse ve Arapça yazı/harf/hat geçiyorsa MUTLAKA "unvocalized Arabic" ifadesini kullan.

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

  // 4. Extract Selective Dialogue & Sacred Scripture Subtitles (.SRT) via Gemini 4 Hydrogen (Free Tier)
  app.post('/api/extract-dialogue-subtitles', async (req: Request, res: Response) => {
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
        indexedSegments = [],
        documentaryContext = '',
        model = 'gemini-4-hydrogen',
      } = req.body as {
        indexedSegments?: Array<{ idx: number; startSec: number; endSec: number; text: string }>;
        documentaryContext?: string;
        model?: string;
      };

      if (!Array.isArray(indexedSegments) || indexedSegments.length === 0) {
        res.status(400).json({ error: 'Altyazı çıkarılacak transkript bölümü boş.' });
        return;
      }

      const segByIdx = new Map<number, { idx: number; startSec: number; endSec: number; text: string }>();
      for (const s of indexedSegments) {
        if (s && Number.isFinite(Number(s.idx))) {
          segByIdx.set(Number(s.idx), {
            idx: Number(s.idx),
            startSec: Number(s.startSec) || 0,
            endSec: Number(s.endSec) || 0,
            text: String(s.text || '').trim(),
          });
        }
      }

      const transcriptLines = indexedSegments
        .map(
          (s) =>
            `[#${s.idx} | ${formatMMSS(Number(s.startSec))}-${formatMMSS(Number(s.endSec))} (${Number(s.startSec).toFixed(2)}s-${Number(s.endSec).toFixed(2)}s)] ${String(s.text || '').trim()}`
        )
        .join('\n');

      const systemInstruction = `Sen ödüllü bir Türkçe belgesel editörü, dinler tarihi araştırmacısı ve altyazı uzmanısın.
Görevin, sana verilen zaman damgalı Türkçe belgesel transkripti içinden YALNIZCA videonun üzerine özel sinematik altyazı olarak basılacak en vurucu doğrudan konuşmaları (diyalogları) ve kutsal metin / tarihi metin alıntılarını ayıklamaktır.

HANGİ SATIRLARI SEÇECEKSİN (SADECE BUNLAR):
1. "diyalog": Bir kralın, peygamberin, rahibin, komutanın, bilginin veya tarihi bir şahsın doğrudan ağzından aktarılan sözler ve karşılıklı soru-cevap diyalogları (örn. "Kral şöyle dedi: ...", "Rahip ona şu cevabı verdi: ...", "Peygamber buyurdu ki: ...").
2. "ayet": Kur'an-ı Kerim ayetleri, Tevrat pasajları, İncil / Zebur ayetleri veya kutsal kitaplardan doğrudan yapılan alıntı/okumalar.
3. "alinti": Doğrudan metinden okunan önemli tarihi mektup, ferman, kitabe veya klasik eser cümleleri (yalnızca gerçekten doğrudan alıntı okunuyorsa).

KESİNLİKLE SEÇMEYECEKLERİN:
- Normal belgesel dış ses anlatımı, tarihsel açıklama, özet, yorum veya geçiş cümlelerini ASLA alma!
- Çok seçici ol: 1 saatlik bir belgeselin tamamında genellikle yalnızca 5–18 satır (20 dakikalık bir bölümde ortalama 1–6 satır) gerçekten bu kapsama girer. Eğer verilen bölümde hiç doğrudan diyalog veya kutsal metin alıntısı yoksa KESİNLİKLE boş dizi ([]) döndür; zorla satır uydurma!

KAYNAK / REFERANS ("source") KURALLARI — ÇOK ÖNEMLİ:
- "ayet" türü için: Okunan ayetin Kur'an-ı Kerim, Tevrat, İncil veya Zebur'da TAM OLARAK hangi sure/kitap ve bölüm:ayet numarasında geçtiğini tespit etmeye çalış!
  * Transkriptte geçiyorsa VEYA ayet metninden kesin olarak tanıyabiliyorsan tam referansı kısa Türkçe biçimde yaz:
    - Kur'an-ı Kerim örnekleri: "Bakara: 15", "Âl-i İmrân: 189", "Enfal: 30", "Yûsuf: 4" (aralık varsa "Bakara: 15-16").
    - Tevrat / İncil / Zebur örnekleri: "Matta 5:9", "Çölde Sayım 6:24", "Daniel 2:20", "Yaratılış 1:1", "Mezmurlar 23:1" (sadece bölüm kesinse "Matta: 1", "Çölde Sayım: 1").
  * KESİN KURAL: Ayetin tam sure/kitap + ayet/bölüm numarasından %100 emin değilsen ASLA tahmin yürütme veya numara uydurma! Ayrıca "Kur'an Ayeti", "Kur'an", "Tevrat", "İncil", "Zebur", "Kutsal Metin" gibi genel/belirsiz kitap adlarını ASLA yazma — emin olamadığında "source" alanını mutlaka BOŞ STRİNG ("") bırak! Böylece ekranda yalnızca ayetin kendisi tırnak içinde ("...") görünür.
- "diyalog" türü için: Konuşan kişinin kısa ve net Türkçe adını/unvanını yaz (örn: "Kral Nabukadnezar", "Başrahip", "Hz. Musa", "Firavun", "Kral").
- "alinti" türü için: Varsa eserin/yazarın/kitabenin spesifik adını yaz (örn: "Herodot", "Kiros Silindiri"); yoksa "" bırak.

ZAMANLAMA VE METİN KURALLARI:
- Her seçilen satır için transkriptteki tam başlangıç ve bitiş satır numaralarını (startSegmentIdx, endSegmentIdx) ve o alıntının transkript içindeki kesin saniye aralığını (startSec, endSec) ver.
- Eğer bir diyalog veya ayet uzun bir transkript satırının sadece ikinci yarısında başlıyorsa (örneğin satırın başında "Kral öfkeyle haykırdı:" veya "Tevrat'ta şöyle buyrulur:" anlatıcı girişi varsa), "text" alanına SADECE söylenen sözü/ayeti yaz ve "startSec" değerini o sözün başladığı yaklaşık saniyeye koy (ancak mutlaka ilgili segmentin [startSec .. endSec] aralığı içinde kal).
- "text" alanına anlatıcının giriş sözlerini koyma; yalnızca söylenen diyalog cümlesini veya okunan ayet/alıntı metnini düzgün Türkçe imla ile çift tırnak içinde ("...") yaz.
- Uzun bir diyalog veya karşılıklı iki kişinin konuşması varsa, her konuşmacının sözünü AYRI bir altyazı öğesi olarak ver (ekranda kolay okunsun; her öğe tercihen 1–2 cümle ve 4–12 saniye arası olsun).`;

      const prompt = `BELGESEL BAĞLAMI:
${documentaryContext.trim() || '(Genel bağlam transkriptten anlaşılacaktır.)'}

NUMARALI VE ZAMAN DAMGALI TRANSKRİPT BÖLÜMÜ:
${transcriptLines}

Yukarıdaki transkript içinden YALNIZCA doğrudan diyalogları, karşılıklı konuşmaları ve kutsal metin (Kur'an, Tevrat, İncil) / doğrudan tarihi metin alıntılarını JSON dizisi olarak çıkar. Ayetlerde kesin sure/kitap + ayet referansını ("Bakara: 15", "Matta 5:9", "Daniel 2:20", "Çölde Sayım: 1" gibi) yalnızca %100 eminsen yaz; emin değilsen "source" alanını "" (boş) bırak. Hiç uygun satır yoksa [] döndür.`;

      const ai = createGenAIClient(apiKey);
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                startSegmentIdx: {
                  type: Type.INTEGER,
                  description: 'Exact segment #idx from the input where this dialogue/verse begins.',
                },
                endSegmentIdx: {
                  type: Type.INTEGER,
                  description: 'Exact segment #idx from the input where this dialogue/verse ends.',
                },
                startSec: {
                  type: Type.NUMBER,
                  description: 'Start timestamp in seconds anchored within startSegmentIdx.',
                },
                endSec: {
                  type: Type.NUMBER,
                  description: 'End timestamp in seconds anchored within endSegmentIdx.',
                },
                source: {
                  type: Type.STRING,
                  description:
                    'For diyalog: speaker name (e.g. "Kral", "Başrahip"). For ayet: EXACT scripture citation with chapter/verse number in Turkish (e.g. "Bakara: 15", "Matta 5:9", "Çölde Sayım: 1", "Daniel 2:20") ONLY if 100% certain; NEVER output generic book names like "Kur\'an Ayeti" or "Tevrat"—use empty string "" instead when uncertain.',
                },
                text: {
                  type: Type.STRING,
                  description: 'Exact Turkish spoken quote or sacred verse text cleanly wrapped in double quotes ("...").',
                },
                kind: {
                  type: Type.STRING,
                  description: 'Category: "diyalog", "ayet", or "alinti".',
                },
              },
              required: ['startSegmentIdx', 'endSegmentIdx', 'startSec', 'endSec', 'source', 'text', 'kind'],
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
        startSegmentIdx?: number;
        endSegmentIdx?: number;
        startSec?: number;
        endSec?: number;
        source?: string;
        text?: string;
        kind?: string;
      }>;

      const rawItems = Array.isArray(parsed) ? parsed : [];
      const entries: Array<{
        startSec: number;
        endSec: number;
        source: string;
        text: string;
        kind: 'diyalog' | 'ayet' | 'alinti';
      }> = [];

      const minWinSec = indexedSegments[0].startSec;
      const maxWinSec = indexedSegments[indexedSegments.length - 1].endSec;

      const GENERIC_SCRIPTURE_ONLY_RE =
        /^(?:kur['’]?an(?:-ı\s*kerim)?(?:\s+ayeti)?|tevrat(?:\s+ayeti|\s+pasajı)?|[iİ]ncil(?:\s+ayeti)?|zebur(?:\s+ayeti)?|kutsal\s+(?:kitap|metin)|kitab-ı\s*mukaddes|eski\s+ahit|yeni\s+ahit|ayet)$/i;

      const ensureQuotedText = (raw: string): string => {
        const cleaned = raw.replace(/\s+/g, ' ').trim();
        if (!cleaned) return '';
        if (
          (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
          (cleaned.startsWith('“') && cleaned.endsWith('”'))
        ) {
          return cleaned;
        }
        const stripped = cleaned.replace(/^["“”']+/, '').replace(/["“”']+$/, '').trim();
        return stripped ? `"${stripped}"` : '';
      };

      for (const item of rawItems) {
        const rawTextVal = String(item?.text || '').replace(/\s+/g, ' ').trim();
        if (!rawTextVal) continue;

        const sIdx = Number(item.startSegmentIdx);
        const eIdx = Number(item.endSegmentIdx);
        const startSeg = segByIdx.get(sIdx);
        const endSeg = segByIdx.get(Number.isFinite(eIdx) ? Math.max(sIdx, eIdx) : sIdx) || startSeg;

        // Anchor strictly to the real Deepgram segment bounds so timestamps can NEVER drift
        let sSec = Number(item.startSec);
        let eSec = Number(item.endSec);

        if (startSeg) {
          if (!Number.isFinite(sSec) || sSec < startSeg.startSec - 0.5 || sSec > startSeg.endSec) {
            sSec = startSeg.startSec;
          } else {
            sSec = Math.max(startSeg.startSec, sSec);
          }
        } else {
          sSec = Number.isFinite(sSec) ? Math.max(minWinSec, Math.min(maxWinSec - 0.5, sSec)) : minWinSec;
        }

        if (endSeg) {
          if (!Number.isFinite(eSec) || eSec > endSeg.endSec + 0.5 || eSec <= sSec) {
            eSec = endSeg.endSec;
          } else {
            eSec = Math.min(endSeg.endSec, eSec);
          }
        } else {
          eSec = Number.isFinite(eSec) ? Math.min(maxWinSec, Math.max(sSec + 1.5, eSec)) : sSec + 3;
        }

        if (eSec <= sSec + 0.4) {
          eSec = Math.min(maxWinSec, sSec + 1.5);
        }

        const rawKind = String(item.kind || '').toLowerCase();
        const kind: 'diyalog' | 'ayet' | 'alinti' =
          rawKind === 'ayet' ? 'ayet' : rawKind === 'alinti' ? 'alinti' : 'diyalog';

        let source = String(item.source || '')
          .replace(/[:\s]+$/, '')
          .trim();

        if (kind === 'ayet') {
          // Only keep source if it's a real specific chapter/verse citation (contains a digit and is not a generic label).
          // Otherwise leave source empty so only the quoted verse ("...") is displayed.
          if (!source || !/\d/.test(source) || GENERIC_SCRIPTURE_ONLY_RE.test(source)) {
            source = '';
          }
        } else if (kind === 'diyalog') {
          source = source || 'Konuşmacı';
        }

        const text = ensureQuotedText(rawTextVal);
        if (!text) continue;

        entries.push({
          startSec: Number(sSec.toFixed(2)),
          endSec: Number(eSec.toFixed(2)),
          source,
          text,
          kind,
        });
      }

      entries.sort((a, b) => a.startSec - b.startSec);
      res.json({ entries, modelUsed: model });
    } catch (err) {
      const parsedErr = parseErrorStatus(err);
      console.error('[/api/extract-dialogue-subtitles] error:', parsedErr.upstreamStatus, parsedErr.code, parsedErr.message);
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
