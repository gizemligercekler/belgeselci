import {
  AudioChunk,
  ImageResolution,
  OutlineChapter,
  PexelsVideoItem,
  StoryboardScene,
  StudioSettings,
  TopicBrief,
} from '../types/studio';

export interface RotationCallbacks {
  signal?: AbortSignal;
  onKeySwitch?: (activeKeyIndex: number, totalKeys: number) => void;
  onRetryWait?: (secondsRemaining: number) => void;
}

export interface ServerHealthStatus {
  ok: boolean;
  hasServerGeminiKey: boolean;
  hasServerPexelsKey: boolean;
}

// Reference pricing estimate per image for Nano Banana 2.1 (only shown in optional Paid Auto API mode)
export const NANO_BANANA_ESTIMATED_USD: Record<ImageResolution, number> = {
  '1K': 0.04,
  '2K': 0.08,
  '4K': 0.14,
};

export function parseFreeApiKeys(settings: StudioSettings): string[] {
  return settings.freeApiKeysText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function getActiveApiKeyPool(settings: StudioSettings): string[] {
  if (settings.tierMode === 'paid') {
    const k = settings.paidApiKey.trim();
    return k ? [k] : ['']; // empty string means "use server process.env.GEMINI_API_KEY fallback"
  }
  const freeKeys = parseFreeApiKeys(settings);
  return freeKeys.length > 0 ? freeKeys : [''];
}

export function getEffectiveDelayMs(settings: StudioSettings): number {
  if (settings.tierMode === 'paid') {
    return Math.max(0, Math.round((settings.interRequestDelaySec || 0.2) * 1000));
  }
  return Math.max(0, Math.round((settings.interRequestDelaySec || 2) * 1000));
}

export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('İşlem kullanıcı tarafından durduruldu.', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException('İşlem kullanıcı tarafından durduruldu.', 'AbortError'));
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function countdownWait(seconds: number, cb?: RotationCallbacks): Promise<void> {
  for (let rem = Math.ceil(seconds); rem > 0; rem--) {
    cb?.onRetryWait?.(rem);
    await sleepWithAbort(1000, cb?.signal);
  }
  cb?.onRetryWait?.(0);
}

// Persistent round-robin cursor across requests in Free Tier
let currentFreeKeyCursor = 0;

async function callGeminiProxyWithRotation<T>(
  endpoint: string,
  body: Record<string, unknown>,
  settings: StudioSettings,
  callbacks?: RotationCallbacks
): Promise<T> {
  const keyPool = getActiveApiKeyPool(settings);
  const totalKeys = keyPool.length;
  const maxCycles = settings.tierMode === 'free' ? 3 : 2;
  let lastErrorMsg = 'Gemini API isteği başarısız oldu.';

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    for (let attempt = 0; attempt < totalKeys; attempt++) {
      if (callbacks?.signal?.aborted) {
        throw new DOMException('İşlem durduruldu.', 'AbortError');
      }

      const keyIdx = (currentFreeKeyCursor + attempt) % totalKeys;
      const selectedKey = keyPool[keyIdx];
      callbacks?.onKeySwitch?.(keyIdx + 1, totalKeys);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (selectedKey) {
        headers['x-gemini-api-key'] = selectedKey;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: callbacks?.signal,
      });

      const data = (await res.json().catch(() => ({}))) as T & { error?: string };

      if (res.ok) {
        currentFreeKeyCursor = keyIdx;
        return data;
      }

      lastErrorMsg = data.error || `HTTP ${res.status} hatası`;

      // 429 Quota Exhausted -> rotate immediately to next key if available
      if (res.status === 429) {
        if (attempt + 1 < totalKeys) {
          // Move cursor to the next key immediately
          currentFreeKeyCursor = (keyIdx + 1) % totalKeys;
          await sleepWithAbort(400, callbacks?.signal);
          continue;
        }
        // Exhausted all keys in this cycle -> wait RPM_RETRY_WAIT_SEC
        if (cycle + 1 < maxCycles) {
          const waitSec =
            settings.tierMode === 'free'
              ? Math.max(5, settings.rpmRetryWaitSec || 25)
              : 5;
          await countdownWait(waitSec, callbacks);
          continue;
        }
      }

      // Non-429 errors (400, 401, 403, 404, 500) fail fast with clear message
      throw new Error(lastErrorMsg);
    }
  }

  throw new Error(lastErrorMsg);
}

export async function fetchServerHealth(): Promise<ServerHealthStatus> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return { ok: false, hasServerGeminiKey: false, hasServerPexelsKey: false };
    return (await res.json()) as ServerHealthStatus;
  } catch {
    return { ok: false, hasServerGeminiKey: false, hasServerPexelsKey: false };
  }
}

