import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  Film,
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  ImageResolution,
  KenBurnsEffect,
  OverlayKind,
  PexelsVideoItem,
  ProjectRecord,
  StoryboardScene,
  VisualWorkflowMode,
} from '../../types/studio';
import {
  generateSceneImage,
  generateStoryboardScenes,
  getEffectiveDelayMs,
  NANO_BANANA_ESTIMATED_USD,
  searchPexelsVideos,
  sleepWithAbort,
} from '../../services/geminiService';
import { deleteMediaBlob, getMediaBlob, saveMediaBlob } from '../../utils/storageDb';

interface Step4StoryboardProps {
  project: ProjectRecord;
  onUpdateProject: (updater: (prev: ProjectRecord) => ProjectRecord) => void;
  onNextStep: () => void;
  onOpenSettings: () => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export const Step4Storyboard: React.FC<Step4StoryboardProps> = ({
  project,
  onUpdateProject,
  onNextStep,
  onOpenSettings,
  onNotify,
}) => {
  const [generatingBoard, setGeneratingBoard] = useState(false);
  const [boardStatus, setBoardStatus] = useState('');
  const [visualUrls, setVisualUrls] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [busySceneId, setBusySceneId] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchStatus, setBatchStatus] = useState('');

  // Pexels search modal state
  const [pexelsScene, setPexelsScene] = useState<StoryboardScene | null>(null);
  const [pexelsQuery, setPexelsQuery] = useState('');
  const [pexelsResults, setPexelsResults] = useState<PexelsVideoItem[]>([]);
  const [pexelsLoading, setPexelsLoading] = useState(false);
  const [pexelsError, setPexelsError] = useState('');

  const abortRef = useRef<AbortController | null>(null);

  const { studioSettings, editSettings, chunks, scenes } = project;
  const visualMode = studioSettings.visualWorkflowMode;

