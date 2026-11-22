import React, { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_EDITOR_SETTINGS,
  DEFAULT_ZOOM_SPEED_PER_SEC,
  EditorSettings,
  PersistedSession,
  TimelineScene,
  TranscriptSegment,
  UploadedImage,
  WizardStep,
} from './types/editor';
import {
  parseSrtToSegments,
  readAudioDuration,
  sortAndParseImages,
} from './utils/mediaUtils';
import {
  adjustSceneDurationAdjacentOnly,
  recalculateAllScenes,
} from './utils/timelineMath';
import {
  alignImagesWithTranscript,
  fetchServerHealth,
  TranscribeProgress,
  transcribeAudioInChunks,
} from './services/editorApi';
import { TopBar } from './components/TopBar';
import { SettingsModal } from './components/SettingsModal';
import { Step1Upload } from './components/Step1Upload';
import { Step2Timeline } from './components/Step2Timeline';
import { Step3Export } from './components/Step3Export';

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

  const [activeStep, setActiveStep] = useState<WizardStep>(
    saved?.scenes && saved.scenes.length > 0 ? 2 : 1
  );
  const [settings, setSettings] = useState<EditorSettings>({
    ...DEFAULT_EDITOR_SETTINGS,
    ...(saved?.settings ?? {}),
  });
  const [hasServerGeminiKey, setHasServerGeminiKey] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  // Audio state (original file is NEVER modified or re-encoded)
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioObjectUrl, setAudioObjectUrl] = useState<string | null>(null);
  const [audioFileName, setAudioFileName] = useState<string>(saved?.audioFileName || '');
  const [totalAudioDuration, setTotalAudioDuration] = useState<number>(
    Number(saved?.totalAudioDuration) || 0
  );

  // Sequentially sorted local images
  const [images, setImages] = useState<UploadedImage[]>([]);

  // Optional user-uploaded SRT
  const [srtFileName, setSrtFileName] = useState<string>('');
  const [srtSegments, setSrtSegments] = useState<TranscriptSegment[]>([]);

  // Core timeline & transcript state
  const [zoomSpeedPerSec, setZoomSpeedPerSec] = useState<number>(
    typeof saved?.zoomSpeedPerSec === 'number' && saved.zoomSpeedPerSec >= 0.001
      ? saved.zoomSpeedPerSec
      : DEFAULT_ZOOM_SPEED_PER_SEC
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

  // Processing state
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<TranscribeProgress | null>(null);
  const [retryWaitSec, setRetryWaitSec] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Check server health once on mount
  useEffect(() => {
    fetchServerHealth().then((h) => setHasServerGeminiKey(h.hasServerGeminiKey));
  }, []);

  // Auto-save timeline, transcript, zoom speed & settings to localStorage
  useEffect(() => {
    try {
      const payload: PersistedSession = {
        audioFileName,
        totalAudioDuration,
        zoomSpeedPerSec,
        transcriptSegments,
        scenes,
        settings,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage quota errors
    }
  }, [audioFileName, totalAudioDuration, zoomSpeedPerSec, transcriptSegments, scenes, settings]);

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
    setTotalAudioDuration(0);
  };

  const handleAddImages = (newFiles: File[]) => {
    setErrorMessage(null);
    const existingFiles = images.map((i) => i.file).filter((f): f is File => Boolean(f));
    const byName = new Map<string, File>();
    for (const f of existingFiles) byName.set(f.name, f);
    for (const f of newFiles) byName.set(f.name, f);

    // Revoke previous object URLs cleanly before rebuilding naturally sorted array
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
    } catch {
      setErrorMessage('SRT dosyası okunamadı.');
    }
  };

  const handleClearSrt = () => {
    setSrtFileName('');
    setSrtSegments([]);
  };

  const handleStartProcess = async () => {
    if (images.length === 0) {
      setErrorMessage('Lütfen en az bir görsel yükleyin.');
      return;
    }
    if (!audioFile && srtSegments.length === 0) {
      setErrorMessage('Lütfen ses dosyasını yükleyin.');
      return;
    }
    if (totalAudioDuration <= 0) {
      setErrorMessage('Ses dosyasının toplam süresi okunamadı. Lütfen ses dosyasını seçin.');
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsProcessing(true);
    setErrorMessage(null);
    setRetryWaitSec(null);

    try {
      let finalTranscript: TranscriptSegment[] = [];

      if (srtSegments.length > 0) {
        finalTranscript = srtSegments;
      } else if (audioFile) {
        finalTranscript = await transcribeAudioInChunks(audioFile, settings, {
          signal: controller.signal,
          onProgress: (p) => setProgress(p),
          onRetryWait: (sec) => setRetryWaitSec(sec),
        });
      }

      if (controller.signal.aborted) return;

      setProgress({
        phase: 'aligning',
        currentChunk: 1,
        totalChunks: 1,
        message: `${images.length} sıralı görsel transkript ile eşleştiriliyor...`,
      });

      const alignedScenes = await alignImagesWithTranscript(
        finalTranscript,
        images,
        totalAudioDuration,
        zoomSpeedPerSec,
        settings,
        {
          signal: controller.signal,
          onRetryWait: (sec) => setRetryWaitSec(sec),
        }
      );

      if (controller.signal.aborted) return;

      setTranscriptSegments(finalTranscript);
      setScenes(alignedScenes);
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
      setRetryWaitSec(null);
      abortControllerRef.current = null;
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
    handleClearAudio();
    handleClearImages();
    handleClearSrt();
    setTranscriptSegments([]);
    setScenes([]);
    setZoomSpeedPerSec(DEFAULT_ZOOM_SPEED_PER_SEC);
    setErrorMessage(null);
    setActiveStep(1);
    setResetConfirmOpen(false);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  const canAccessStep2 = scenes.length > 0;
  const canAccessStep3 = scenes.length > 0 && Boolean(audioFileName);
  const hasAnyData = Boolean(audioFileName || images.length > 0 || scenes.length > 0);

  return (
    <div className="flex min-h-screen flex-col bg-[#0B0F17] text-[#F1F5F9]">
      <TopBar
        activeStep={activeStep}
        canAccessStep2={canAccessStep2}
        canAccessStep3={canAccessStep3}
        hasAnyData={hasAnyData}
        onSelectStep={setActiveStep}
        onOpenSettings={() => setSettingsOpen(true)}
        onResetSession={() => setResetConfirmOpen(true)}
      />

      <main className="flex-1 pb-12">
        {activeStep === 1 && (
          <Step1Upload
            audioFile={audioFile}
            audioFileName={audioFileName}
            totalAudioDuration={totalAudioDuration}
            images={images}
            srtFileName={srtFileName}
            srtSegments={srtSegments}
            isProcessing={isProcessing}
            progress={progress}
            retryWaitSec={retryWaitSec}
            errorMessage={errorMessage}
            hasExistingTimeline={scenes.length > 0}
            onSelectAudio={handleSelectAudio}
            onClearAudio={handleClearAudio}
            onAddImages={handleAddImages}
            onRemoveImage={handleRemoveImage}
            onClearImages={handleClearImages}
            onUploadSrt={handleUploadSrt}
            onClearSrt={handleClearSrt}
            onStartProcess={handleStartProcess}
            onCancelProcess={handleCancelProcess}
            onGoToExistingTimeline={() => setActiveStep(2)}
          />
        )}

        {activeStep === 2 && (
          <Step2Timeline
            audioFileName={audioFileName}
            audioObjectUrl={audioObjectUrl}
            totalAudioDuration={totalAudioDuration}
            zoomSpeedPerSec={zoomSpeedPerSec}
            transcriptSegments={transcriptSegments}
            scenes={scenes}
            images={images}
            onChangeZoomSpeed={handleChangeZoomSpeed}
            onAdjustSceneDuration={handleAdjustSceneDuration}
            onToggleZoomDirection={handleToggleZoomDirection}
            onReattachAudio={handleReattachAudio}
            onReattachImages={handleAddImages}
            onProceedToExport={() => setActiveStep(3)}
          />
        )}

        {activeStep === 3 && (
          <Step3Export
            audioFileName={audioFileName}
            totalAudioDuration={totalAudioDuration}
            zoomSpeedPerSec={zoomSpeedPerSec}
            scenes={scenes}
            onBackToTimeline={() => setActiveStep(2)}
          />
        )}
      </main>

      {/* Minimal Settings Modal */}
      <SettingsModal
        open={settingsOpen}
        settings={settings}
        hasServerGeminiKey={hasServerGeminiKey}
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