function extractJsonArrayOrObject<T>(raw: string): T {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  return JSON.parse(cleaned) as T;
}

export async function generateDocumentaryOutline(
  brief: TopicBrief,
  settings: StudioSettings,
  callbacks?: RotationCallbacks
): Promise<OutlineChapter[]> {
  const systemInstruction = `Sen BBC belgesel geleneğinde uzmanlaşmış deneyimli bir Türkçe belgesel yapımcısı ve senaristisin.
Sadece geçerli JSON döndür. Başka açıklama veya markdown kod bloğu ekleme.
Üslup: ciddi, derinlikli, akıcı, abartısız, klişesiz.
Her zaman 1 adet 'cold_open' (Soğuk Açılış), konunun hedef süresine uygun 4-7 adet numaralı 'chapter' (Bölüm) ve 1 adet 'conclusion' (Kapanış) oluştur.`;

  const prompt = `Aşağıdaki belgesel fikri için yapılandırılmış Türkçe belgesel iskeleti oluştur:

Belgesel Konusu: ${brief.topic}
Hedef Süre: ${brief.targetMinutes} dakika
Anlatım Tonu / Bakış Açısı: ${brief.toneAndAngle}
Kaynak Notları / Tezler: ${brief.sourceNotes || '(Ek kaynak notu belirtilmedi)'}

JSON formatı tam olarak şu şemada bir dizi (array) olmalı:
[
  {
    "kind": "cold_open" | "chapter" | "conclusion",
    "number": 1,
    "title": "BÜYÜK HARF VEYA DÜZGÜN BAŞLIK",
    "hook": "İzleyiciyi bu bölüme bağlayan güçlü açılış sorusu veya gerilim cümlesi",
    "summaryPoints": "Bu bölümde işlenecek tarihsel/bilimsel kanıtlar, kaynaklar ve ana fikirler"
  }
]`;

  const resp = await callGeminiProxyWithRotation<{ text: string }>(
    '/api/gemini/text',
    {
      model: settings.scriptModel,
      prompt,
      systemInstruction,
      responseMimeType: 'application/json',
    },
    settings,
    callbacks
  );

  const items = extractJsonArrayOrObject<
    Array<{
      kind: 'cold_open' | 'chapter' | 'conclusion';
      number?: number;
      title: string;
      hook: string;
      summaryPoints: string;
    }>
  >(resp.text);

  let chapterCounter = 0;
  return items.map((item, idx) => {
    const kind =
      item.kind === 'cold_open' || item.kind === 'conclusion' ? item.kind : 'chapter';
    if (kind === 'chapter') chapterCounter += 1;
    return {
      id: `ch_${Date.now()}_${idx}`,
      kind,
      number: kind === 'chapter' ? chapterCounter : undefined,
      title: item.title || `Bölüm ${idx + 1}`,
      hook: item.hook || '',
      summaryPoints: item.summaryPoints || '',
      draftText: '',
    };
  });
}

export async function writeDocumentaryChapter(
  brief: TopicBrief,
  chapter: OutlineChapter,
  previousSummary: string,
  bannedCliches: string[],
  settings: StudioSettings,
  callbacks?: RotationCallbacks
): Promise<string> {
  const systemInstruction = `Sen BBC belgesel geleneğinde uzun metrajlı Türkçe belgesel metinleri yazan usta bir belgesel yazarısın.
Kurallar:
1. Akıcı, sıcak, ağırbaşlı, kaynak odaklı ve doğal konuşma ritmine uygun Türkçe yaz.
2. ASLA şu yasaklı yapay zeka klişelerini kullanma: ${bannedCliches.join(' | ')}.
3. Anlatımı bölmeden, uygun yerlere şu yönetmen katman etiketlerini ayrı satırlarda yerleştir:
   - Bölüm başında (cold_open veya conclusion ise): [[BOLUM: Bölüm Başlığı]]
   - Eğer numaralı bir bölümse ilk satır tam olarak şu formatta olsun: ### BÖLÜM ${chapter.number || 1}: ${chapter.title}
   - Önemli ayet/alıntı geçtiğinde: [[AYET: Kaynak:No | Alıntı metni.]]
   - Önemli tarihsel referans/etiket geçtiğinde: [[ETIKET: Kısa Referans Metni]]
4. Paragraflar 2-4 cümle uzunluğunda, seslendirmeye (TTS) uygun ve nefes alan ritimde olsun.
5. Sadece belgesel metnini döndür; dış açıklama veya meta yorum yazma.`;

  const targetWords = Math.max(
    450,
    Math.round(((brief.targetMinutes || 35) * 125) / 6)
  );

  const prompt = `Belgesel Konusu: ${brief.topic}
Anlatım Tonu: ${brief.toneAndAngle}
Kaynak Notları: ${brief.sourceNotes || 'Genel tarihsel/bilimsel doğruluk'}

Önceki Bölüm Bağlamı / Özeti (akıcı geçiş için):
${previousSummary || '(Bu ilk bölümdür, doğrudan güçlü bir belgesel açılışı yap.)'}

Şimdi yazılacak bölüm:
- Tür: ${chapter.kind === 'cold_open' ? 'Soğuk Açılış (Cold Open)' : chapter.kind === 'conclusion' ? 'Kapanış' : `Bölüm ${chapter.number}`}
- Başlık: ${chapter.title}
- Kanca (Hook): ${chapter.hook}
- İşlenecek Noktalar: ${chapter.summaryPoints}
- Hedef Uzunluk: Yaklaşık ${targetWords} kelime

Lütfen eksiksiz, yayın kalitesinde Türkçe belgesel metnini yaz.`;

  const resp = await callGeminiProxyWithRotation<{ text: string }>(
    '/api/gemini/text',
    {
      model: settings.scriptModel,
      prompt,
      systemInstruction,
    },
    settings,
    callbacks
  );

  return resp.text.trim();
}

