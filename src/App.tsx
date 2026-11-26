import React, { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_EDITOR_SETTINGS,
  DEFAULT_ZOOM_SPEED_PER_SEC,
  EditorSettings,
  GeneratedScenePlanItem,
  PersistedSession,
  TimelineScene,
  TimingPlanEntry,
  TranscriptSegment,
  UploadedImage,
  WizardStep,
} from './types/editor';
import {
  parseSrtToSegments,
  parseTimingPlanTxt,
  readAudioDuration,
  sortAndParseImages,
} from './utils/mediaUtils';
import {
  adjustSceneDurationAdjacentOnly,
  buildTimelineFromTimingPlan,
  matchImagesToTimingPlan,
  recalculateAllScenes,
} from './utils/timelineMath';
import {
  alignImagesWithTranscript,
  clearTranscriptionCache,
  fetchServerHealth,
  RetryNotice,
  TranscribeProgress,
  transcribeAudioInChunks,
} from './services/editorApi';
import { AppView, TopBar } from './components/TopBar';
import { SettingsModal } from './components/SettingsModal';
import { Step1Upload } from './components/Step1Upload';
import { Step2Timeline } from './components/Step2Timeline';
import { Step3Export } from './components/Step3Export';
import { StandaloneTranscriber } from './components/StandaloneTranscriber';

const STORAGE_KEY = 'belgesel_kurgu_asistani_v1';

function loadPersistedSession(): Partial<PersistedSession> | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<PersistedSession>;
  } catch {
    return null;
  }
}

