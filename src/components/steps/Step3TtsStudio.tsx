import React, { useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Download,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Volume2,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { AudioChunk, BatchProgressState, ProjectRecord } from '../../types/studio';
import {
  computeChunkCacheHash,
  preprocessTurkishScript,
} from '../../utils/turkishTTSPreprocessor';
import {
  decodeTtsAudioToWavBlob,
  formatDurationClock,
  mergeWavBlobsWithPauses,
} from '../../utils/wavEncoder';
import {
  getEffectiveDelayMs,
  sleepWithAbort,
  synthesizeChunkAudio,
} from '../../services/geminiService';
import { deleteMediaBlob, getMediaBlob, saveMediaBlob } from '../../utils/storageDb';
import { triggerBrowserDownload } from '../../utils/renderScriptGenerator';

interface Step3TtsStudioProps {
  project: ProjectRecord;
  onUpdateProject: (updater: (prev: ProjectRecord) => ProjectRecord) => void;
  onNextStep: () => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

export const Step3TtsStudio: React.FC<Step3TtsStudioProps> = ({
  project,
  onUpdateProject,
  onNextStep,
  onNotify,
}) => {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [busyChunkId, setBusyChunkId] = useState<string | null>(null);
  const [downloadingAudio, setDownloadingAudio] = useState(false);
  const [batch, setBatch] = useState<BatchProgressState>({
    running: false,
    paused: false,
    total: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    currentLabel: '',
    startedAt: 0,
  });

  const abortRef = useRef<AbortController | null>(null);
  const pausedRef = useRef(false);

  const { studioSettings, chunks, rawScript } = project;

  // Auto-run preprocessor if script exists and chunks are empty
  useEffect(() => {
    if (rawScript.trim() && chunks.length === 0) {
      void runPreprocessor(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hydrate Object URLs for ready audio blobs stored in IndexedDB
  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];

    const loadUrls = async () => {
      const nextMap: Record<string, string> = {};
      for (const c of chunks) {
        if (c.audioBlobId) {
          const rec = await getMediaBlob(c.audioBlobId);
          if (rec?.blob && !cancelled) {
            const url = URL.createObjectURL(rec.blob);
            createdUrls.push(url);
            nextMap[c.id] = url;
          }
        }
      }
      if (!cancelled) {
        setAudioUrls(nextMap);
      }
    };

    void loadUrls();

    return () => {
      cancelled = true;
      for (const u of createdUrls) {
        URL.revokeObjectURL(u);
      }
    };
  }, [chunks]);

  const runPreprocessor = async (
    showToast = true,
    overrides?: { excludeChapterPrefix?: boolean; speakBolumTag?: boolean }
  ) => {
    if (!rawScript.trim()) {
      if (showToast) onNotify('Ön işleme için Adım 2\'de senaryo metni bulunmalıdır.', 'error');
      return;
    }
    const excludePrefix =
      overrides?.excludeChapterPrefix !== undefined
        ? overrides.excludeChapterPrefix
        : studioSettings.excludeChapterPrefix;
    const speakBolum =
      overrides?.speakBolumTag !== undefined
        ? overrides.speakBolumTag
        : studioSettings.speakBolumTag ?? true;

    const nextChunks = await preprocessTurkishScript(
      rawScript,
      {
        excludeChapterPrefix: excludePrefix,
        speakBolumTag: speakBolum,
        maxChunkSize: studioSettings.maxChunkSize,
        model: studioSettings.ttsModel,
        voice: studioSettings.ttsVoice,
        style: studioSettings.ttsStylePrompt,
      },
      chunks
    );

    onUpdateProject((prev) => ({
      ...prev,
      studioSettings: {
        ...prev.studioSettings,
        excludeChapterPrefix: excludePrefix,
        speakBolumTag: speakBolum,
      },
      chunks: nextChunks,
    }));

    if (showToast) {
      const cachedCount = nextChunks.filter((c) => c.status === 'cached').length;
      onNotify(
        `${nextChunks.length} ses parçası hazırlandı${cachedCount > 0 ? ` (${cachedCount} parça önbellekten korundu)` : ''}.`
      );
    }
  };

  const handleEditCleanedText = async (chunk: AudioChunk, nextText: string) => {
    const newHash = await computeChunkCacheHash(
      studioSettings.ttsModel,
      studioSettings.ttsVoice,
      studioSettings.ttsStylePrompt,
      nextText
    );
    onUpdateProject((prev) => ({
      ...prev,
      chunks: prev.chunks.map((c) =>
        c.id === chunk.id
          ? {
              ...c,
              cleanedText: nextText,
              cacheHash: newHash,
              status:
                c.audioBlobId && c.generatedHash === newHash
                  ? 'cached'
                  : c.audioBlobId
                    ? 'idle' // text changed -> needs regen
                    : 'idle',
            }
          : c
      ),
    }));
  };

  const generateSingleChunk = async (
    chunk: AudioChunk,
    signal?: AbortSignal,
    onProgressHooks?: {
      onKeySwitch?: (idx: number, total: number) => void;
      onRetryWait?: (sec: number) => void;
    }
  ): Promise<boolean> => {
    setBusyChunkId(chunk.id);
    onUpdateProject((prev) => ({
      ...prev,
      chunks: prev.chunks.map((c) =>
        c.id === chunk.id ? { ...c, status: 'generating', errorMessage: undefined } : c
      ),
    }));

    try {
      const { audioBase64, mimeType } = await synthesizeChunkAudio(
        chunk.cleanedText,
        studioSettings,
        {
          signal,
          onKeySwitch: onProgressHooks?.onKeySwitch,
          onRetryWait: onProgressHooks?.onRetryWait,
        }
      );

      const { blob, durationSec } = decodeTtsAudioToWavBlob(audioBase64, mimeType);
      const blobId = `audio_${project.id}_${chunk.index}_${Date.now()}`;

      // Clean old blob if regenerating
      if (chunk.audioBlobId) {
        await deleteMediaBlob(chunk.audioBlobId);
      }

      await saveMediaBlob({
        id: blobId,
        projectId: project.id,
        kind: 'audio',
        mimeType: 'audio/wav',
        blob,
        updatedAt: Date.now(),
      });

      const currentHash = await computeChunkCacheHash(
        studioSettings.ttsModel,
        studioSettings.ttsVoice,
        studioSettings.ttsStylePrompt,
        chunk.cleanedText
      );

      onUpdateProject((prev) => ({
        ...prev,
        chunks: prev.chunks.map((c) =>
          c.id === chunk.id
            ? {
                ...c,
                audioBlobId: blobId,
                durationSec,
                cacheHash: currentHash,
                generatedHash: currentHash,
                status: 'ready',
                errorMessage: undefined,
              }
            : c
        ),
      }));
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      if ((err as Error).name !== 'AbortError') {
        onUpdateProject((prev) => ({
          ...prev,
          chunks: prev.chunks.map((c) =>
            c.id === chunk.id ? { ...c, status: 'error', errorMessage: msg } : c
          ),
        }));
      } else {
        onUpdateProject((prev) => ({
          ...prev,
          chunks: prev.chunks.map((c) =>
            c.id === chunk.id
              ? { ...c, status: c.audioBlobId ? 'ready' : 'idle' }
              : c
          ),
        }));
      }
      throw err;
    } finally {
      setBusyChunkId(null);
    }
  };

  const handleDeleteChunkAudio = async (chunk: AudioChunk) => {
    if (chunk.audioBlobId) {
      await deleteMediaBlob(chunk.audioBlobId);
    }
    onUpdateProject((prev) => ({
      ...prev,
      chunks: prev.chunks.map((c) =>
        c.id === chunk.id
          ? {
              ...c,
              audioBlobId: undefined,
              generatedHash: undefined,
              durationSec: undefined,
              status: 'idle',
              errorMessage: undefined,
            }
          : c
      ),
    }));
    onNotify(`Parça #${chunk.index} sesi silindi. Yeniden üretebilirsiniz.`);
  };

  const handleRemoveChunkCompletely = async (chunk: AudioChunk) => {
    if (chunk.audioBlobId) {
      await deleteMediaBlob(chunk.audioBlobId);
    }
    onUpdateProject((prev) => ({
      ...prev,
      chunks: prev.chunks
        .filter((c) => c.id !== chunk.id)
        .map((c, idx) => ({ ...c, index: idx + 1 })),
    }));
    onNotify(`Parça #${chunk.index} listeden kaldırıldı.`);
  };

  const handleGenerateMissingBatch = async () => {
    const pending = chunks.filter(
      (c) => !c.audioBlobId || c.generatedHash !== c.cacheHash
    );
    const skippedCount = chunks.length - pending.length;

    if (pending.length === 0) {
      onNotify('Tüm ses parçaları güncel ve önbellekten hazır!');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    pausedRef.current = false;

    const delayMs = getEffectiveDelayMs(studioSettings);

    setBatch({
      running: true,
      paused: false,
      total: pending.length,
      completed: 0,
      skipped: skippedCount,
      failed: 0,
      currentLabel: `Parça #${pending[0].index} hazırlanıyor...`,
      startedAt: Date.now(),
    });

    let completed = 0;
    let failed = 0;

    try {
      for (let i = 0; i < pending.length; i++) {
        // Handle Pause loop
        while (pausedRef.current && !controller.signal.aborted) {
          await sleepWithAbort(300, controller.signal);
        }
        if (controller.signal.aborted) break;

        const ch = pending[i];
        setBatch((prev) => ({
          ...prev,
          currentLabel: `Parça #${ch.index} seslendiriliyor (${ch.chapterTitle})...`,
          waitCountdownSec: 0,
        }));

        try {
          await generateSingleChunk(ch, controller.signal, {
            onKeySwitch: (idx, total) => {
              setBatch((prev) => ({ ...prev, activeKeyIndex: idx, totalKeys: total }));
            },
            onRetryWait: (sec) => {
              setBatch((prev) => ({ ...prev, waitCountdownSec: sec }));
            },
          });
          completed += 1;
        } catch (err) {
          if ((err as Error).name === 'AbortError') throw err;
          failed += 1;
          onNotify(`Parça #${ch.index} hatası: ${(err as Error).message}`, 'error');
        }

        setBatch((prev) => ({ ...prev, completed, failed }));

        if (i + 1 < pending.length && delayMs > 0) {
          await sleepWithAbort(delayMs, controller.signal);
        }
      }

      onNotify(
        `Toplu seslendirme tamamlandı: ${completed} üretildi, ${skippedCount} önbellekten atlandı${failed > 0 ? `, ${failed} hata` : ''}.`
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        onNotify('Toplu seslendirme durduruldu.');
      }
    } finally {
      setBatch((prev) => ({ ...prev, running: false, paused: false, waitCountdownSec: 0 }));
      abortRef.current = null;
    }
  };

  const handleDownloadMergedWav = async () => {
    const readyChunks = chunks.filter((c) => Boolean(c.audioBlobId));
    if (readyChunks.length === 0) {
      onNotify('İndirilecek hazır ses parçası yok.', 'error');
      return;
    }
    setDownloadingAudio(true);
    try {
      const items: Array<{ blob: Blob; isChapterStart: boolean }> = [];
      for (const ch of readyChunks) {
        if (!ch.audioBlobId) continue;
        const rec = await getMediaBlob(ch.audioBlobId);
        if (rec?.blob) {
          items.push({ blob: rec.blob, isChapterStart: ch.isChapterStart });
        }
      }
      const merged = await mergeWavBlobsWithPauses(
        items,
        studioSettings.normalPauseMs,
        studioSettings.chapterPauseMs
      );
      triggerBrowserDownload(merged, `${project.name.replace(/\s+/g, '_')}_tam_ses.wav`);
      onNotify('Birleştirilmiş tam .WAV dosyası indirildi.');
    } catch (err) {
      onNotify(`WAV birleştirme hatası: ${(err as Error).message}`, 'error');
    } finally {
      setDownloadingAudio(false);
    }
  };

  const handleDownloadAudioZip = async () => {
    const readyChunks = chunks.filter((c) => Boolean(c.audioBlobId));
    if (readyChunks.length === 0) {
      onNotify('İndirilecek hazır ses parçası yok.', 'error');
      return;
    }
    setDownloadingAudio(true);
    try {
      const zip = new JSZip();
      for (const ch of readyChunks) {
        if (!ch.audioBlobId) continue;
        const rec = await getMediaBlob(ch.audioBlobId);
        if (rec?.blob) {
          zip.file(`chunk_${String(ch.index).padStart(3, '0')}.wav`, rec.blob);
        }
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      triggerBrowserDownload(blob, `${project.name.replace(/\s+/g, '_')}_sesler.zip`);
      onNotify(`${readyChunks.length} adet .WAV dosyası ZIP olarak indirildi.`);
    } catch (err) {
      onNotify(`ZIP oluşturma hatası: ${(err as Error).message}`, 'error');
    } finally {
      setDownloadingAudio(false);
    }
  };

  const readyCount = chunks.filter(
    (c) => Boolean(c.audioBlobId) && c.generatedHash === c.cacheHash
  ).length;
  const totalDurationSec = chunks.reduce((acc, c) => acc + (c.durationSec || 0), 0);

  // Compute ETA during batch
  const etaSec = (() => {
    if (!batch.running || batch.completed === 0) return null;
    const elapsedSec = (Date.now() - batch.startedAt) / 1000;
    const avgPerItem = elapsedSec / batch.completed;
    const remaining = Math.max(0, batch.total - batch.completed - batch.failed);
    return Math.round(avgPerItem * remaining);
  })();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-slate-800/80 pb-5">
        <div className="space-y-1.5">
          <p className="text-xs font-mono text-[#D99B26]">Adım 03 · Türkçe Ses Stüdyosu (TTS)</p>
          <h1 className="font-editorial text-3xl font-semibold text-slate-100">
            Türkçe Ön İşleyici ve Ses Parça Yöneticisi
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
            <span>{chunks.length} parça</span>
            <span aria-hidden="true">·</span>
            <span className="text-emerald-400">{readyCount} hazır/önbellekte</span>
            <span aria-hidden="true">·</span>
            <span>Toplam Süre: {formatDurationClock(totalDurationSec)}</span>
            <span aria-hidden="true">·</span>
            <span>
              {studioSettings.ttsModel} ({studioSettings.ttsVoice})
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => void runPreprocessor(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#131924] hover:bg-[#1A2230] border border-slate-700/80 rounded-xl cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Metni Yeniden İşle</span>
          </button>

          <button
            type="button"
            disabled={downloadingAudio || readyCount === 0}
            onClick={handleDownloadMergedWav}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#131924] hover:bg-[#1A2230] border border-slate-800 disabled:opacity-40 rounded-xl cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Tam .WAV</span>
          </button>

          <button
            type="button"
            disabled={downloadingAudio || readyCount === 0}
            onClick={handleDownloadAudioZip}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#131924] hover:bg-[#1A2230] border border-slate-800 disabled:opacity-40 rounded-xl cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Sesler (.ZIP)</span>
          </button>

          <button
            type="button"
            onClick={onNextStep}
            disabled={chunks.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] disabled:opacity-40 rounded-xl cursor-pointer"
          >
            <span>Storyboard&apos;a Geç</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Studio Control Strip (Exclude Chapter Prefix + Speak [[BOLUM]] + Batch Generate) */}
      <div className="bg-[#131924] border border-slate-800/80 rounded-2xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-3 max-w-2xl">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={studioSettings.excludeChapterPrefix}
              onChange={(e) =>
                void runPreprocessor(true, { excludeChapterPrefix: e.target.checked })
              }
              className="mt-1 h-4 w-4 accent-[#D99B26] rounded cursor-pointer shrink-0"
            />
            <div>
              <div className="text-sm font-medium text-slate-100">
                Bölüm ön eklerini seslendirmeden çıkar (Exclude &quot;BÖLÜM X:&quot; / &quot;BÖLÜM
                iki:&quot;)
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {studioSettings.excludeChapterPrefix
                  ? 'Aktif: Yalnızca bölüm başlığı okunur; rakamlı ve yazıyla yazılmış BÖLÜM ön ekleri tamamen temizlenir.'
                  : 'Kapalı: Bölüm numaraları Türkçe sıra sayısına dönüştürülerek okunur (örn. İkinci Bölüm: ...).'}
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={studioSettings.speakBolumTag ?? true}
              onChange={(e) => void runPreprocessor(true, { speakBolumTag: e.target.checked })}
              className="mt-1 h-4 w-4 accent-[#D99B26] rounded cursor-pointer shrink-0"
            />
            <div>
              <div className="text-sm font-medium text-slate-100">
                [[BOLUM]] etiketindeki başlığı seslendir
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {(studioSettings.speakBolumTag ?? true)
                  ? 'Aktif: [[BOLUM: ...]] başlığı hem ekran alt bandı olur hem seslendirilir ([[AYET]] ve [[ETIKET]] asla okunmaz).'
                  : 'Kapalı: [[BOLUM: ...]] yalnızca görsel alt bant olarak tutulur, seslendirilmez.'}
              </p>
            </div>
          </label>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {!batch.running ? (
            <button
              type="button"
              disabled={chunks.length === 0 || Boolean(busyChunkId)}
              onClick={handleGenerateMissingBatch}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] disabled:opacity-40 rounded-xl transition-colors whitespace-nowrap cursor-pointer"
            >
              <Volume2 className="w-4 h-4" />
              <span>Eksik Parçaları Üret ({chunks.length - readyCount})</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  pausedRef.current = !pausedRef.current;
                  setBatch((prev) => ({ ...prev, paused: pausedRef.current }));
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium text-slate-100 bg-slate-800 hover:bg-slate-700 rounded-xl cursor-pointer"
              >
                {batch.paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                <span>{batch.paused ? 'Devam Et' : 'Duraklat'}</span>
              </button>
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium text-red-200 bg-red-500/20 hover:bg-red-500/30 rounded-xl cursor-pointer"
              >
                <Square className="w-3.5 h-3.5" />
                <span>Durdur</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Live Batch Progress Bar */}
      {batch.running && (
        <div className="bg-[#161E2E] border border-[#D99B26]/40 rounded-2xl p-4 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
            <span className="text-slate-100 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[#D99B26]" />
              {batch.paused ? 'Duraklatıldı' : batch.currentLabel}
            </span>
            <div className="flex items-center gap-3 text-slate-400 tabular-nums">
              {batch.activeKeyIndex && batch.totalKeys && batch.totalKeys > 1 && (
                <span>
                  Anahtar #{batch.activeKeyIndex}/{batch.totalKeys}
                </span>
              )}
              {batch.waitCountdownSec && batch.waitCountdownSec > 0 ? (
                <span className="text-amber-400">Kota bekleme: {batch.waitCountdownSec}s</span>
              ) : null}
              {etaSec !== null && <span>Tahmini Kalan: {formatDurationClock(etaSec)}</span>}
              <span className="text-slate-200">
                {batch.completed + batch.failed}/{batch.total}
              </span>
            </div>
          </div>
          <div className="w-full h-2 bg-[#0B0F17] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#D99B26] transition-all duration-300"
              style={{
                width: `${Math.min(100, Math.round(((batch.completed + batch.failed) / Math.max(1, batch.total)) * 100))}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Empty State */}
      {chunks.length === 0 ? (
        <div className="bg-[#131924] border border-slate-800 rounded-2xl p-10 text-center space-y-3">
          <p className="text-sm text-slate-300">
            Henüz işlenecek senaryo bulunamadı. Adım 1&apos;den Demo metni yükleyebilir veya Adım
            2&apos;ye senaryonuzu yapıştırabilirsiniz.
          </p>
        </div>
      ) : (
        /* Chunk Cards List */
        <div className="space-y-4">
          {chunks.map((chunk) => {
            const isExpanded = expandedIds[chunk.id] ?? true;
            const isUpToDate =
              Boolean(chunk.audioBlobId) && chunk.generatedHash === chunk.cacheHash;
            const isGenerating = chunk.status === 'generating' || busyChunkId === chunk.id;
            const audioUrl = audioUrls[chunk.id];

            return (
              <article
                key={chunk.id}
                className="bg-[#131924] border border-slate-800/80 rounded-2xl overflow-hidden"
              >
                {/* Card Top Meta Row */}
                <div className="px-5 py-4 flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-800/60">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums">
                      <span className="font-semibold text-slate-100">
                        Parça #{String(chunk.index).padStart(2, '0')}
                      </span>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <span className={chunk.isChapterStart ? 'text-[#F3C669]' : 'text-slate-400'}>
                        {chunk.isChapterStart ? `Bölüm Başı: ${chunk.chapterTitle}` : chunk.chapterTitle}
                      </span>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <span className="text-slate-400">
                        {chunk.cleanedText.length.toLocaleString('tr-TR')} karakter
                      </span>
                      {chunk.durationSec ? (
                        <>
                          <span aria-hidden="true" className="text-slate-600">·</span>
                          <span className="text-slate-300">
                            {formatDurationClock(chunk.durationSec)}
                          </span>
                        </>
                      ) : null}
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      {isUpToDate ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {chunk.status === 'cached' ? 'Önbellekten Hazır' : 'Ses Hazır'}
                        </span>
                      ) : chunk.status === 'error' ? (
                        <span className="inline-flex items-center gap-1 text-red-400">
                          <AlertCircle className="w-3.5 h-3.5" /> Hata
                        </span>
                      ) : (
                        <span className="text-slate-500">Ses Bekliyor</span>
                      )}
                    </div>

                    {/* Extracted Director Overlays (never spoken) */}
                    {chunk.overlays.length > 0 && (
                      <div className="text-xs text-slate-400 truncate">
                        Ekran Katmanları (okunmaz):{' '}
                        {chunk.overlays
                          .map((o) => `[${o.kind.toUpperCase()}] ${o.label !== 'Bölüm' && o.label !== 'Referans' ? `${o.label} — ` : ''}${o.text}`)
                          .join(' · ')}
                      </div>
                    )}
                  </div>

                  {/* Per-Chunk Controls */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedIds((prev) => ({ ...prev, [chunk.id]: !isExpanded }))
                      }
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-300 hover:text-white border border-slate-800 rounded-lg hover:bg-slate-800/60 cursor-pointer"
                    >
                      {isExpanded ? (
                        <ChevronUp className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5" />
                      )}
                      <span>Metni Düzenle</span>
                    </button>

                    <button
                      type="button"
                      disabled={isGenerating || batch.running}
                      onClick={async () => {
                        try {
                          await generateSingleChunk(chunk);
                          onNotify(`Parça #${chunk.index} seslendirildi.`);
                        } catch (err) {
                          if ((err as Error).name !== 'AbortError') {
                            onNotify((err as Error).message, 'error');
                          }
                        }
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] disabled:opacity-50 rounded-lg cursor-pointer"
                    >
                      {isGenerating ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5" />
                      )}
                      <span>{chunk.audioBlobId ? 'Yeniden Üret' : 'Sesi Üret'}</span>
                    </button>

                    {chunk.audioBlobId && (
                      <button
                        type="button"
                        disabled={isGenerating || batch.running}
                        onClick={() => void handleDeleteChunkAudio(chunk)}
                        title="Sadece ses dosyasını sil (yeniden üretmek için)"
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-300 hover:text-amber-300 border border-slate-800 rounded-lg hover:bg-slate-800/60 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Sesi Sil</span>
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={isGenerating || batch.running}
                      onClick={() => void handleRemoveChunkCompletely(chunk)}
                      title="Parçayı tamamen kaldır"
                      className="p-1.5 text-slate-500 hover:text-red-400 rounded-lg hover:bg-red-500/10 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Error Message if any */}
                {chunk.errorMessage && (
                  <div className="px-5 py-2.5 bg-red-950/30 border-b border-red-900/40 text-xs text-red-300">
                    {chunk.errorMessage}
                  </div>
                )}

                {/* Inline HTML5 Audio Player */}
                {audioUrl && (
                  <div className="px-5 py-3 bg-[#0E131D] border-b border-slate-800/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <audio controls src={audioUrl} className="w-full h-9" />
                    <span className="text-[11px] font-mono text-slate-500 shrink-0">
                      SHA-256: {chunk.cacheHash.slice(0, 12)}
                    </span>
                  </div>
                )}

                {/* Expandable Cleaned TTS Text Editor */}
                {isExpanded && (
                  <div className="p-5 bg-[#0B0F17]/60 space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span>Temizlenmiş TTS Metni (Telaffuz için doğrudan düzenleyebilirsiniz)</span>
                      <span className="font-mono text-slate-500">
                        İmza: {chunk.cacheHash.slice(0, 10)}
                      </span>
                    </div>
                    <textarea
                      rows={Math.min(10, Math.max(3, Math.ceil(chunk.cleanedText.length / 110)))}
                      value={chunk.cleanedText}
                      onChange={(e) => void handleEditCleanedText(chunk, e.target.value)}
                      className="w-full bg-[#0B0F17] border border-slate-800 rounded-xl p-3.5 text-sm leading-relaxed text-slate-200 focus:outline-none focus:border-[#D99B26]/60"
                    />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};
