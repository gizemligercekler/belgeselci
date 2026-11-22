import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 3000;

function resolveGeminiKey(req: Request): string {
  const headerKey = req.header('x-gemini-api-key')?.trim();
  if (headerKey) return headerKey;
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey && envKey !== 'MY_GEMINI_API_KEY') return envKey;
  return '';
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

function parseErrorStatus(err: unknown): { status: number; message: string; code?: string } {
  const anyErr = err as {
    status?: number;
    statusCode?: number;
    message?: string;
    error?: { code?: number; status?: string; message?: string };
  };

  const rawMsg =
    anyErr?.error?.message ||
    anyErr?.message ||
    'Gemini API isteği sırasında beklenmeyen bir hata oluştu.';

  let status =
    typeof anyErr?.status === 'number'
      ? anyErr.status
      : typeof anyErr?.statusCode === 'number'
        ? anyErr.statusCode
        : typeof anyErr?.error?.code === 'number'
          ? anyErr.error.code
          : 500;

  if (status === 500) {
    if (/429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(rawMsg)) status = 429;
    else if (/404|NOT_FOUND|not found|not supported/i.test(rawMsg)) status = 404;
    else if (/403|PERMISSION_DENIED/i.test(rawMsg)) status = 403;
    else if (/400|INVALID_ARGUMENT|API_KEY_INVALID/i.test(rawMsg)) status = 400;
  }

  let friendlyTr = rawMsg;
  if (status === 429) {
    friendlyTr = `Hız sınırına ulaşıldı (429 RESOURCE_EXHAUSTED). Kısa beklemenin ardından yeniden denenecek.`;
  } else if (status === 404) {
    friendlyTr = `Seçili model bu uç noktada bulunamadı (404). Ayarlar'dan model adını kontrol edin (örn. gemini-3.8-flash veya gemini-4-hydrogen). Detay: ${rawMsg}`;
  } else if (status === 403 || /API_KEY_INVALID/i.test(rawMsg)) {
    friendlyTr = `Gemini API anahtarı geçersiz veya yetkisiz. Ayarlar'daki anahtarı veya sunucu Secrets yapılandırmasını kontrol edin.`;
  }

  return {
    status,
    message: friendlyTr,
    code: anyErr?.error?.status || (status === 429 ? 'RESOURCE_EXHAUSTED' : undefined),
  };
}