export default function App() {
  const initial = useRef<Partial<PersistedSession> | null>(null);
  if (initial.current === null) {
    initial.current = loadPersistedSession() ?? {};
  }

  const saved = initial.current;
  const hasSavedTimeline = Boolean(saved?.scenes && saved.scenes.length > 0);

  const [activeView, setActiveView] = useState<AppView>('editor');
  const [activeStep, setActiveStep] = useState<WizardStep>(
    hasSavedTimeline ? 2 : 1
  );
  const [settings, setSettings] = useState<EditorSettings>({
    deepgramApiKey: saved?.settings?.deepgramApiKey || DEFAULT_EDITOR_SETTINGS.deepgramApiKey,
    deepgramModel:
      saved?.settings?.deepgramModel === 'nova-2'
        ? 'nova-2'
        : DEFAULT_EDITOR_SETTINGS.deepgramModel,
    alignmentModel: saved?.settings?.alignmentModel || DEFAULT_EDITOR_SETTINGS.alignmentModel,
    customApiKey: saved?.settings?.customApiKey || DEFAULT_EDITOR_SETTINGS.customApiKey,
  });
  const [hasServerGeminiKey, setHasServerGeminiKey] = useState(true);
  const [hasDeepgramKey, setHasDeepgramKey] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  // Audio state (original file is NEVER modified or re-encoded)
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioObjectUrl, setAudioObjectUrl] = useState<string | null>(null);
  const [audioFileName, setAudioFileName] = useState<string>(
    hasSavedTimeline ? saved?.audioFileName || '' : ''
  );
  const [totalAudioDuration, setTotalAudioDuration] = useState<number>(
    hasSavedTimeline ? Number(saved?.totalAudioDuration) || 0 : 0
  );

  // Sequentially sorted local images
  const [images, setImages] = useState<UploadedImage[]>([]);

  // Optional user-uploaded SRT
  const [srtFileName, setSrtFileName] = useState<string>('');
  const [srtSegments, setSrtSegments] = useState<TranscriptSegment[]>([]);

  // Optional user-uploaded .txt scene timing plan
  const [timingPlanFileName, setTimingPlanFileName] = useState<string>('');
  const [timingPlanEntries, setTimingPlanEntries] = useState<TimingPlanEntry[]>([]);

  // Core timeline, subtitle & transcript state
  const [zoomSpeedPerSec, setZoomSpeedPerSec] = useState<number>(
    typeof saved?.zoomSpeedPerSec === 'number' && saved.zoomSpeedPerSec >= 0.001
      ? saved.zoomSpeedPerSec
      : DEFAULT_ZOOM_SPEED_PER_SEC
  );
  const [burnSubtitles, setBurnSubtitles] = useState<boolean>(
    Boolean(saved?.burnSubtitles)
  );
  const [alignmentModelUsed, setAlignmentModelUsed] = useState<string>(
    saved?.alignmentModelUsed || ''
  );
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>(
    Array.isArray(saved?.transcriptSegments) ? saved.transcriptSegments : []
  );
  const [scenes, setScenes] = useState<TimelineScene[]>(() => {
    const rawScenes = Array.isArray(saved?.scenes) ? saved.scenes : [];
    const speed =
      typeof saved?.zoomSpeedPerSec === 'number' && saved.zoomSpeedPerSec >= 0.001
        ? saved.zoomSpeedPerSec
        : DEFAULT_ZOOM_SPEED_PER_SEC;
    return rawScenes.length > 0 ? recalculateAllScenes(rawScenes, speed) : [];
  });

  // Processing state (Step 1)
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<TranscribeProgress | null>(null);
  const [retryNotice, setRetryNotice] = useState<RetryNotice | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Re-alignment state (Step 2)
  const [isRealigning, setIsRealigning] = useState(false);
  const [realignRetryNotice, setRealignRetryNotice] = useState<RetryNotice | null>(null);
  const [realignError, setRealignError] = useState<string | null>(null);

  // Check server health once on mount
  useEffect(() => {
    fetchServerHealth().then((h) => {
      setHasServerGeminiKey(h.hasServerGeminiKey);
      setHasDeepgramKey(h.hasDeepgramKey);
    });
  }, []);

  // Auto-save timeline, transcript, zoom speed, subtitles & settings to localStorage
  useEffect(() => {
    try {
      const payload: PersistedSession = {
        audioFileName,
        totalAudioDuration,
        zoomSpeedPerSec,
        burnSubtitles,
        alignmentModelUsed,
        transcriptSegments,
        scenes,
        settings,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage quota errors
    }
  }, [
    audioFileName,
    totalAudioDuration,
    zoomSpeedPerSec,
    burnSubtitles,
    alignmentModelUsed,
    transcriptSegments,
    scenes,
    settings,
  ]);

  // Cleanup object URLs on unmount
  const audioUrlRef = useRef<string | null>(null);
  audioUrlRef.current = audioObjectUrl;
  const imagesRef = useRef<UploadedImage[]>([]);
  imagesRef.current = images;

  useEffect(() => {
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      for (const img of imagesRef.current) {
        if (img.objectUrl) URL.revokeObjectURL(img.objectUrl);
      }
    };
  }, []);

  const handleSelectAudio = async (file: File) => {
    setErrorMessage(null);
    try {
      const { durationSec, objectUrl } = await readAudioDuration(file);
      if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
      setAudioFile(file);
      setAudioObjectUrl(objectUrl);
      setAudioFileName(file.name);
      setTotalAudioDuration(durationSec);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Ses dosyası okunamadı.');
    }
  };

  const handleClearAudio = () => {
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    setAudioFile(null);
    setAudioObjectUrl(null);
    setAudioFileName('');
    const srtEnd = srtSegments.reduce((max, s) => Math.max(max, s.endSec), 0);
    const planEnd = timingPlanEntries.reduce((max, e) => Math.max(max, e.endSec), 0);
    const fallbackEnd = Math.max(srtEnd, planEnd);
    setTotalAudioDuration(fallbackEnd > 0 ? Number(fallbackEnd.toFixed(2)) : 0);
  };

  const handleAddImages = (newFiles: File[]) => {
    setErrorMessage(null);
    const existingFiles = images.map((i) => i.file).filter((f): f is File => Boolean(f));
    const byName = new Map<string, File>();
    for (const f of existingFiles) byName.set(f.name, f);
    for (const f of newFiles) byName.set(f.name, f);

    for (const img of images) {
      if (img.objectUrl) URL.revokeObjectURL(img.objectUrl);
    }
    const sorted = sortAndParseImages(Array.from(byName.values()));
    setImages(sorted);
  };

  const handleRemoveImage = (id: string) => {
    setImages((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target?.objectUrl) URL.revokeObjectURL(target.objectUrl);
      return prev.filter((i) => i.id !== id);
    });
  };

  const handleClearImages = () => {
    for (const img of images) {
      if (img.objectUrl) URL.revokeObjectURL(img.objectUrl);
    }
    setImages([]);
  };

  const handleUploadSrt = async (file: File) => {
    setErrorMessage(null);
    try {
      const text = await file.text();
      const parsed = parseSrtToSegments(text);
      if (parsed.length === 0) {
        setErrorMessage('SRT dosyasında geçerli zaman damgalı satır bulunamadı.');
        return;
      }
      setSrtFileName(file.name);
      setSrtSegments(parsed);
      // If no audio file is uploaded, automatically derive total duration from the last SRT timestamp
      if (!audioFile) {
        const lastEnd = parsed.reduce((max, s) => Math.max(max, s.endSec), 0);
        if (lastEnd > 0) {
          setTotalAudioDuration(Number(lastEnd.toFixed(2)));
        }
      }
    } catch {
      setErrorMessage('SRT dosyası okunamadı.');
    }
  };

  const handleClearSrt = () => {
    setSrtFileName('');
    setSrtSegments([]);
    if (!audioFile && scenes.length === 0) {
      const planEnd = timingPlanEntries.reduce((max, e) => Math.max(max, e.endSec), 0);
      setTotalAudioDuration(planEnd > 0 ? Number(planEnd.toFixed(2)) : 0);
    }
  };

  const handleUploadTimingPlan = async (file: File) => {
    setErrorMessage(null);
    try {
      const text = await file.text();
      const parsed = parseTimingPlanTxt(text);
      if (parsed.length === 0) {
        setErrorMessage(
          'TXT dosyasında geçerli sahne süresi bulunamadı. Örnek format: "1. Başlık" ve alt satırda "Zaman: 00:00:00 - 00:00:17 (17 saniye)".'
        );
        return;
      }
      setTimingPlanFileName(file.name);
      setTimingPlanEntries(parsed);
      if (!audioFile && srtSegments.length === 0) {
        const lastEnd = parsed.reduce((max, e) => Math.max(max, e.endSec), 0);
        if (lastEnd > 0) {
          setTotalAudioDuration(Number(lastEnd.toFixed(2)));
        }
      }
    } catch {
      setErrorMessage('TXT süre planı dosyası okunamadı.');
    }
  };

  const handleClearTimingPlan = () => {
    setTimingPlanFileName('');
    setTimingPlanEntries([]);
    if (!audioFile && srtSegments.length === 0 && scenes.length === 0) {
      setTotalAudioDuration(0);
    }
  };

  const handleStartProcess = async () => {
    if (!audioFile && srtSegments.length === 0 && timingPlanEntries.length === 0) {
      setErrorMessage(
        audioFileName
          ? `Sayfa yenilendiği için tarayıcı "${audioFileName}" dosyasını bellekte tutamadı. Lütfen sol kutudan ses dosyasını, bir .SRT veya .TXT süre planı seçin.`
          : 'Lütfen sol kutudan bir ses dosyası (.mp3, .wav, .m4a), hazır .SRT transkripti veya .TXT süre planı yükleyin.'
      );
      return;
    }

    const srtMaxEnd = srtSegments.reduce((max, s) => Math.max(max, s.endSec), 0);
    const planMaxEnd = timingPlanEntries.reduce((max, e) => Math.max(max, e.endSec), 0);
    const effectiveDuration =
      totalAudioDuration > 0
        ? totalAudioDuration
        : Math.max(srtMaxEnd, planMaxEnd);

    if (effectiveDuration <= 0) {
      setErrorMessage('Toplam süre okunamadı. Geçerli bir ses, .SRT veya .TXT dosyası seçin.');
      return;
    }
    if (images.length === 0) {
      setErrorMessage('Lütfen sağ kutudan en az 1 sıralı görsel yükleyin.');
      return;
    }

    if (effectiveDuration !== totalAudioDuration) {
      setTotalAudioDuration(Number(effectiveDuration.toFixed(2)));
    }

    // Direct exact timing path: if the uploaded .txt plan specifies timings for every uploaded image,
    // construct the exact zero-gap constant-zoom timeline immediately with 100% fidelity to the .txt durations.
    if (timingPlanEntries.length > 0) {
      const matched = matchImagesToTimingPlan(images, timingPlanEntries);
      const matchedCount = matched.filter(Boolean).length;

      if (matchedCount === images.length) {
        setErrorMessage(null);
        const plannedScenes = buildTimelineFromTimingPlan(
          images,
          timingPlanEntries,
          effectiveDuration,
          zoomSpeedPerSec,
          srtSegments
        );
        setTranscriptSegments(srtSegments);
        setScenes(plannedScenes);
        setAlignmentModelUsed('Süre Planı (.txt)');
        setActiveStep(2);
        return;
      }
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsProcessing(true);
    setErrorMessage(null);
    setRetryNotice(null);

    try {
      let finalTranscript: TranscriptSegment[] = [];

      if (srtSegments.length > 0) {
        finalTranscript = srtSegments;
      } else if (audioFile) {
        finalTranscript = await transcribeAudioInChunks(audioFile, settings, {
          signal: controller.signal,
          onProgress: (p) => setProgress(p),
          onRetryWait: (notice) => setRetryNotice(notice),
        });
      }

      if (controller.signal.aborted) return;

      const preferredAlignModel = settings.alignmentModel || 'gemini-4-hydrogen';
      setProgress({
        phase: 'aligning',
        currentChunk: 1,
        totalChunks: 1,
        message:
          timingPlanEntries.length > 0
            ? `${images.length} görsel .TXT süre planı + ${preferredAlignModel} ile yerleştiriliyor...`
            : `${images.length} sıralı görsel ${preferredAlignModel} ile transkripte eşleştiriliyor...`,
      });

      const { scenes: alignedScenes, modelUsed } = await alignImagesWithTranscript(
        finalTranscript,
        images,
        effectiveDuration,
        zoomSpeedPerSec,
        settings,
        {
          signal: controller.signal,
          onRetryWait: (notice) => setRetryNotice(notice),
          timingPlan: timingPlanEntries,
        }
      );

      if (controller.signal.aborted) return;

      setTranscriptSegments(finalTranscript);
      setScenes(alignedScenes);
      setAlignmentModelUsed(
        timingPlanEntries.length > 0 ? `${modelUsed} + .txt` : modelUsed
      );
      setActiveStep(2);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        setErrorMessage('İşlem iptal edildi.');
      } else {
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'Transkript veya görsel eşleştirme sırasında bir hata oluştu.'
        );
      }
    } finally {
      setIsProcessing(false);
      setProgress(null);
      setRetryNotice(null);
      abortControllerRef.current = null;
    }
  };

  const handleRealignWithHydrogen = async () => {
    if ((transcriptSegments.length === 0 && timingPlanEntries.length === 0) || scenes.length === 0 || isRealigning) {
      return;
    }

    setIsRealigning(true);
    setRealignError(null);
    setRealignRetryNotice(null);

    try {
      const imageListForAlignment = scenes.map((sc) => ({
        id: sc.id,
        orderNumber: sc.orderNumber,
        filename: sc.filename,
        cleanTitle: sc.cleanTitle,
        objectUrl: images.find((im) => im.filename === sc.filename)?.objectUrl || '',
      }));

      const hydrogenSettings: EditorSettings = {
        ...settings,
        alignmentModel: settings.alignmentModel || 'gemini-4-hydrogen',
      };

      const { scenes: alignedScenes, modelUsed } = await alignImagesWithTranscript(
        transcriptSegments,
        imageListForAlignment,
        totalAudioDuration,
        zoomSpeedPerSec,
        hydrogenSettings,
        {
          onRetryWait: (notice) => setRealignRetryNotice(notice),
          timingPlan: timingPlanEntries,
        }
      );

      setScenes(alignedScenes);
      setAlignmentModelUsed(
        timingPlanEntries.length > 0 ? `${modelUsed} + .txt` : modelUsed
      );
    } catch (err) {
      setRealignError(
        err instanceof Error ? err.message : 'Yeniden eşleştirme sırasında hata oluştu.'
      );
    } finally {
      setIsRealigning(false);
      setRealignRetryNotice(null);
    }
  };

  const handleCancelProcess = () => {
    abortControllerRef.current?.abort();
  };

  const handleChangeZoomSpeed = (nextSpeed: number) => {
    const clamped = Math.max(0.001, Math.min(0.01, Number(nextSpeed)));
    setZoomSpeedPerSec(clamped);
    setScenes((prev) => recalculateAllScenes(prev, clamped));
  };

  const handleAdjustSceneDuration = (sceneIndex: number, newDurationSec: number) => {
    setScenes((prev) =>
      adjustSceneDurationAdjacentOnly(
        prev,
        sceneIndex,
        newDurationSec,
        zoomSpeedPerSec,
        transcriptSegments
      )
    );
  };

  const handleToggleZoomDirection = (sceneIndex: number) => {
    setScenes((prev) => {
      const toggled = prev.map((sc, idx) =>
        idx === sceneIndex
          ? {
              ...sc,
              zoomDirection:
                sc.zoomDirection === 'uzaklas'
                  ? ('yakinlas' as const)
                  : ('uzaklas' as const),
            }
          : sc
      );
      return recalculateAllScenes(toggled, zoomSpeedPerSec);
    });
  };

  const handleReattachAudio = async (file: File) => {
    try {
      const { objectUrl } = await readAudioDuration(file);
      if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
      setAudioFile(file);
      setAudioObjectUrl(objectUrl);
    } catch {
      // ignore invalid file
    }
  };

  const handlePerformReset = () => {
    abortControllerRef.current?.abort();
    clearTranscriptionCache();
    handleClearAudio();
    handleClearImages();
    handleClearSrt();
    handleClearTimingPlan();
    setTotalAudioDuration(0);
    setTranscriptSegments([]);
    setScenes([]);
    setAlignmentModelUsed('');
    setBurnSubtitles(false);
    setZoomSpeedPerSec(DEFAULT_ZOOM_SPEED_PER_SEC);
    setErrorMessage(null);
    setRealignError(null);
    setActiveStep(1);
    setResetConfirmOpen(false);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  const canAccessStep2 = scenes.length > 0;
  const canAccessStep3 = scenes.length > 0;
  const hasAnyData = Boolean(
    audioFileName || srtFileName || timingPlanFileName || images.length > 0 || scenes.length > 0
  );

  const handleUseStandaloneTranscriptInEditor = (
    extractedSegments: TranscriptSegment[],
    sourceSrtName: string,
    sourceAudioFile: File | null,
    durationSec: number,
    generatedPlan?: GeneratedScenePlanItem[],
    planFileName?: string
  ) => {
    setSrtFileName(sourceSrtName);
    setSrtSegments(extractedSegments);
    if (generatedPlan && generatedPlan.length > 0) {
      setTimingPlanEntries(generatedPlan);
      setTimingPlanFileName(planFileName || 'sahne_plani_ve_promptlar.txt');
    }
    if (sourceAudioFile) {
      void handleSelectAudio(sourceAudioFile);
    } else if (durationSec > 0) {
      setTotalAudioDuration(Number(durationSec.toFixed(2)));
    }
    setActiveStep(1);
    setActiveView('editor');
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#0B0F17] text-[#F1F5F9]">
      <TopBar
        activeView={activeView}
        activeStep={activeStep}
        canAccessStep2={canAccessStep2}
        canAccessStep3={canAccessStep3}
        hasAnyData={hasAnyData}
        onSelectStep={(step) => {
          setActiveView('editor');
          setActiveStep(step);
        }}
        onSelectTranscribeView={() => setActiveView('transcribe')}
        onOpenSettings={() => setSettingsOpen(true)}
        onResetSession={() => setResetConfirmOpen(true)}
      />

      <main className="flex-1 pb-12">
        <div className={activeView === 'transcribe' ? 'block' : 'hidden'}>
          <StandaloneTranscriber
            settings={settings}
            hasDeepgramKey={hasDeepgramKey}
            onOpenSettings={() => setSettingsOpen(true)}
            onUseTranscriptInEditor={handleUseStandaloneTranscriptInEditor}
          />
        </div>

        {activeView === 'editor' && activeStep === 1 && (
          <Step1Upload
            audioFile={audioFile}
            audioFileName={audioFileName}
            totalAudioDuration={totalAudioDuration}
            images={images}
            srtFileName={srtFileName}
            srtSegments={srtSegments}
            timingPlanFileName={timingPlanFileName}
            timingPlanEntries={timingPlanEntries}
            isProcessing={isProcessing}
            progress={progress}
            retryNotice={retryNotice}
            errorMessage={errorMessage}
            hasExistingTimeline={scenes.length > 0}
            onSelectAudio={handleSelectAudio}
            onClearAudio={handleClearAudio}
            onAddImages={handleAddImages}
            onRemoveImage={handleRemoveImage}
            onClearImages={handleClearImages}
            onUploadSrt={handleUploadSrt}
            onClearSrt={handleClearSrt}
            onUploadTimingPlan={handleUploadTimingPlan}
            onClearTimingPlan={handleClearTimingPlan}
            onStartProcess={handleStartProcess}
            onCancelProcess={handleCancelProcess}
            onGoToExistingTimeline={() => setActiveStep(2)}
          />
        )}

        {activeView === 'editor' && activeStep === 2 && (
          <Step2Timeline
            audioFileName={audioFileName}
            audioObjectUrl={audioObjectUrl}
            totalAudioDuration={totalAudioDuration}
            zoomSpeedPerSec={zoomSpeedPerSec}
            burnSubtitles={burnSubtitles}
            alignmentModelUsed={alignmentModelUsed}
            isRealigning={isRealigning}
            realignRetryNotice={realignRetryNotice}
            realignError={realignError}
            transcriptSegments={transcriptSegments}
            scenes={scenes}
            images={images}
            onChangeZoomSpeed={handleChangeZoomSpeed}
            onToggleSubtitles={setBurnSubtitles}
            onRealignWithHydrogen={handleRealignWithHydrogen}
            onAdjustSceneDuration={handleAdjustSceneDuration}
            onToggleZoomDirection={handleToggleZoomDirection}
            onReattachAudio={handleReattachAudio}
            onReattachImages={handleAddImages}
            onProceedToExport={() => setActiveStep(3)}
          />
        )}

        {activeView === 'editor' && activeStep === 3 && (
          <Step3Export
            audioFileName={audioFileName}
            totalAudioDuration={totalAudioDuration}
            zoomSpeedPerSec={zoomSpeedPerSec}
            burnSubtitles={burnSubtitles}
            transcriptSegments={transcriptSegments}
            scenes={scenes}
            onChangeAudioFileName={setAudioFileName}
            onToggleSubtitles={setBurnSubtitles}
            onBackToTimeline={() => setActiveStep(2)}
          />
        )}
      </main>

      {/* Minimal Settings Modal */}
      <SettingsModal
        open={settingsOpen}
        settings={settings}
        hasServerGeminiKey={hasServerGeminiKey}
        hasDeepgramKey={hasDeepgramKey}
        onSave={(next) => setSettings(next)}
        onClose={() => setSettingsOpen(false)}
      />

      {/* Clean In-App Reset Confirmation Dialog (no window.confirm) */}
      {resetConfirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={() => setResetConfirmOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-white/[0.1] bg-[#131924] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-display text-lg font-medium text-[#F1F5F9]">
              Yeni Kurgu Başlat
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-[#94A3B8]">
              Mevcut zaman çizelgesi, transkript ve yüklü medya listesi temizlenecek. Ayarlarınız korunur.
              Devam etmek istiyor musunuz?
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setResetConfirmOpen(false)}
                className="rounded-md border border-white/[0.08] px-3.5 py-2 text-xs font-medium text-[#94A3B8] hover:bg-white/[0.04] hover:text-[#F1F5F9]"
              >
                Vazgeç
              </button>
              <button
                type="button"
                onClick={handlePerformReset}
                className="rounded-md bg-rose-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-rose-500"
              >
                Temizle ve Sıfırla
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