export async function cleanAiCliches(
  scriptText: string,
  bannedCliches: string[],
  settings: StudioSettings,
  callbacks?: RotationCallbacks
): Promise<string> {
  const systemInstruction = `Sen deneyimli bir BBC Türkçe belgesel baş editörüsün.
Görevin: Verilen belgesel senaryosundaki yapay zeka klişelerini, yapay geçiş cümlelerini ve abartılı tonu temizleyip doğal, sakin ve editoryal bir Türkçeye dönüştürmek.
KRİTİK KURALLAR:
- Tarihsel/bilimsel gerçekleri, sayıları, tarihleri ve kaynakları ASLA değiştirme veya silme.
- ### BÖLÜM ... başlıklarını ve [[BOLUM: ...]], [[AYET: ...]], [[ETIKET: ...]] yönetmen etiketlerini AYNEN koru.
- Yasaklı klişeleri ve benzeri yapay kalıpları doğal belgesel geçişleriyle değiştir: ${bannedCliches.join(' | ')}.
- Sadece düzeltilmiş tam senaryo metnini döndür.`;

  const resp = await callGeminiProxyWithRotation<{ text: string }>(
    '/api/gemini/text',
    {
      model: settings.scriptModel,
      prompt: `Aşağıdaki Türkçe belgesel senaryosunu klişelerden arındırıp editoryal akışını güçlendir:\n\n${scriptText}`,
      systemInstruction,
    },
    settings,
    callbacks
  );

  return resp.text.trim();
}