  // Hydrate Object URLs for local/generated visuals in IndexedDB
  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];

    const hydrate = async () => {
      const next: Record<string, string> = {};
      for (const sc of scenes) {
        if (sc.visualBlobId) {
          const rec = await getMediaBlob(sc.visualBlobId);
          if (rec?.blob && !cancelled) {
            const url = URL.createObjectURL(rec.blob);
            created.push(url);
            next[sc.id] = url;
          }
        }
      }
      if (!cancelled) setVisualUrls(next);
    };

    void hydrate();
    return () => {
      cancelled = true;
      for (const u of created) URL.revokeObjectURL(u);
    };
  }, [scenes]);

  const setVisualMode = (mode: VisualWorkflowMode) => {
    onUpdateProject((prev) => ({
      ...prev,
      studioSettings: { ...prev.studioSettings, visualWorkflowMode: mode },
    }));
  };

  const setImageResolution = (res: ImageResolution) => {
    onUpdateProject((prev) => ({
      ...prev,
      studioSettings: { ...prev.studioSettings, imageResolution: res },
    }));
  };

  const updateScene = (id: string, patch: Partial<StoryboardScene>) => {
    onUpdateProject((prev) => ({
      ...prev,
      scenes: prev.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  };

  const handleGenerateStoryboard = async () => {
    if (chunks.length === 0) {
      onNotify('Storyboard üretmek için önce Adım 3\'te metni parçalara ayırın.', 'error');
      return;
    }
    setGeneratingBoard(true);
    setBoardStatus(`Storyboard ve 16:9 promptlar hazırlanıyor (${studioSettings.scriptModel})...`);
    try {
      const generated = await generateStoryboardScenes(
        chunks,
        editSettings.targetSceneDurationSec,
        project.topicBrief.topic,
        studioSettings,
        {
          onKeySwitch: (idx, total) => {
            if (total > 1) setBoardStatus(`Anahtar #${idx}/${total} ile storyboard üretiliyor...`);
          },
          onRetryWait: (sec) => {
            if (sec > 0) setBoardStatus(`429 Kota beklemesi: ${sec} sn...`);
          },
        }
      );

      onUpdateProject((prev) => ({
        ...prev,
        scenes: generated,
      }));
      onNotify(`${generated.length} sahnelik storyboard ve görsel promptları oluşturuldu.`);
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setGeneratingBoard(false);
      setBoardStatus('');
    }
  };

  const handleAddBlankScene = () => {
    const nextNum = scenes.length + 1;
    const newScene: StoryboardScene = {
      id: `scene_${Date.now()}_${nextNum}`,
      sceneNumber: nextNum,
      chunkIndex: chunks[chunks.length - 1]?.index || 1,
      excerpt: '',
      mediaType: 'ai_image',
      imagePrompt:
        'Cinematic 16:9 BBC documentary photography, dramatic natural lighting, 35mm Leica aesthetic, historical atmosphere, no text or watermark.',
      stockQuery: 'historical archive library candlelight',
      overlayKind: 'none',
      overlayLabel: '',
      overlayText: '',
      kenBurnsEffect: nextNum % 2 === 0 ? 'zoom_out' : 'zoom_in',
      durationSec: editSettings.targetSceneDurationSec,
      status: 'idle',
    };
    onUpdateProject((prev) => ({ ...prev, scenes: [...prev.scenes, newScene] }));
  };

  const handleCopyPrompt = async (scene: StoryboardScene) => {
    if (!scene.imagePrompt.trim()) {
      onNotify('Kopyalanacak prompt boş.', 'error');
      return;
    }
    await navigator.clipboard.writeText(scene.imagePrompt);
    setCopiedId(scene.id);
    setTimeout(() => setCopiedId(null), 1800);
    onNotify(`Sahne #${scene.sceneNumber} promptu panoya kopyalandı.`);
  };

  const attachLocalFileToScene = async (scene: StoryboardScene, file: File) => {
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      onNotify('Lütfen yalnızca görsel (PNG/JPG/WEBP) veya video (MP4/WEBM) dosyası yükleyin.', 'error');
      return;
    }
    const blobId = `visual_${project.id}_${scene.sceneNumber}_${Date.now()}`;
    if (scene.visualBlobId) {
      await deleteMediaBlob(scene.visualBlobId);
    }
    await saveMediaBlob({
      id: blobId,
      projectId: project.id,
      kind: 'visual',
      mimeType: file.type,
      blob: file,
      updatedAt: Date.now(),
    });

    updateScene(scene.id, {
      visualBlobId: blobId,
      visualMimeType: file.type,
      visualFileName: file.name,
      remoteVideoUrl: undefined,
      remoteThumbnailUrl: undefined,
      mediaType: file.type.startsWith('video/') ? 'stock_video' : 'ai_image',
      status: 'ready',
      errorMessage: undefined,
    });
    onNotify(`Sahne #${scene.sceneNumber} görseli kaydedildi (${file.name}).`);
  };

  const handleDeleteVisual = async (scene: StoryboardScene) => {
    if (scene.visualBlobId) {
      await deleteMediaBlob(scene.visualBlobId);
    }
    updateScene(scene.id, {
      visualBlobId: undefined,
      visualMimeType: undefined,
      visualFileName: undefined,
      remoteVideoUrl: undefined,
      remoteThumbnailUrl: undefined,
      remoteAuthor: undefined,
      status: 'idle',
      errorMessage: undefined,
    });
    onNotify(`Sahne #${scene.sceneNumber} görseli kaldırıldı.`);
  };

  const handleDeleteScene = async (scene: StoryboardScene) => {
    if (scene.visualBlobId) {
      await deleteMediaBlob(scene.visualBlobId);
    }
    onUpdateProject((prev) => ({
      ...prev,
      scenes: prev.scenes
        .filter((s) => s.id !== scene.id)
        .map((s, idx) => ({ ...s, sceneNumber: idx + 1 })),
    }));
  };

  const handleGenerateSingleAiImage = async (scene: StoryboardScene, signal?: AbortSignal) => {
    if (!scene.imagePrompt.trim()) {
      onNotify('Lütfen önce görsel promptunu yazın.', 'error');
      return;
    }
    setBusySceneId(scene.id);
    updateScene(scene.id, { status: 'generating', errorMessage: undefined });

    try {
      const { imageBase64, mimeType } = await generateSceneImage(
        scene.imagePrompt,
        studioSettings,
        {
          signal,
          onRetryWait: (sec) => {
            if (sec > 0) setBatchStatus(`429 Kota beklemesi: ${sec} sn...`);
          },
        }
      );

      const blob = base64ToBlob(imageBase64, mimeType);
      const blobId = `visual_${project.id}_${scene.sceneNumber}_${Date.now()}`;
      if (scene.visualBlobId) {
        await deleteMediaBlob(scene.visualBlobId);
      }

      await saveMediaBlob({
        id: blobId,
        projectId: project.id,
        kind: 'visual',
        mimeType,
        blob,
        updatedAt: Date.now(),
      });

      updateScene(scene.id, {
        visualBlobId: blobId,
        visualMimeType: mimeType,
        visualFileName: `scene_${String(scene.sceneNumber).padStart(3, '0')}.png`,
        remoteVideoUrl: undefined,
        remoteThumbnailUrl: undefined,
        mediaType: 'ai_image',
        status: 'ready',
        errorMessage: undefined,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if ((err as Error).name !== 'AbortError') {
        updateScene(scene.id, { status: 'error', errorMessage: msg });
      } else {
        updateScene(scene.id, { status: scene.visualBlobId ? 'ready' : 'idle' });
      }
      throw err;
    } finally {
      setBusySceneId(null);
    }
  };

  const handleGenerateAllMissingImages = async () => {
    const missing = scenes.filter(
      (s) => s.mediaType === 'ai_image' && !s.visualBlobId && !s.remoteVideoUrl
    );
    if (missing.length === 0) {
      onNotify('Üretilecek eksik AI görsel sahnesi bulunmuyor.');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setBatchRunning(true);
    const delayMs = getEffectiveDelayMs(studioSettings);

    try {
      for (let i = 0; i < missing.length; i++) {
        if (controller.signal.aborted) break;
        const sc = missing[i];
        setBatchStatus(`(${i + 1}/${missing.length}) Sahne #${sc.sceneNumber} görseli üretiliyor...`);
        try {
          await handleGenerateSingleAiImage(sc, controller.signal);
        } catch (err) {
          if ((err as Error).name === 'AbortError') throw err;
          onNotify(`Sahne #${sc.sceneNumber} hatası: ${(err as Error).message}`, 'error');
        }
        if (i + 1 < missing.length && delayMs > 0) {
          await sleepWithAbort(delayMs, controller.signal);
        }
      }
      onNotify('Toplu AI görsel üretimi tamamlandı.');
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        onNotify('Toplu görsel üretimi durduruldu.');
      }
    } finally {
      setBatchRunning(false);
      setBatchStatus('');
      abortRef.current = null;
    }
  };

  const openPexelsForScene = async (scene: StoryboardScene) => {
    setPexelsScene(scene);
    const q = scene.stockQuery || 'documentary cinema landscape';
    setPexelsQuery(q);
    setPexelsError('');
    await runPexelsSearch(q);
  };

  const runPexelsSearch = async (query: string) => {
    setPexelsLoading(true);
    setPexelsError('');
    try {
      const results = await searchPexelsVideos(query, studioSettings);
      setPexelsResults(results);
      if (results.length === 0) {
        setPexelsError('Bu sorgu için 16:9 yatay stok video bulunamadı. Farklı İngilizce kelimeler deneyin.');
      }
    } catch (err) {
      setPexelsResults([]);
      setPexelsError((err as Error).message);
    } finally {
      setPexelsLoading(false);
    }
  };

  const selectPexelsClip = async (video: PexelsVideoItem) => {
    if (!pexelsScene) return;
    if (pexelsScene.visualBlobId) {
      await deleteMediaBlob(pexelsScene.visualBlobId);
    }
    updateScene(pexelsScene.id, {
      mediaType: 'stock_video',
      visualBlobId: undefined,
      visualMimeType: 'video/mp4',
      visualFileName: `pexels_${video.id}.mp4`,
      remoteVideoUrl: video.videoUrl,
      remoteThumbnailUrl: video.thumbnail,
      remoteAuthor: video.author,
      status: 'ready',
      errorMessage: undefined,
    });
    onNotify(`Sahne #${pexelsScene.sceneNumber} için Pexels klibi bağlandı.`);
    setPexelsScene(null);
  };

  const readyVisualCount = scenes.filter(
    (s) => Boolean(s.visualBlobId || s.remoteVideoUrl)
  ).length;
  const missingAiCount = scenes.filter(
    (s) => s.mediaType === 'ai_image' && !s.visualBlobId && !s.remoteVideoUrl
  ).length;
  const estimatedUsd =
    missingAiCount * (NANO_BANANA_ESTIMATED_USD[studioSettings.imageResolution] || 0.08);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-slate-800/80 pb-5">
        <div className="space-y-1.5">
          <p className="text-xs font-mono text-[#D99B26]">Adım 04 · Görsel Yönetmenlik</p>
          <h1 className="font-editorial text-3xl font-semibold text-slate-100">
            Storyboard, Promptlar ve Görsel Varlıklar
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
            <span>{scenes.length} sahne</span>
            <span aria-hidden="true">·</span>
            <span className="text-emerald-400">{readyVisualCount} görsel/video hazır</span>
            <span aria-hidden="true">·</span>
            <span>
              Mod:{' '}
              {visualMode === 'manual_free'
                ? 'Sıfır Maliyetli Manuel (Ücretsiz)'
                : `Otomatik API (${studioSettings.imageModel} · ${studioSettings.imageResolution})`}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2 bg-[#131924] border border-slate-800 rounded-xl px-3 py-1.5 text-xs">
            <span className="text-slate-400">Sahne süresi:</span>
            <input
              type="number"
              min={8}
              max={45}
              value={editSettings.targetSceneDurationSec}
              onChange={(e) =>
                onUpdateProject((prev) => ({
                  ...prev,
                  editSettings: {
                    ...prev.editSettings,
                    targetSceneDurationSec: Math.max(8, Number(e.target.value) || 18),
                  },
                }))
              }
              className="w-12 bg-[#0B0F17] border border-slate-800 rounded px-1.5 py-0.5 text-center font-mono tabular-nums text-slate-100"
            />
            <span className="text-slate-400">sn</span>
          </div>

          <button
            type="button"
            disabled={generatingBoard || chunks.length === 0}
            onClick={handleGenerateStoryboard}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] disabled:opacity-40 rounded-xl cursor-pointer whitespace-nowrap"
          >
            {generatingBoard ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            <span>
              {generatingBoard ? 'Üretiliyor...' : 'Metinden Storyboard ve Promptları Oluştur'}
            </span>
          </button>

          <button
            type="button"
            onClick={handleAddBlankScene}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-slate-200 bg-[#131924] hover:bg-[#1A2230] border border-slate-800 rounded-xl cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Sahne Ekle</span>
          </button>

          <button
            type="button"
            disabled={scenes.length === 0}
            onClick={onNextStep}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-100 bg-[#1A2230] hover:bg-[#232F42] border border-slate-700 disabled:opacity-40 rounded-xl cursor-pointer"
          >
            <span>Kurgu &amp; Önizleme</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Visual Workflow Mode Switcher Bar */}
      <div className="bg-[#131924] border border-slate-800/80 rounded-2xl p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-2">
          <div className="inline-flex items-center p-1 bg-[#0B0F17] border border-slate-800 rounded-xl">
            <button
              type="button"
              onClick={() => setVisualMode('manual_free')}
              className={`px-3.5 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                visualMode === 'manual_free'
                  ? 'bg-[#1F293A] text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Sıfır Maliyetli Manuel Mod (Ücretsiz)
            </button>
            <button
              type="button"
              onClick={() => setVisualMode('auto_api')}
              className={`px-3.5 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                visualMode === 'auto_api'
                  ? 'bg-[#1F293A] text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Otomatik API Modu (Opsiyonel — Nano Banana 2.1)
            </button>
          </div>

          <p className="text-xs text-slate-400">
            {visualMode === 'manual_free'
              ? 'Her sahnede "Promptu Kopyala" ile promptu kopyalayıp Gemini Web veya dilediğiniz araçtan indirdiğiniz görseli doğrudan sahne kartına sürükleyip bırakabilirsiniz. Pexels stok video araması da açıktır.'
              : 'Otomatik görsel üretimi Ayarlar çekmecesindeki görsel modeli ve API anahtarını kullanır. Ücretli model kullanıyorsanız Ayarlar’dan ücretli anahtarınızı eklediğinizden emin olun.'}
          </p>
        </div>

        {/* Auto API Controls & Cost Estimator (only shown when user switches to auto_api) */}
        {visualMode === 'auto_api' && (
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-slate-800 rounded-lg text-xs font-mono">
              {(['1K', '2K', '4K'] as ImageResolution[]).map((res) => (
                <button
                  key={res}
                  type="button"
                  onClick={() => setImageResolution(res)}
                  className={`px-2.5 py-1 rounded-md cursor-pointer ${
                    studioSettings.imageResolution === res
                      ? 'bg-[#D99B26] text-[#0B0F17] font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {res}
                </button>
              ))}
            </div>

            <div className="text-xs font-mono tabular-nums text-slate-300 bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2">
              Tahmini Maliyet: <span className="text-[#F3C669]">${estimatedUsd.toFixed(2)} USD</span>{' '}
              <span className="text-slate-500">({missingAiCount} sahne)</span>
            </div>

            {!batchRunning ? (
              <button
                type="button"
                disabled={missingAiCount === 0}
                onClick={handleGenerateAllMissingImages}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] disabled:opacity-40 rounded-xl cursor-pointer whitespace-nowrap"
              >
                <ImageIcon className="w-3.5 h-3.5" />
                <span>Tüm Eksik AI Görselleri Üret</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-red-200 bg-red-500/20 hover:bg-red-500/30 rounded-xl cursor-pointer"
              >
                <Square className="w-3.5 h-3.5" />
                <span>Durdur</span>
              </button>
            )}
          </div>
        )}
      </div>

      {(boardStatus || batchStatus) && (
        <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-[#161E2E] border border-[#D99B26]/40 text-xs text-slate-200 font-mono">
          <Loader2 className="w-4 h-4 animate-spin text-[#D99B26]" />
          <span>{boardStatus || batchStatus}</span>
        </div>
      )}

      {/* Scene Cards */}
      {scenes.length === 0 ? (
        <div className="bg-[#131924] border border-slate-800 rounded-2xl p-12 text-center space-y-3">
          <p className="text-sm text-slate-300">
            Henüz sahne oluşturulmadı. Yukarıdaki{' '}
            <strong>&quot;Metinden Storyboard ve Promptları Oluştur&quot;</strong> butonuna tıklayarak
            senaryonuzu zamanlanmış 16:9 sahnelere bölebilirsiniz.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {scenes.map((scene) => {
            const localUrl = visualUrls[scene.id];
            const isVideo =
              Boolean(scene.remoteVideoUrl) ||
              Boolean(scene.visualMimeType?.startsWith('video/'));
            const hasMedia = Boolean(localUrl || scene.remoteVideoUrl);
            const isBusy = busySceneId === scene.id || scene.status === 'generating';

            return (
              <article
                key={scene.id}
                className="bg-[#131924] border border-slate-800/80 rounded-2xl p-5 grid grid-cols-1 lg:grid-cols-12 gap-6"
              >
                {/* Left 5 cols: 16:9 Visual Dropzone & Preview */}
                <div className="lg:col-span-5 space-y-3">
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverId(scene.id);
                    }}
                    onDragLeave={() => setDragOverId(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverId(null);
                      const file = e.dataTransfer.files?.[0];
                      if (file) void attachLocalFileToScene(scene, file);
                    }}
                    className={`relative aspect-video rounded-xl overflow-hidden border transition-colors bg-[#0B0F17] flex items-center justify-center ${
                      dragOverId === scene.id
                        ? 'border-[#D99B26] ring-2 ring-[#D99B26]/30'
                        : 'border-slate-800'
                    }`}
                  >
                    {hasMedia ? (
                      isVideo ? (
                        <video
                          src={localUrl || scene.remoteVideoUrl}
                          poster={scene.remoteThumbnailUrl}
                          controls
                          muted
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <img
                          src={localUrl}
                          alt={`Sahne ${scene.sceneNumber}`}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      )
                    ) : (
                      <label className="w-full h-full flex flex-col items-center justify-center p-6 text-center cursor-pointer hover:bg-slate-800/30 transition-colors">
                        <Upload className="w-7 h-7 text-slate-500 mb-2.5" />
                        <span className="text-xs font-medium text-slate-300">
                          Görseli veya videoyu buraya sürükleyip bırakın
                        </span>
                        <span className="text-[11px] text-slate-500 mt-1">
                          veya bilgisayarınızdan 16:9 PNG / JPG / MP4 seçin
                        </span>
                        <input
                          type="file"
                          accept="image/*,video/*"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void attachLocalFileToScene(scene, f);
                            e.target.value = '';
                          }}
                          className="hidden"
                        />
                      </label>
                    )}

                    {isBusy && (
                      <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2 text-xs text-slate-200">
                        <Loader2 className="w-6 h-6 animate-spin text-[#D99B26]" />
                        <span>Görsel üretiliyor...</span>
                      </div>
                    )}
                  </div>

                  {/* Quick Media Actions Under 16:9 Box */}
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-200 bg-[#1A2230] hover:bg-[#232F42] border border-slate-700/80 rounded-lg cursor-pointer">
                      <Upload className="w-3.5 h-3.5 text-[#D99B26]" />
                      <span>{hasMedia ? 'Değiştir (Yükle)' : 'Dosya Yükle'}</span>
                      <input
                        type="file"
                        accept="image/*,video/*"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void attachLocalFileToScene(scene, f);
                          e.target.value = '';
                        }}
                        className="hidden"
                      />
                    </label>

                    <button
                      type="button"
                      onClick={() => void openPexelsForScene(scene)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-200 bg-[#0E131D] hover:bg-slate-800 border border-slate-800 rounded-lg cursor-pointer"
                    >
                      <Film className="w-3.5 h-3.5 text-slate-400" />
                      <span>Pexels Ara</span>
                    </button>

                    {visualMode === 'auto_api' && (
                      <button
                        type="button"
                        disabled={isBusy || batchRunning}
                        onClick={async () => {
                          try {
                            await handleGenerateSingleAiImage(scene);
                            onNotify(`Sahne #${scene.sceneNumber} görseli üretildi.`);
                          } catch (err) {
                            if ((err as Error).name !== 'AbortError') {
                              onNotify((err as Error).message, 'error');
                            }
                          }
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] disabled:opacity-50 rounded-lg cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>{hasMedia ? 'AI Yeniden Üret' : 'AI Üret'}</span>
                      </button>
                    )}

                    {hasMedia && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteVisual(scene)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-400 hover:text-red-300 border border-slate-800 rounded-lg hover:bg-red-500/10 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Görseli Sil</span>
                      </button>
                    )}
                  </div>

                  {scene.errorMessage && (
                    <p className="text-xs text-red-400 bg-red-950/30 border border-red-900/40 rounded-lg p-2.5">
                      {scene.errorMessage}
                    </p>
                  )}
                </div>

                {/* Right 7 cols: Metadata, Prompt, Copy Button, Stock Query, Overlays, Ken Burns */}
                <div className="lg:col-span-7 space-y-4">
                  <div className="flex items-center justify-between gap-2 border-b border-slate-800/70 pb-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums">
                      <span className="font-semibold text-slate-100">
                        Sahne #{String(scene.sceneNumber).padStart(2, '0')}
                      </span>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <span className="text-slate-400">Ses Parçası #{scene.chunkIndex}</span>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <span className="text-slate-400">{scene.durationSec} sn</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <select
                        value={scene.kenBurnsEffect}
                        onChange={(e) =>
                          updateScene(scene.id, {
                            kenBurnsEffect: e.target.value as KenBurnsEffect,
                          })
                        }
                        title="Ken Burns Kamera Hareketi"
                        className="bg-[#0B0F17] border border-slate-800 rounded-lg px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-[#D99B26]/60"
                      >
                        <option value="zoom_in">Ken Burns: Yakınlaş</option>
                        <option value="zoom_out">Ken Burns: Uzaklaş</option>
                        <option value="pan_left">Ken Burns: Sola Kaydır</option>
                        <option value="pan_right">Ken Burns: Sağa Kaydır</option>
                        <option value="none">Hareket Yok (Sabit)</option>
                      </select>

                      <button
                        type="button"
                        onClick={() => void handleDeleteScene(scene)}
                        title="Sahneyi sil"
                        className="p-1.5 text-slate-500 hover:text-red-400 rounded-lg hover:bg-red-500/10 cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Spoken Excerpt */}
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Bu Sahnede Okunan Metin (Alıntı)
                    </label>
                    <input
                      type="text"
                      value={scene.excerpt}
                      onChange={(e) => updateScene(scene.id, { excerpt: e.target.value })}
                      className="w-full bg-[#0B0F17] border border-slate-800/80 rounded-lg px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-[#D99B26]/60"
                    />
                  </div>

                  {/* Image Prompt + One-Click Copy */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] font-medium text-slate-300">
                        16:9 Görsel Promptu (Gemini Web / Nano Banana için)
                      </label>
                      <button
                        type="button"
                        onClick={() => void handleCopyPrompt(scene)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[#F3C669] bg-[#D99B26]/15 hover:bg-[#D99B26]/25 rounded-md transition-colors cursor-pointer"
                      >
                        {copiedId === scene.id ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        <span>{copiedId === scene.id ? 'Kopyalandı' : 'Promptu Kopyala'}</span>
                      </button>
                    </div>
                    <textarea
                      rows={3}
                      value={scene.imagePrompt}
                      onChange={(e) => updateScene(scene.id, { imagePrompt: e.target.value })}
                      className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg p-3 text-xs leading-relaxed text-slate-200 focus:outline-none focus:border-[#D99B26]/60"
                    />
                  </div>

                  {/* Stock Query & Overlay Controls */}
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                    <div className="md:col-span-5">
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Pexels Stok Video Sorgusu (EN)
                      </label>
                      <input
                        type="text"
                        value={scene.stockQuery}
                        onChange={(e) => updateScene(scene.id, { stockQuery: e.target.value })}
                        className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[#D99B26]/60"
                      />
                    </div>

                    <div className="md:col-span-3">
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Ekran Katmanı (Overlay)
                      </label>
                      <select
                        value={scene.overlayKind}
                        onChange={(e) =>
                          updateScene(scene.id, {
                            overlayKind: e.target.value as OverlayKind,
                          })
                        }
                        className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[#D99B26]/60"
                      >
                        <option value="none">Katman Yok</option>
                        <option value="bolum">Bölüm Alt Bandı</option>
                        <option value="ayet">Ayet / Alıntı Kutusu</option>
                        <option value="etiket">Referans Etiketi</option>
                      </select>
                    </div>

                    <div className="md:col-span-4">
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Katman Başlık / Kaynak
                      </label>
                      <input
                        type="text"
                        disabled={scene.overlayKind === 'none'}
                        value={scene.overlayLabel}
                        onChange={(e) => updateScene(scene.id, { overlayLabel: e.target.value })}
                        placeholder="Örn: En'âm:38"
                        className="w-full bg-[#0B0F17] border border-slate-800 disabled:opacity-40 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[#D99B26]/60"
                      />
                    </div>
                  </div>

                  {scene.overlayKind !== 'none' && (
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Ekranda Görünecek Katman Metni
                      </label>
                      <input
                        type="text"
                        value={scene.overlayText}
                        onChange={(e) => updateScene(scene.id, { overlayText: e.target.value })}
                        placeholder="Ekranda gösterilecek bölüm başlığı, ayet meali veya referans..."
                        className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-[#D99B26]/60"
                      />
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Pexels Stock Video Picker Modal */}
      {pexelsScene && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs">
          <div className="w-full max-w-4xl bg-[#111722] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between gap-4">
              <div>
                <h2 className="font-editorial text-lg font-semibold text-slate-100">
                  Pexels 16:9 Stok Video Seçici — Sahne #{pexelsScene.sceneNumber}
                </h2>
                <p className="text-xs text-slate-400">
                  Yalnızca yatay (16:9) HD klipler listelenir.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPexelsScene(null)}
                className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void runPexelsSearch(pexelsQuery);
              }}
              className="p-4 border-b border-slate-800 bg-[#0E131D] flex gap-2.5"
            >
              <input
                type="text"
                value={pexelsQuery}
                onChange={(e) => setPexelsQuery(e.target.value)}
                placeholder="İngilizce arama sorgusu (örn. ancient desert caves)..."
                className="flex-1 bg-[#0B0F17] border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-[#D99B26]/60"
              />
              <button
                type="submit"
                disabled={pexelsLoading}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] rounded-lg cursor-pointer"
              >
                {pexelsLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Search className="w-4 h-4" />
                )}
                <span>Ara</span>
              </button>
            </form>

            <div className="flex-1 overflow-y-auto p-5">
              {pexelsError ? (
                <div className="p-6 rounded-xl bg-[#0B0F17] border border-slate-800 text-center space-y-3">
                  <p className="text-sm text-amber-300">{pexelsError}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setPexelsScene(null);
                      onOpenSettings();
                    }}
                    className="px-4 py-2 text-xs font-medium text-[#0B0F17] bg-[#D99B26] rounded-lg cursor-pointer"
                  >
                    Ayarlar&apos;dan Pexels Anahtarı Ekle
                  </button>
                </div>
              ) : pexelsLoading ? (
                <div className="py-16 flex flex-col items-center gap-3 text-xs text-slate-400">
                  <Loader2 className="w-6 h-6 animate-spin text-[#D99B26]" />
                  <span>Pexels klipleri aranıyor...</span>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {pexelsResults.map((vid) => (
                    <div
                      key={vid.id}
                      className="bg-[#0B0F17] border border-slate-800 rounded-xl overflow-hidden flex flex-col"
                    >
                      <div className="aspect-video bg-black relative">
                        <video
                          src={vid.previewUrl}
                          poster={vid.thumbnail}
                          controls
                          muted
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div className="p-3 flex items-center justify-between gap-2 text-xs">
                        <div className="text-slate-400 font-mono tabular-nums truncate">
                          {vid.author} · {vid.duration}s · {vid.width}×{vid.height}
                        </div>
                        <button
                          type="button"
                          onClick={() => void selectPexelsClip(vid)}
                          className="px-3 py-1.5 text-xs font-semibold text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] rounded-lg cursor-pointer shrink-0"
                        >
                          Bu Klibi Seç
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