function parseTimestampToSec(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, raw);
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const parts = trimmed.split(':').map((p) => Number(p.replace(',', '.')));
    if (parts.every((n) => Number.isFinite(n))) {
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 1) return parts[0];
    }
  }
  return 0;
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
  app.use(express.json({ limit: '30mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    const hasGemini =
      Boolean(process.env.GEMINI_API_KEY?.trim()) &&
      process.env.GEMINI_API_KEY?.trim() !== 'MY_GEMINI_API_KEY';
    res.json({ ok: true, hasServerGeminiKey: hasGemini });
  });

  // 1. Transcribe a 5-minute 16kHz mono WAV audio chunk with precise relative timestamps
  app.post('/api/transcribe-chunk', async (req: Request, res: Response) => {
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
        audioBase64,
        mimeType = 'audio/wav',
        chunkDurationSec = 300,
        model = 'gemini-3.8-flash',
      } = req.body as {
        audioBase64?: string;
        mimeType?: string;
        chunkDurationSec?: number;
        model?: string;
      };

      if (!audioBase64 || typeof audioBase64 !== 'string') {
        res.status(400).json({ error: 'Ses parçası verisi eksik.' });
        return;
      }

      const ai = createGenAIClient(apiKey);
      const maxDur = Math.max(1, Number(chunkDurationSec) || 300);

      const prompt = `Bu Türkçe belgesel ses kaydını tam ve eksiksiz olarak yazıya dök.
Kurallar:
- Her konuşma cümlesini veya 5–12 saniyelik doğal cümle öbeğini kesin zaman damgalarıyla (bu ses klibinin başından itibaren saniye cinsinden: 0.0 ile ${maxDur.toFixed(1)} arasında) listele.
- Zaman damgaları kesinlikle artan sırada ve ses kaydındaki gerçek konuşma anlarıyla uyumlu olsun.
- Özetleme yapma, konuşulan tüm kelimeleri ve özel isimleri (tarih, yer, yazma adları) doğru Türkçe imlayla yaz.
- Sadece geçerli JSON döndür.`;

      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: audioBase64,
              },
            },
            { text: prompt },
          ],
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                startSec: {
                  type: Type.NUMBER,
                  description: 'Segment start time in seconds from start of this clip.',
                },
                endSec: {
                  type: Type.NUMBER,
                  description: 'Segment end time in seconds from start of this clip.',
                },
                text: {
                  type: Type.STRING,
                  description: 'Spoken Turkish text in this segment.',
                },
              },
              required: ['startSec', 'endSec', 'text'],
            },
          },
        },
      });

      const rawText = (response.text ?? '[]')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();

      let parsed: Array<{ startSec?: unknown; endSec?: unknown; text?: string }> = [];
      try {
        const obj = JSON.parse(rawText);
        parsed = Array.isArray(obj) ? obj : Array.isArray(obj?.segments) ? obj.segments : [];
      } catch {
        // Fallback parser if model emitted [MM:SS - MM:SS] lines
        const lines = rawText.split('\n');
        for (const line of lines) {
          const m = line.match(/\[?(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–]\s*(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(.+)/);
          if (m) {
            parsed.push({
              startSec: parseTimestampToSec(m[1]),
              endSec: parseTimestampToSec(m[2]),
              text: m[3].trim(),
            });
          }
        }
      }

      const segments = parsed
        .map((seg) => {
          const start = Math.min(maxDur, Math.max(0, parseTimestampToSec(seg.startSec)));
          const endRaw = parseTimestampToSec(seg.endSec);
          const end = Math.min(maxDur, Math.max(start + 0.2, endRaw || start + 4));
          return {
            startSec: Number(start.toFixed(2)),
            endSec: Number(end.toFixed(2)),
            text: String(seg.text || '').trim(),
          };
        })
        .filter((seg) => seg.text.length > 0)
        .sort((a, b) => a.startSec - b.startSec);

      res.json({ segments });
    } catch (err) {
      const parsedErr = parseErrorStatus(err);
      res.status(parsedErr.status).json({ error: parsedErr.message, code: parsedErr.code });
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
        totalAudioDuration = 0,
        model = 'gemini-3.8-flash',
      } = req.body as {
        transcriptSegments?: Array<{ startSec: number; endSec: number; text: string }>;
        images?: Array<{ orderNumber: number; filename: string; cleanTitle: string }>;
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

      const imageListText = images
        .map((img, idx) => `${idx + 1}. Sıra #${img.orderNumber} | Dosya: ${img.filename} | Konu Başlığı: ${img.cleanTitle}`)
        .join('\n');

      const prompt = `Sen profesyonel bir Türkçe belgesel kurgu yönetmenisin.
Aşağıda bir belgeselin tam zaman damgalı Türkçe transkripti (toplam süre: ${totalDur.toFixed(2)} saniye) ve sayısal sıraya dizilmiş ${images.length} adet görselin listesi var.

Görevin: Her görseli, anlatıcının o görselin konusundan bahsetmeye başladığı TAM başlangıç saniyesine (startSec) yerleştirmek.

KESİN KURALLAR:
1. Görsellerin sırası ASLA değişmez. Listede verilen 1'den ${images.length}'e kadar sırayla eşleştir.
2. İlk görsel (index 0) KESİNLİKLE 0.0 saniyede başlamalıdır.
3. Her görsel i, kendinden önceki görsel i-1'den KESİNLİKLE daha sonra başlamalıdır (startSec[i] > startSec[i-1], aralarında en az 2.0 saniye olacak şekilde).
4. Tüm startSec değerleri 0.0 ile ${(totalDur - 2).toFixed(2)} arasında olmalıdır.
5. Anlatıcının transkriptte dosya başlığıyla (cleanTitle) anlamsal olarak en net örtüştüğü cümlenin tam başlangıç saniyesini seç. Eğer bir görselin konusu transkriptte açık geçmiyorsa, önceki ve sonraki görsel arasına doğal bir cümle başlangıcına orantılı yerleştir.
6. Her görsel için transkriptten eşleşen kısa alıntıyı (matchedExcerpt, en fazla 140 karakter) ekle.

GÖRSEL LİSTESİ (${images.length} adet):
${imageListText}

ZAMAN DAMGALI TRANSKRİPT:
${transcriptText || '(Transkript metni boş; görselleri toplam süreye eşit dağıt.)'}

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

      res.json({ alignments: Array.isArray(parsed) ? parsed : [] });
    } catch (err) {
      const parsedErr = parseErrorStatus(err);
      res.status(parsedErr.status).json({ error: parsedErr.message, code: parsedErr.code });
    }
  });

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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Belgesel Kurgu Asistanı sunucusu http://0.0.0.0:${PORT} adresinde hazır.`);
  });
}

startServer().catch((err) => {
  console.error('Sunucu başlatılamadı:', err);
  process.exit(1);
});