export async function generateStoryboardScenes(
  chunks: AudioChunk[],
  targetSceneDurationSec: number,
  topic: string,
  settings: StudioSettings,
  callbacks?: RotationCallbacks
): Promise<StoryboardScene[]> {
  const systemInstruction = `Sen BBC belgeselleri için görsel yönetmenlik ve storyboard hazırlayan kıdemli bir görüntü yönetmenisin.
Sadece geçerli JSON döndür.
Her sahne için:
- 'imagePrompt': 16:9 sinematik, fotogerçekçi BBC belgesel fotoğrafçılığı tarzında, detaylı İngilizce görsel promptu (ışık, kamera açısı, doku, dönem atmosferi; yazı/metin/watermark içermeyen).
- 'stockQuery': Pexels 16:9 stok video araması için 2-4 kelimelik net İngilizce arama sorgusu.
- 'mediaType': atmosferik manzara/hareket için "stock_video", tarihsel canlandırma/özel nesne/belge için "ai_image".
- 'kenBurnsEffect': "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "none".`;

  const chunkSummaries = chunks.map((c) => {
    const estDuration = c.durationSec || Math.max(12, Math.round(c.cleanedText.length / 15));
    const desiredScenes = Math.max(1, Math.round(estDuration / Math.max(10, targetSceneDurationSec)));
    return {
      chunkIndex: c.index,
      chapterTitle: c.chapterTitle,
      estimatedSec: estDuration,
      suggestedSceneCount: desiredScenes,
      overlays: c.overlays.map((o) => ({ kind: o.kind, label: o.label, text: o.text })),
      text: c.cleanedText.slice(0, 1400),
    };
  });

  const prompt = `Belgesel Konusu: ${topic || 'Tarihsel / Bilimsel Belgesel'}
Hedef Sahne Süresi: Yaklaşık ${targetSceneDurationSec} saniye

Aşağıdaki ses parçaları (chunks) için zamanlanmış sahne listesi (storyboard) üret. Her parça için suggestedSceneCount civarında sahne oluştur ve parça üzerindeki overlays etiketlerini ilgili sahnelere dağıt:

${JSON.stringify(chunkSummaries, null, 2)}

Döndürülecek JSON şeması:
[
  {
    "chunkIndex": 1,
    "excerpt": "Bu sahnede seslendirilen Türkçe metinden kısa alıntı (1-2 cümle)",
    "mediaType": "ai_image" | "stock_video",
    "imagePrompt": "Cinematic 16:9 BBC documentary still photography...",
    "stockQuery": "ancient desert caves sunset",
    "overlayKind": "none" | "bolum" | "ayet" | "etiket",
    "overlayLabel": "En'âm:38 veya Bölüm",
    "overlayText": "Ekranda görünecek metin (yoksa boş string)",
    "kenBurnsEffect": "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "none",
    "durationSec": 18
  }
]`;

  const resp = await callGeminiProxyWithRotation<{ text: string }>(
    '/api/gemini/text',
    {
      model: settings.scriptModel,
      prompt,
      systemInstruction,
      responseMimeType: 'application/json',
    },
    settings,
    callbacks
  );

  const rawScenes = extractJsonArrayOrObject<
    Array<{
      chunkIndex: number;
      excerpt: string;
      mediaType?: 'ai_image' | 'stock_video';
      imagePrompt?: string;
      stockQuery?: string;
      overlayKind?: 'none' | 'bolum' | 'ayet' | 'etiket';
      overlayLabel?: string;
      overlayText?: string;
      kenBurnsEffect?: 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right' | 'none';
      durationSec?: number;
    }>
  >(resp.text);

  return rawScenes.map((s, idx) => ({
    id: `scene_${Date.now()}_${idx + 1}`,
    sceneNumber: idx + 1,
    chunkIndex: s.chunkIndex || 1,
    excerpt: s.excerpt || '',
    mediaType: s.mediaType === 'stock_video' ? 'stock_video' : 'ai_image',
    imagePrompt: s.imagePrompt || '',
    stockQuery: s.stockQuery || 'documentary cinema landscape',
    overlayKind:
      s.overlayKind === 'bolum' || s.overlayKind === 'ayet' || s.overlayKind === 'etiket'
        ? s.overlayKind
        : 'none',
    overlayLabel: s.overlayLabel || '',
    overlayText: s.overlayText || '',
    kenBurnsEffect: s.kenBurnsEffect || (idx % 2 === 0 ? 'zoom_in' : 'zoom_out'),
    durationSec: Math.max(5, Math.round(s.durationSec || targetSceneDurationSec)),
    status: 'idle',
  }));
}

export async function synthesizeChunkAudio(
  cleanedText: string,
  settings: StudioSettings,
  callbacks?: RotationCallbacks
): Promise<{ audioBase64: string; mimeType: string }> {
  return callGeminiProxyWithRotation<{ audioBase64: string; mimeType: string }>(
    '/api/gemini/tts',
    {
      model: settings.ttsModel,
      text: cleanedText,
      voiceName: settings.ttsVoice,
      style: settings.ttsStylePrompt,
    },
    settings,
    callbacks
  );
}

export async function generateSceneImage(
  imagePrompt: string,
  settings: StudioSettings,
  callbacks?: RotationCallbacks
): Promise<{ imageBase64: string; mimeType: string }> {
  return callGeminiProxyWithRotation<{ imageBase64: string; mimeType: string }>(
    '/api/gemini/image',
    {
      model: settings.imageModel,
      prompt: imagePrompt,
      aspectRatio: '16:9',
      imageSize: settings.imageResolution,
    },
    settings,
    callbacks
  );
}

export async function searchPexelsVideos(
  query: string,
  settings: StudioSettings
): Promise<PexelsVideoItem[]> {
  const headers: Record<string, string> = {};
  if (settings.pexelsApiKey.trim()) {
    headers['x-pexels-api-key'] = settings.pexelsApiKey.trim();
  }
  const url = `/api/pexels/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers });
  const data = (await res.json().catch(() => ({}))) as {
    videos?: PexelsVideoItem[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || `Pexels arama hatası (${res.status})`);
  }
  return data.videos || [];
}
