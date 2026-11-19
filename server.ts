import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

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

function createGenAIClient(apiKey: string, apiVersion?: string): GoogleGenAI {
  const options: {
    apiKey: string;
    apiVersion?: string;
    httpOptions: { headers: Record<string, string> };
  } = {
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  };
  if (apiVersion) {
    options.apiVersion = apiVersion;
  }
  return new GoogleGenAI(options);
}

function parseErrorStatus(err: unknown): { status: number; message: string; code?: string } {
  const anyErr = err as {
    status?: number;
    statusCode?: number;
    code?: number | string;
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
    friendlyTr = `Kota sınırına ulaşıldı (429 RESOURCE_EXHAUSTED). ${rawMsg}`;
  } else if (status === 404) {
    friendlyTr = `Seçili model bu API uç noktasında bulunamadı (404). Ayarlar'dan model adını kontrol edin (örn. gemini-3.8-flash veya gemini-4-hydrogen). Detay: ${rawMsg}`;
  } else if (status === 403 || /API_KEY_INVALID/i.test(rawMsg)) {
    friendlyTr = `API anahtarı geçersiz veya yetkisiz (403/400). Ayarlar çekmecesindeki anahtarı veya Secrets yapılandırmasını kontrol edin.`;
  }

  return {
    status,
    message: friendlyTr,
    code: anyErr?.error?.status || (status === 429 ? 'RESOURCE_EXHAUSTED' : undefined),
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // Health & server fallback capability status
  app.get('/api/health', (_req: Request, res: Response) => {
    const hasGemini =
      Boolean(process.env.GEMINI_API_KEY?.trim()) &&
      process.env.GEMINI_API_KEY?.trim() !== 'MY_GEMINI_API_KEY';
    const hasPexels = Boolean(process.env.PEXELS_API_KEY?.trim());
    res.json({
      ok: true,
      hasServerGeminiKey: hasGemini,
      hasServerPexelsKey: hasPexels,
    });
  });

  // 1. Text / Outline / Script / Cliché Cleaner / Storyboard Generation
  app.post('/api/gemini/text', async (req: Request, res: Response) => {
    try {
      const apiKey = resolveGeminiKey(req);
      if (!apiKey) {
        res.status(401).json({
          error:
            'Gemini API anahtarı bulunamadı. Ayarlar çekmecesinden Free Tier / Paid Tier anahtarı ekleyin veya sunucu Secrets alanından GEMINI_API_KEY tanımlayın.',
        });
        return;
      }

      const {
        model = 'gemini-3.8-flash',
        prompt,
        systemInstruction,
        responseMimeType,
        responseSchema,
      } = req.body as {
        model?: string;
        prompt?: string;
        systemInstruction?: string;
        responseMimeType?: string;
        responseSchema?: Record<string, unknown>;
      };

      if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({ error: 'Prompt metni eksik.' });
        return;
      }

      const ai = createGenAIClient(apiKey);
      const config: Record<string, unknown> = {};
      if (systemInstruction) config.systemInstruction = systemInstruction;
      if (responseMimeType) config.responseMimeType = responseMimeType;
      if (responseSchema) config.responseSchema = responseSchema;

      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: Object.keys(config).length > 0 ? config : undefined,
      });

      const text = response.text ?? '';
      res.json({ text, model });
    } catch (err) {
      const parsed = parseErrorStatus(err);
      res.status(parsed.status).json({ error: parsed.message, code: parsed.code });
    }
  });

  // 2. TTS Audio Generation (v1beta + speechMetadata.style + responseModalities: ['AUDIO'])
  app.post('/api/gemini/tts', async (req: Request, res: Response) => {
    try {
      const apiKey = resolveGeminiKey(req);
      if (!apiKey) {
        res.status(401).json({
          error:
            'TTS için Gemini API anahtarı bulunamadı. Ayarlar çekmecesinden en az bir anahtar ekleyin veya GEMINI_API_KEY tanımlayın.',
        });
        return;
      }

      const {
        model = 'gemini-3.8-flash-tts',
        text,
        voiceName = 'Charon',
        style = 'Calm, natural BBC documentary narration. Serious, warm, and understated, with a steady unhurried pace, never theatrical.',
      } = req.body as {
        model?: string;
        text?: string;
        voiceName?: string;
        style?: string;
      };

      if (!text || !text.trim()) {
        res.status(400).json({ error: 'Seslendirilecek metin boş olamaz.' });
        return;
      }

      // Use v1beta as required for speechMetadata / speech_metadata & Gemini 3.8 TTS
      const ai = createGenAIClient(apiKey, 'v1beta');

      const partPayload: Record<string, unknown> = {
        text,
      };
      if (style && style.trim()) {
        partPayload.speechMetadata = { style: style.trim() };
      }

      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [partPayload as never],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          },
        },
      });

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      let audioBase64 = '';
      let mimeType = 'audio/wav';

      for (const part of parts) {
        if (part.inlineData?.data) {
          audioBase64 = part.inlineData.data;
          mimeType = part.inlineData.mimeType || 'audio/wav';
          break;
        }
      }

      if (!audioBase64) {
        res.status(502).json({
          error:
            'Model ses verisi döndürmedi. Metin çok uzun olabilir veya seçili ses/model kombinasyonu yanıt vermedi.',
        });
        return;
      }

      res.json({ audioBase64, mimeType, model, voiceName });
    } catch (err) {
      const parsed = parseErrorStatus(err);
      res.status(parsed.status).json({ error: parsed.message, code: parsed.code });
    }
  });

  // 3. Optional Image Generation (Nano Banana 2.1 / Gemini Image / Imagen)
  app.post('/api/gemini/image', async (req: Request, res: Response) => {
    try {
      const apiKey = resolveGeminiKey(req);
      if (!apiKey) {
        res.status(401).json({
          error:
            'Görsel üretimi için Gemini API anahtarı bulunamadı. Ayarlar çekmecesinden ücretli/ücretsiz anahtarınızı ekleyin veya Sıfır Maliyetli Manuel Modu kullanın.',
        });
        return;
      }

      const {
        model = 'gemini-nano-banana-2.1',
        prompt,
        aspectRatio = '16:9',
        imageSize = '2K',
      } = req.body as {
        model?: string;
        prompt?: string;
        aspectRatio?: string;
        imageSize?: '1K' | '2K' | '4K';
      };

      if (!prompt || !prompt.trim()) {
        res.status(400).json({ error: 'Görsel promptu boş olamaz.' });
        return;
      }

      const ai = createGenAIClient(apiKey);

      // Support Imagen models if the user manually typed imagen-* in Settings
      if (/^imagen-/i.test(model)) {
        const imgResp = await ai.models.generateImages({
          model,
          prompt,
          config: {
            numberOfImages: 1,
            aspectRatio,
            outputMimeType: 'image/png',
          },
        });
        const imgBytes = imgResp.generatedImages?.[0]?.image?.imageBytes;
        if (!imgBytes) {
          res.status(502).json({ error: 'Imagen modeli görsel döndürmedi.' });
          return;
        }
        res.json({ imageBase64: imgBytes, mimeType: 'image/png', model });
        return;
      }

      // Nano Banana / Gemini image models via generateContent
      const supportsImageSize = /nano-banana-2\.1|3-pro-image/i.test(model);
      const imageConfig: Record<string, string> = { aspectRatio };
      if (supportsImageSize && imageSize) {
        imageConfig.imageSize = imageSize;
      }

      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [{ text: prompt }],
        },
        config: {
          imageConfig,
        } as never,
      });

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      let imageBase64 = '';
      let mimeType = 'image/png';

      for (const part of parts) {
        if (part.inlineData?.data) {
          imageBase64 = part.inlineData.data;
          mimeType = part.inlineData.mimeType || 'image/png';
          break;
        }
      }

      if (!imageBase64) {
        res.status(502).json({
          error:
            'Model görsel verisi döndürmedi. Prompt güvenlik filtresine takılmış veya seçili model görsel desteklemiyor olabilir.',
        });
        return;
      }

      res.json({ imageBase64, mimeType, model });
    } catch (err) {
      const parsed = parseErrorStatus(err);
      res.status(parsed.status).json({ error: parsed.message, code: parsed.code });
    }
  });

  // 4. Pexels 16:9 Stock Video Search Proxy
  app.get('/api/pexels/search', async (req: Request, res: Response) => {
    try {
      const pexelsKey =
        req.header('x-pexels-api-key')?.trim() || process.env.PEXELS_API_KEY?.trim() || '';

      if (!pexelsKey) {
        res.status(400).json({
          error:
            'Pexels API anahtarı tanımlı değil. Ayarlar çekmecesinden ücretsiz Pexels API anahtarınızı ekleyebilirsiniz (pexels.com/api).',
        });
        return;
      }

      const query = String(req.query.q || '').trim();
      if (!query) {
        res.status(400).json({ error: 'Arama sorgusu boş olamaz.' });
        return;
      }

      const url = new URL('https://api.pexels.com/videos/search');
      url.searchParams.set('query', query);
      url.searchParams.set('orientation', 'landscape');
      url.searchParams.set('per_page', '8');

      const upstream = await fetch(url.toString(), {
        headers: {
          Authorization: pexelsKey,
        },
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        res.status(upstream.status).json({
          error: `Pexels API hatası (${upstream.status}): ${errText.slice(0, 180)}`,
        });
        return;
      }

      const data = (await upstream.json()) as {
        videos?: Array<{
          id: number;
          width: number;
          height: number;
          duration: number;
          image: string;
          url: string;
          user?: { name?: string };
          video_files?: Array<{
            id: number;
            quality: string;
            file_type: string;
            width: number;
            height: number;
            link: string;
          }>;
        }>;
      };

      const videos = (data.videos ?? []).map((v) => {
        const mp4Files = (v.video_files ?? []).filter((f) => f.file_type === 'video/mp4');
        const sorted = [...mp4Files].sort((a, b) => (b.width || 0) - (a.width || 0));
        const hd = sorted.find((f) => f.width <= 1920 && f.width >= 1280) || sorted[0];
        const preview = sorted.find((f) => f.width <= 960) || sorted[sorted.length - 1] || hd;

        return {
          id: v.id,
          duration: v.duration,
          width: v.width,
          height: v.height,
          thumbnail: v.image,
          pexelsUrl: v.url,
          author: v.user?.name || 'Pexels',
          videoUrl: hd?.link || '',
          previewUrl: preview?.link || hd?.link || '',
        };
      });

      res.json({ videos });
    } catch (err) {
      res.status(500).json({
        error: `Pexels araması sırasında bağlantı hatası: ${(err as Error).message}`,
      });
    }
  });

  // Vite middleware in dev, static dist in production
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
    console.log(`Belgesel Stüdyosu sunucusu http://0.0.0.0:${PORT} adresinde hazır.`);
  });
}

startServer().catch((err) => {
  console.error('Sunucu başlatılamadı:', err);
  process.exit(1);
});
