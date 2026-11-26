import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FileAudio,
  Upload,
  FileText,
  Download,
  Copy,
  Check,
  Loader2,
  AlertCircle,
  Search,
  Play,
  ArrowRight,
  Settings,
  X,
  ListOrdered,
  Clapperboard,
} from 'lucide-react';
import {
  EditorSettings,
  GeneratedScenePlanItem,
  TranscriptSegment,
} from '../types/editor';
import {
  formatHHMMSS,
  parseSrtToSegments,
  readAudioDuration,
  scenePlanToPromptsOnlyTxt,
  scenePlanToUnifiedTxt,
  segmentsToSrt,
} from '../utils/mediaUtils';
import { formatMMSS } from '../utils/timelineMath';
import { downloadTextFile } from '../utils/exportBundle';
import {
  generateScenePlanWithHydrogen,
  RetryNotice,
  ScenePlanProgress,
  TranscribeProgress,
  transcribeAudioInChunks,
} from '../services/editorApi';

interface StandaloneTranscriberProps {
  settings: EditorSettings;
  hasDeepgramKey: boolean;
  onOpenSettings: () => void;
  onUseTranscriptInEditor: (
    segments: TranscriptSegment[],
    sourceName: string,
    audioFile: File | null,
    durationSec: number,
    generatedPlan?: GeneratedScenePlanItem[],
    planFileName?: string
  ) => void;
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').trim() || 'belgesel';
}

export const StandaloneTranscriber: React.FC<StandaloneTranscriberProps> = ({
  settings,
  hasDeepgramKey,
  onOpenSettings,
  onUseTranscriptInEditor,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);
  const audioElRef = useRef<HTMLAudioElement>(null);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const planAbortRef = useRef<AbortController | null>(null);

  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioObjectUrl, setAudioObjectUrl] = useState<string | null>(null);
  const [audioDuration, setAudioDuration] = useState<number>(0);
  const [sourceLabel, setSourceLabel] = useState<string>('');
  const [dragOver, setDragOver] = useState(false);

  // Deepgram transcription state
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [progress, setProgress] = useState<TranscribeProgress | null>(null);
  const [retryNotice, setRetryNotice] = useState<RetryNotice | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Transcript viewer state
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [activeRightTab, setActiveRightTab] = useState<'transcript' | 'plan'>('transcript');
  const [viewMode, setViewMode] = useState<'timed' | 'plain'>('timed');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedType, setCopiedType] = useState<string | null>(null);
  const [currentPlaySec, setCurrentPlaySec] = useState<number>(-1);

  // Hydrogen Scene Plan + 16:9 2K Image Prompts state
  const [styleDirection, setStyleDirection] = useState('');
  const [targetScenesChoice, setTargetScenesChoice] = useState<number>(0); // 0 = auto
  const [maxSceneSec, setMaxSceneSec] = useState<number>(60); // hard ceiling per image (default 60s)
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false);
  const [planProgress, setPlanProgress] = useState<ScenePlanProgress | null>(null);
  const [planRetryNotice, setPlanRetryNotice] = useState<RetryNotice | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [scenePlan, setScenePlan] = useState<GeneratedScenePlanItem[]>([]);
  const [planModelUsed, setPlanModelUsed] = useState<string>('');
  const [planViewMode, setPlanViewMode] = useState<'cards' | 'txt'>('cards');
  const [planSearchQuery, setPlanSearchQuery] = useState('');

  const audioUrlRef = useRef<string | null>(null);
  audioUrlRef.current = audioObjectUrl;

  useEffect(() => {
    return () => {
      transcribeAbortRef.current?.abort();
      planAbortRef.current?.abort();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  const handleLoadSrtFile = async (file: File) => {
    setErrorMessage(null);
    setPlanError(null);
    try {
      const text = await file.text();
      const parsed = parseSrtToSegments(text);
      if (parsed.length === 0) {
        setErrorMessage('SRT dosyasında geçerli zaman damgalı satır bulunamadı.');
        return;
      }
      const lastEnd = parsed.reduce((max, s) => Math.max(max, s.endSec), 0);
      setSegments(parsed);
      setSourceLabel(file.name);
      if (!audioFile && lastEnd > 0) {
        setAudioDuration(Number(lastEnd.toFixed(2)));
      }
      setScenePlan([]);
      setPlanModelUsed('');
      setActiveRightTab('transcript');
    } catch {
      setErrorMessage('SRT dosyası okunamadı.');
    }
  };

  const handleSelectFile = async (file: File) => {
    if (/\.srt$/i.test(file.name)) {
      await handleLoadSrtFile(file);
      return;
    }

    setErrorMessage(null);
    setPlanError(null);
    try {
      const { durationSec, objectUrl } = await readAudioDuration(file);
      if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
      setAudioFile(file);
      setAudioObjectUrl(objectUrl);
      setAudioDuration(durationSec);
      setSourceLabel(file.name);
      setSegments([]);
      setScenePlan([]);
      setPlanModelUsed('');
      setSearchQuery('');
      setPlanSearchQuery('');
      setCurrentPlaySec(-1);
      setActiveRightTab('transcript');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Ses dosyası okunamadı.');
    }
  };

  const handleClearAll = () => {
    transcribeAbortRef.current?.abort();
    planAbortRef.current?.abort();
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    setAudioFile(null);
    setAudioObjectUrl(null);
    setAudioDuration(0);
    setSourceLabel('');
    setSegments([]);
    setScenePlan([]);
    setPlanModelUsed('');
    setSearchQuery('');
    setPlanSearchQuery('');
    setErrorMessage(null);
    setPlanError(null);
    setCurrentPlaySec(-1);
    setActiveRightTab('transcript');
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (isTranscribing || isGeneratingPlan) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void handleSelectFile(file);
  };

  const handleStartTranscribe = async () => {
    if (!audioFile) {
      setErrorMessage('Lütfen önce bir ses dosyası (.mp3, .wav, .m4a) seçin veya hazır .SRT yükleyin.');
      return;
    }

    const controller = new AbortController();
    transcribeAbortRef.current = controller;

    setIsTranscribing(true);
    setErrorMessage(null);
    setRetryNotice(null);

    try {
      const extracted = await transcribeAudioInChunks(audioFile, settings, {
        signal: controller.signal,
        onProgress: (p) => setProgress(p),
        onRetryWait: (notice) => setRetryNotice(notice),
      });

      if (controller.signal.aborted) return;

      if (extracted.length === 0) {
        setErrorMessage('Ses kaydında çözümlenebilir konuşma metni bulunamadı.');
      }
      setSegments(extracted);
      setActiveRightTab('transcript');
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        setErrorMessage('Transkript işlemi iptal edildi.');
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Transkript çıkarılırken beklenmeyen bir hata oluştu.'
        );
      }
    } finally {
      setIsTranscribing(false);
      setProgress(null);
      setRetryNotice(null);
      transcribeAbortRef.current = null;
    }
  };

  const handleGenerateScenePlan = async () => {
    if (segments.length === 0 || isGeneratingPlan) return;

    const controller = new AbortController();
    planAbortRef.current = controller;

    setIsGeneratingPlan(true);
    setPlanError(null);
    setPlanRetryNotice(null);
    setScenePlan([]);
    setActiveRightTab('plan');

    try {
      const effectiveDur =
        audioDuration > 0
          ? audioDuration
          : segments.reduce((m, s) => Math.max(m, s.endSec), 0);

      const { scenes, modelUsed } = await generateScenePlanWithHydrogen(
        segments,
        effectiveDur,
        settings,
        {
          signal: controller.signal,
          styleDirection,
          targetTotalScenes: targetScenesChoice,
          maxSceneDurationSec: maxSceneSec,
          onProgress: (p) => setPlanProgress(p),
          onRetryWait: (notice) => setPlanRetryNotice(notice),
          onPartialScenes: (partial) => setScenePlan(partial),
        }
      );

      if (controller.signal.aborted) return;

      setScenePlan(scenes);
      setPlanModelUsed(modelUsed);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        setPlanError('Sahne planı oluşturma işlemi iptal edildi.');
      } else {
        setPlanError(
          err instanceof Error
            ? err.message
            : 'Hydrogen ile sahne planı oluşturulurken bir hata oluştu.'
        );
      }
    } finally {
      setIsGeneratingPlan(false);
      setPlanProgress(null);
      setPlanRetryNotice(null);
      planAbortRef.current = null;
    }
  };

  const handleSeekTo = (sec: number) => {
    const el = audioElRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, sec);
    void el.play().catch(() => undefined);
  };

  const plainText = useMemo(() => {
    if (segments.length === 0) return '';
    const paragraphs: string[] = [];
    for (let i = 0; i < segments.length; i += 4) {
      paragraphs.push(
        segments
          .slice(i, i + 4)
          .map((s) => s.text)
          .join(' ')
      );
    }
    return paragraphs.join('\n\n');
  }, [segments]);

  const wordCount = useMemo(() => {
    if (segments.length === 0) return 0;
    return segments
      .map((s) => s.text)
      .join(' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
  }, [segments]);

  const filteredSegments = useMemo(() => {
    const q = searchQuery.trim().toLocaleLowerCase('tr-TR');
    if (!q) return segments;
    return segments.filter((s) => s.text.toLocaleLowerCase('tr-TR').includes(q));
  }, [segments, searchQuery]);

  const unifiedPlanTxt = useMemo(() => scenePlanToUnifiedTxt(scenePlan), [scenePlan]);
  const promptsOnlyTxt = useMemo(() => scenePlanToPromptsOnlyTxt(scenePlan), [scenePlan]);

  const planDurationStats = useMemo(() => {
    if (scenePlan.length === 0) return { avgSec: 0, maxSec: 0 };
    let total = 0;
    let longest = 0;
    for (const sc of scenePlan) {
      total += sc.durationSec;
      if (sc.durationSec > longest) longest = sc.durationSec;
    }
    return {
      avgSec: Math.round(total / scenePlan.length),
      maxSec: Math.round(longest),
    };
  }, [scenePlan]);

  const filteredPlan = useMemo(() => {
    const q = planSearchQuery.trim().toLocaleLowerCase('tr-TR');
    if (!q) return scenePlan;
    return scenePlan.filter(
      (item) =>
        item.title.toLocaleLowerCase('tr-TR').includes(q) ||
        item.era.toLocaleLowerCase('tr-TR').includes(q) ||
        item.imagePrompt.toLowerCase().includes(q) ||
        String(item.orderNumber) === q
    );
  }, [scenePlan, planSearchQuery]);

  const copyToClipboard = async (text: string, key: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedType(key);
      window.setTimeout(() => setCopiedType((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      setErrorMessage('Panoya kopyalanamadı; dosya olarak indirebilirsiniz.');
    }
  };

  const baseName = stripExtension(audioFile?.name || sourceLabel || 'belgesel');

  const handleDownloadSrt = () => {
    if (segments.length === 0) return;
    downloadTextFile(`${baseName}.srt`, segmentsToSrt(segments), 'application/x-subrip;charset=utf-8');
  };

  const handleDownloadTranscriptTxt = () => {
    if (!plainText) return;
    downloadTextFile(`${baseName}_transkript.txt`, plainText, 'text/plain;charset=utf-8');
  };

  const handleDownloadUnifiedPlanTxt = () => {
    if (!unifiedPlanTxt) return;
    downloadTextFile(`${baseName}_sahne_plani_ve_promptlar.txt`, unifiedPlanTxt, 'text/plain;charset=utf-8');
  };

  const handleDownloadPromptsOnlyTxt = () => {
    if (!promptsOnlyTxt) return;
    downloadTextFile(`${baseName}_promptlar.txt`, promptsOnlyTxt, 'text/plain;charset=utf-8');
  };

  const transcribePercent =
    progress && progress.phase === 'transcribing' && progress.totalChunks > 0
      ? Math.round(((progress.currentChunk - 0.5) / progress.totalChunks) * 92)
      : progress?.phase === 'decoding'
        ? 10
        : 0;

  const planPercent =
    planProgress && planProgress.totalBlocks > 0
      ? Math.round(((planProgress.currentBlock - 0.4) / planProgress.totalBlocks) * 95)
      : 12;

  const deepgramModel = settings.deepgramModel === 'nova-2' ? 'nova-2' : 'nova-3';
  const hasAnyDeepgramKey = Boolean(settings.deepgramApiKey.trim() || hasDeepgramKey);
  const busy = isTranscribing || isGeneratingPlan;

  return (
    <div className="mx-auto max-w-[1220px] space-y-6 px-4 py-8 sm:px-6">
      {/* Calm Header */}
      <div className="flex flex-col justify-between gap-4 border-b border-white/[0.07] pb-6 sm:flex-row sm:items-end">
        <div className="space-y-1.5">
          <p className="font-mono text-xs tracking-wider text-[#D99B26]">
            Ön Hazırlık Stüdyosu
          </p>
          <h1 className="font-display text-2xl font-medium tracking-tight text-[#F1F5F9] sm:text-3xl">
            Ses → Transkript &amp; Sahne Planı
          </h1>
          <p className="max-w-2xl text-sm text-[#94A3B8]">
            Belgesel sesinden zaman damgalı transkript çıkarın, ardından{' '}
            <span className="text-[#CBD5E1]">Gemini 4 Hydrogen</span> ile dönemsel uyumlu{' '}
            <span className="font-mono text-[#CBD5E1]">16:9 2K</span> görsel promptlarını ve saniye bazlı sahne planını tek{' '}
            <span className="font-mono text-[#CBD5E1]">.TXT</span> dosyasında üretin.
          </p>
        </div>

        <div className="flex items-center gap-3 text-xs text-[#94A3B8]">
          <span>
            Transkript: <span className="font-mono text-[#E2E8F0]">Deepgram {deepgramModel}</span>
          </span>
          <span aria-hidden="true" className="text-white/20">·</span>
          <span>
            Plan: <span className="font-mono text-[#E2E8F0]">gemini-4-hydrogen</span>
          </span>
          <span aria-hidden="true" className="text-white/20">·</span>
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex items-center gap-1 whitespace-nowrap text-[#CBD5E1] underline decoration-white/20 underline-offset-4 transition-colors hover:text-[#D99B26]"
          >
            <Settings className="h-3.5 w-3.5" />
            <span>Ayarlar</span>
          </button>
        </div>
      </div>

      {/* Main 2-Column Workspace */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
        {/* Left: Stage 1 (Audio -> Transcript) + Stage 2 (Transcript -> Hydrogen Scene Plan & Prompts) */}
        <section className="space-y-6 rounded-lg border border-white/[0.08] bg-[#131924] p-6 lg:col-span-5">
          {/* Stage 1 Header */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-[#F1F5F9]">
                <FileAudio className="h-4 w-4 text-[#D99B26]" />
                <span>1. Ses Dosyası veya Hazır .SRT</span>
              </div>
              <span className="font-mono text-[11px] text-[#64748B]">MP3 · WAV · M4A · SRT</span>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,.srt,audio/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleSelectFile(file);
                e.target.value = '';
              }}
            />

            <input
              ref={srtInputRef}
              type="file"
              accept=".srt,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleLoadSrtFile(file);
                e.target.value = '';
              }}
            />

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => !busy && fileInputRef.current?.click()}
              className={`group flex min-h-[144px] cursor-pointer flex-col items-center justify-center rounded-md border border-dashed p-5 text-center transition-colors ${
                dragOver
                  ? 'border-[#D99B26] bg-[#D99B26]/[0.06]'
                  : audioFile || segments.length > 0
                    ? 'border-white/[0.14] bg-[#0B0F17]/70 hover:border-white/[0.24]'
                    : 'border-white/[0.12] bg-[#0B0F17]/50 hover:border-[#D99B26]/50 hover:bg-[#0B0F17]'
              }`}
            >
              {audioFile ? (
                <div className="w-full space-y-2.5">
                  <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-md border border-[#D99B26]/30 bg-[#D99B26]/10 text-[#D99B26]">
                    <FileAudio className="h-4 w-4" />
                  </div>
                  <div className="space-y-0.5">
                    <p className="truncate px-2 text-sm font-medium text-[#F1F5F9]" title={audioFile.name}>
                      {audioFile.name}
                    </p>
                    <p className="font-mono text-xs tabular-nums text-[#D99B26]">
                      Süre: {formatMMSS(audioDuration)} · {(audioFile.size / (1024 * 1024)).toFixed(1)} MB
                    </p>
                  </div>
                  {!busy && (
                    <div className="flex items-center justify-center gap-3 pt-0.5">
                      <span className="text-xs text-[#94A3B8] underline decoration-white/20 underline-offset-4 group-hover:text-[#F1F5F9]">
                        Değiştir
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleClearAll();
                        }}
                        className="text-xs text-[#64748B] hover:text-rose-400"
                      >
                        Temizle
                      </button>
                    </div>
                  )}
                </div>
              ) : segments.length > 0 ? (
                <div className="w-full space-y-2.5">
                  <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-md border border-[#D99B26]/30 bg-[#D99B26]/10 text-[#D99B26]">
                    <FileText className="h-4 w-4" />
                  </div>
                  <div className="space-y-0.5">
                    <p className="truncate px-2 text-sm font-medium text-[#F1F5F9]" title={sourceLabel}>
                      {sourceLabel || 'Yüklenen Transkript (.srt)'}
                    </p>
                    <p className="font-mono text-xs tabular-nums text-[#D99B26]">
                      {segments.length} satır · {formatMMSS(audioDuration)}
                    </p>
                  </div>
                  {!busy && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleClearAll();
                      }}
                      className="text-xs text-[#64748B] hover:text-rose-400"
                    >
                      Temizle
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-md border border-white/[0.08] bg-[#1A2230] text-[#94A3B8] group-hover:text-[#D99B26]">
                    <Upload className="h-4 w-4" />
                  </div>
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium text-[#E2E8F0]">
                      Ses dosyasını veya hazır .SRT&apos;yi buraya bırakın
                    </p>
                    <p className="text-xs text-[#64748B]">
                      Uzun kayıtlar 5 dakikalık 16kHz WAV parçalarıyla çözümlenir
                    </p>
                  </div>
                </div>
              )}
            </div>

            {audioObjectUrl && (
              <audio
                ref={audioElRef}
                src={audioObjectUrl}
                controls
                onTimeUpdate={(e) => setCurrentPlaySec(e.currentTarget.currentTime)}
                className="h-9 w-full rounded-md"
              />
            )}

            {!hasAnyDeepgramKey && !busy && audioFile && segments.length === 0 && (
              <div className="flex items-start justify-between gap-3 rounded-md border border-[#D99B26]/25 bg-[#D99B26]/[0.06] px-3 py-2 text-xs text-[#CBD5E1]">
                <p className="leading-relaxed">
                  Transkript için Ayarlar&apos;dan Deepgram API anahtarınızı girin veya hazır .SRT yükleyin.
                </p>
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="shrink-0 whitespace-nowrap font-medium text-[#D99B26] underline underline-offset-4 hover:text-[#E5AA38]"
                >
                  Ayarlar
                </button>
              </div>
            )}

            {errorMessage && (
              <div className="flex items-start gap-2.5 rounded-md border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                <p className="leading-relaxed">{errorMessage}</p>
              </div>
            )}

            {/* Stage 1 Progress or Action */}
            {isTranscribing ? (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#D99B26]" />
                    <span className="truncate text-xs font-medium text-[#F1F5F9]">
                      {progress?.message || 'Hazırlanıyor...'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => transcribeAbortRef.current?.abort()}
                    className="shrink-0 rounded-md border border-white/[0.1] px-2.5 py-1 text-xs font-medium text-[#94A3B8] hover:border-rose-400/40 hover:text-rose-300"
                  >
                    İptal Et
                  </button>
                </div>
                {retryNotice !== null && (
                  <p className="font-mono text-xs tabular-nums text-[#D99B26]">
                    {retryNotice.reason} — {retryNotice.secondsLeft} sn sonra yeniden denenecek...
                  </p>
                )}
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#0B0F17]">
                  <div
                    className="h-full bg-[#D99B26] transition-all duration-300"
                    style={{ width: `${Math.max(6, transcribePercent)}%` }}
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isGeneratingPlan}
                  onClick={handleStartTranscribe}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2 text-xs font-semibold transition-colors disabled:opacity-50 ${
                    audioFile && segments.length === 0
                      ? 'cursor-pointer bg-[#D99B26] text-[#0B0F17] hover:bg-[#E5AA38]'
                      : 'cursor-pointer border border-white/[0.12] bg-[#0B0F17] text-[#CBD5E1] hover:border-[#D99B26]/50 hover:text-[#F1F5F9]'
                  }`}
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>{segments.length > 0 ? 'Yeniden Transkript Çıkar' : 'Transkript Çıkar'}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => srtInputRef.current?.click()}
                  className="shrink-0 whitespace-nowrap rounded-md border border-white/[0.1] bg-[#0B0F17] px-3 py-2 text-xs font-medium text-[#94A3B8] transition-colors hover:border-white/[0.2] hover:text-[#F1F5F9] disabled:opacity-50"
                >
                  .SRT Yükle
                </button>
              </div>
            )}
          </div>

          {/* Stage 2: Hydrogen Scene Timing Plan + 16:9 2K Period-Accurate Image Prompts */}
          <div className="space-y-4 border-t border-white/[0.08] pt-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium text-[#F1F5F9]">
                <Clapperboard className="h-4 w-4 text-[#D99B26]" />
                <span>2. Sahne Planı &amp; 16:9 2K Promptlar</span>
              </div>
              <span className="font-mono text-[11px] text-[#64748B]">Hydrogen Free</span>
            </div>

            <p className="text-xs leading-relaxed text-[#94A3B8]">
              Transkripti <span className="font-mono text-[#CBD5E1]">gemini-4-hydrogen</span>&apos;e göndererek
              her sahnenin ekranda kalacağı kesin saniyeleri ve dönemsel olarak anakronizmsiz (örn. 600&apos;lerde
              gözlük/gaz lambası olmadan) <span className="font-mono text-[#CBD5E1]">16:9 2K</span> görsel
              promptlarını tek dosyada üretir.
            </p>

            {/* Compact Optional Controls */}
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="plan-scene-count" className="block text-[11px] font-medium text-[#94A3B8]">
                    Sahne Sayısı
                  </label>
                  <select
                    id="plan-scene-count"
                    disabled={busy}
                    value={targetScenesChoice}
                    onChange={(e) => setTargetScenesChoice(Number(e.target.value))}
                    className="w-full rounded-md border border-white/[0.1] bg-[#0B0F17] px-2.5 py-2 text-xs text-[#F1F5F9] focus:border-[#D99B26]/60 focus:outline-none disabled:opacity-50"
                  >
                    <option value={0}>Otomatik (Hydrogen)</option>
                    <option value={40}>~40 sahne</option>
                    <option value={70}>~70 sahne</option>
                    <option value={100}>~100 sahne</option>
                    <option value={130}>~130 sahne</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label htmlFor="plan-max-duration" className="block text-[11px] font-medium text-[#94A3B8]">
                    Maks. Görsel Süresi
                  </label>
                  <select
                    id="plan-max-duration"
                    disabled={busy}
                    value={maxSceneSec}
                    onChange={(e) => setMaxSceneSec(Number(e.target.value))}
                    className="w-full rounded-md border border-white/[0.1] bg-[#0B0F17] px-2.5 py-2 text-xs text-[#F1F5F9] focus:border-[#D99B26]/60 focus:outline-none disabled:opacity-50"
                  >
                    <option value={45}>Maks. 45 saniye</option>
                    <option value={60}>Maks. 60 saniye (Önerilen)</option>
                    <option value={90}>Maks. 90 saniye</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label htmlFor="plan-style-note" className="block text-[11px] font-medium text-[#94A3B8]">
                  Görsel Stil <span className="text-[#64748B]">(İsteğe bağlı)</span>
                </label>
                <input
                  id="plan-style-note"
                  type="text"
                  disabled={busy}
                  value={styleDirection}
                  onChange={(e) => setStyleDirection(e.target.value)}
                  placeholder="Varsayılan: Sinematik tarihi belgesel"
                  className="w-full rounded-md border border-white/[0.1] bg-[#0B0F17] px-2.5 py-2 text-xs text-[#F1F5F9] placeholder-[#475569] focus:border-[#D99B26]/60 focus:outline-none disabled:opacity-50"
                />
              </div>
            </div>

            {planError && (
              <div className="flex items-start gap-2.5 rounded-md border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                <p className="leading-relaxed">{planError}</p>
              </div>
            )}

            {isGeneratingPlan ? (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#D99B26]" />
                    <span className="truncate text-xs font-medium text-[#F1F5F9]">
                      {planProgress?.message || 'Hydrogen sahne planını hazırlıyor...'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => planAbortRef.current?.abort()}
                    className="shrink-0 rounded-md border border-white/[0.1] px-2.5 py-1 text-xs font-medium text-[#94A3B8] hover:border-rose-400/40 hover:text-rose-300"
                  >
                    İptal Et
                  </button>
                </div>

                {planRetryNotice !== null && (
                  <p className="font-mono text-xs tabular-nums text-[#D99B26]">
                    {planRetryNotice.reason} — {planRetryNotice.secondsLeft} sn sonra yeniden denenecek...
                  </p>
                )}

                <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#0B0F17]">
                  <div
                    className="h-full bg-[#D99B26] transition-all duration-300"
                    style={{ width: `${Math.max(8, planPercent)}%` }}
                  />
                </div>

                {scenePlan.length > 0 && (
                  <p className="font-mono text-[11px] tabular-nums text-[#64748B]">
                    Şu ana kadar {scenePlan.length} sahne ve 16:9 2K prompt oluşturuldu...
                  </p>
                )}
              </div>
            ) : (
              <button
                type="button"
                disabled={segments.length === 0 || isTranscribing}
                onClick={handleGenerateScenePlan}
                className={`flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                  segments.length > 0
                    ? 'cursor-pointer bg-[#D99B26] text-[#0B0F17] hover:bg-[#E5AA38]'
                    : 'border border-white/[0.1] bg-[#1E293B] text-[#94A3B8]'
                }`}
              >
                <ListOrdered className="h-4 w-4" />
                <span>
                  {scenePlan.length > 0
                    ? 'Hydrogen ile Sahne Planını Yeniden Üret'
                    : 'Hydrogen ile Sahne Planı & Prompt Üret'}
                </span>
              </button>
            )}
          </div>
        </section>

        {/* Right: Unified Tabbed Output (Transkript | Sahne Planı & Promptlar) */}
        <section className="flex flex-col rounded-lg border border-white/[0.08] bg-[#131924] p-6 lg:col-span-7">
          {/* Output Tab Switcher */}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] pb-4">
            <div className="inline-flex rounded-md border border-white/[0.08] bg-[#0B0F17] p-0.5">
              <button
                type="button"
                onClick={() => setActiveRightTab('transcript')}
                className={`flex items-center gap-1.5 whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeRightTab === 'transcript'
                    ? 'bg-[#1A2230] text-[#F1F5F9]'
                    : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                }`}
              >
                <FileText className="h-3.5 w-3.5 text-[#D99B26]" />
                <span>
                  Transkript{segments.length > 0 ? ` (${segments.length})` : ''}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setActiveRightTab('plan')}
                className={`flex items-center gap-1.5 whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeRightTab === 'plan'
                    ? 'bg-[#1A2230] text-[#F1F5F9]'
                    : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                }`}
              >
                <ListOrdered className="h-3.5 w-3.5 text-[#D99B26]" />
                <span>
                  Sahne Planı &amp; Promptlar{scenePlan.length > 0 ? ` (${scenePlan.length})` : ''}
                </span>
              </button>
            </div>

            {activeRightTab === 'transcript' && segments.length > 0 && (
              <p className="font-mono text-xs tabular-nums text-[#64748B]">
                {segments.length} satır · {wordCount} kelime · {formatMMSS(audioDuration)}
              </p>
            )}
            {activeRightTab === 'plan' && scenePlan.length > 0 && (
              <p className="font-mono text-xs tabular-nums text-[#64748B]">
                {scenePlan.length} sahne · ort. {planDurationStats.avgSec} sn · maks. {planDurationStats.maxSec} sn · 16:9 2K
              </p>
            )}
          </div>

          {/* TAB 1: TRANSCRIPT */}
          {activeRightTab === 'transcript' && (
            <>
              {segments.length === 0 ? (
                <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
                  <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-md border border-white/[0.08] bg-[#0B0F17] text-[#64748B]">
                    <FileText className="h-5 w-5" />
                  </div>
                  <h2 className="text-sm font-medium text-[#E2E8F0]">
                    Transkript burada görünecek
                  </h2>
                  <p className="mt-1.5 max-w-md text-xs leading-relaxed text-[#64748B]">
                    Sol taraftan ses dosyası yükleyip <span className="text-[#CBD5E1]">Transkript Çıkar</span>{' '}
                    düğmesine basın (veya mevcut <span className="font-mono text-[#CBD5E1]">.SRT</span> dosyanızı yükleyin).
                    Ardından tek tıkla Hydrogen&apos;e sahne süre planını ve 16:9 2K görsel promptlarını yazdırabilirsiniz.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Transcript Export Toolbar */}
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="inline-flex rounded-md border border-white/[0.08] bg-[#0B0F17] p-0.5">
                      <button
                        type="button"
                        onClick={() => setViewMode('timed')}
                        className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                          viewMode === 'timed'
                            ? 'bg-[#1A2230] text-[#F1F5F9]'
                            : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                        }`}
                      >
                        Zaman Damgalı
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewMode('plain')}
                        className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                          viewMode === 'plain'
                            ? 'bg-[#1A2230] text-[#F1F5F9]'
                            : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                        }`}
                      >
                        Düz Metin
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard(
                            viewMode === 'plain' ? plainText : segmentsToSrt(segments),
                            'transcript'
                          )
                        }
                        className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-white/[0.1] bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-[#CBD5E1] transition-colors hover:border-white/[0.2] hover:text-[#F1F5F9]"
                      >
                        {copiedType === 'transcript' ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                            <span>Kopyalandı</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5 text-[#94A3B8]" />
                            <span>{viewMode === 'plain' ? 'Metni Kopyala' : 'SRT Kopyala'}</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={handleDownloadTranscriptTxt}
                        className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-white/[0.1] bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-[#CBD5E1] transition-colors hover:border-white/[0.2] hover:text-[#F1F5F9]"
                      >
                        <Download className="h-3.5 w-3.5 text-[#94A3B8]" />
                        <span>.TXT</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleDownloadSrt}
                        className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[#D99B26]/40 bg-[#D99B26]/15 px-3 py-1.5 text-xs font-semibold text-[#F1F5F9] transition-colors hover:bg-[#D99B26]/25"
                      >
                        <Download className="h-3.5 w-3.5 text-[#D99B26]" />
                        <span>.SRT İndir</span>
                      </button>
                    </div>
                  </div>

                  {viewMode === 'timed' && (
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#64748B]" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Transkript içinde ara..."
                        className="w-full rounded-md border border-white/[0.08] bg-[#0B0F17] py-1.5 pl-8 pr-7 text-xs text-[#F1F5F9] placeholder-[#475569] focus:border-[#D99B26]/60 focus:outline-none"
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={() => setSearchQuery('')}
                          aria-label="Aramayı temizle"
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-[#64748B] hover:text-[#CBD5E1]"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  )}

                  {viewMode === 'timed' ? (
                    <div className="max-h-[450px] divide-y divide-white/[0.05] overflow-y-auto rounded-md border border-white/[0.07] bg-[#0B0F17]/60">
                      {filteredSegments.length === 0 ? (
                        <div className="p-8 text-center text-xs text-[#64748B]">
                          &ldquo;{searchQuery}&rdquo; ile eşleşen satır bulunamadı.
                        </div>
                      ) : (
                        filteredSegments.map((seg, idx) => {
                          const isPlayingHere =
                            currentPlaySec >= seg.startSec && currentPlaySec <= seg.endSec;
                          return (
                            <div
                              key={`${seg.startSec}-${idx}`}
                              className={`flex items-start gap-3 px-3.5 py-2.5 transition-colors ${
                                isPlayingHere ? 'bg-[#D99B26]/[0.08]' : 'hover:bg-white/[0.02]'
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => handleSeekTo(seg.startSec)}
                                title="Bu saniyeden dinle"
                                className={`mt-0.5 flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums transition-colors ${
                                  isPlayingHere
                                    ? 'text-[#D99B26]'
                                    : 'text-[#64748B] hover:text-[#D99B26]'
                                }`}
                              >
                                <Play className="h-2.5 w-2.5" />
                                <span>
                                  {formatMMSS(seg.startSec)}–{formatMMSS(seg.endSec)}
                                </span>
                              </button>
                              <p className="text-sm leading-relaxed text-[#E2E8F0]">{seg.text}</p>
                            </div>
                          );
                        })
                      )}
                    </div>
                  ) : (
                    <textarea
                      readOnly
                      value={plainText}
                      rows={16}
                      className="w-full rounded-md border border-white/[0.07] bg-[#0B0F17]/70 p-4 text-sm leading-relaxed text-[#E2E8F0] focus:border-[#D99B26]/50 focus:outline-none"
                    />
                  )}
                </div>
              )}
            </>
          )}

          {/* TAB 2: HYDROGEN SCENE PLAN & 16:9 2K IMAGE PROMPTS */}
          {activeRightTab === 'plan' && (
            <>
              {scenePlan.length === 0 ? (
                <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
                  <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-md border border-white/[0.08] bg-[#0B0F17] text-[#64748B]">
                    {isGeneratingPlan ? (
                      <Loader2 className="h-5 w-5 animate-spin text-[#D99B26]" />
                    ) : (
                      <Clapperboard className="h-5 w-5" />
                    )}
                  </div>
                  <h2 className="text-sm font-medium text-[#E2E8F0]">
                    {isGeneratingPlan
                      ? planProgress?.message || 'Hydrogen sahne planını yazıyor...'
                      : 'Sahne planı ve 16:9 2K promptlar burada görünecek'}
                  </h2>
                  <p className="mt-1.5 max-w-md text-xs leading-relaxed text-[#64748B]">
                    {isGeneratingPlan
                      ? 'Uzun belgesellerde kesinti ve kayma olmaması için transkript 10 dakikalık bölümler halinde işlenir; sahneler geldikçe burada canlı listelenecektir.'
                      : 'Önce soldan transkript çıkarın (veya .SRT yükleyin), ardından "Hydrogen ile Sahne Planı & Prompt Üret" düğmesine basın.'}
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Export & View Toolbar */}
                  <div className="flex flex-wrap items-center justify-between gap-2.5">
                    <div className="inline-flex rounded-md border border-white/[0.08] bg-[#0B0F17] p-0.5">
                      <button
                        type="button"
                        onClick={() => setPlanViewMode('cards')}
                        className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                          planViewMode === 'cards'
                            ? 'bg-[#1A2230] text-[#F1F5F9]'
                            : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                        }`}
                      >
                        Sahne Listesi
                      </button>
                      <button
                        type="button"
                        onClick={() => setPlanViewMode('txt')}
                        className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                          planViewMode === 'txt'
                            ? 'bg-[#1A2230] text-[#F1F5F9]'
                            : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                        }`}
                      >
                        Tek .TXT Önizleme
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => copyToClipboard(unifiedPlanTxt, 'all-plan')}
                        className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-white/[0.1] bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-[#CBD5E1] transition-colors hover:border-white/[0.2] hover:text-[#F1F5F9]"
                      >
                        {copiedType === 'all-plan' ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                            <span>Kopyalandı</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5 text-[#94A3B8]" />
                            <span>Tümünü Kopyala</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={handleDownloadPromptsOnlyTxt}
                        className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-white/[0.1] bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-[#CBD5E1] transition-colors hover:border-white/[0.2] hover:text-[#F1F5F9]"
                      >
                        <Download className="h-3.5 w-3.5 text-[#94A3B8]" />
                        <span>Sadece Prompt</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleDownloadUnifiedPlanTxt}
                        className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-[#D99B26] px-3.5 py-1.5 text-xs font-semibold text-[#0B0F17] transition-colors hover:bg-[#E5AA38]"
                      >
                        <Download className="h-3.5 w-3.5" />
                        <span>Plan + Prompt (.TXT) İndir</span>
                      </button>
                    </div>
                  </div>

                  {planViewMode === 'cards' ? (
                    <>
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#64748B]" />
                        <input
                          type="text"
                          value={planSearchQuery}
                          onChange={(e) => setPlanSearchQuery(e.target.value)}
                          placeholder="Sahne başlığı, dönem veya prompt içinde ara..."
                          className="w-full rounded-md border border-white/[0.08] bg-[#0B0F17] py-1.5 pl-8 pr-7 text-xs text-[#F1F5F9] placeholder-[#475569] focus:border-[#D99B26]/60 focus:outline-none"
                        />
                        {planSearchQuery && (
                          <button
                            type="button"
                            onClick={() => setPlanSearchQuery('')}
                            aria-label="Aramayı temizle"
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-[#64748B] hover:text-[#CBD5E1]"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>

                      <div className="max-h-[460px] divide-y divide-white/[0.06] overflow-y-auto rounded-md border border-white/[0.07] bg-[#0B0F17]/60">
                        {filteredPlan.length === 0 ? (
                          <div className="p-8 text-center text-xs text-[#64748B]">
                            &ldquo;{planSearchQuery}&rdquo; ile eşleşen sahne bulunamadı.
                          </div>
                        ) : (
                          filteredPlan.map((item) => {
                            const durRounded = Math.max(1, Math.round(item.durationSec));
                            const copyKey = `prompt-${item.orderNumber}`;
                            return (
                              <div
                                key={item.orderNumber}
                                className="space-y-2 px-4 py-3.5 transition-colors hover:bg-white/[0.02]"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0 space-y-0.5">
                                    <div className="flex items-baseline gap-2">
                                      <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-[#D99B26]">
                                        #{item.orderNumber}
                                      </span>
                                      <h3 className="text-sm font-medium text-[#F1F5F9]">
                                        {item.title}
                                      </h3>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] tabular-nums text-[#64748B]">
                                      <button
                                        type="button"
                                        onClick={() => handleSeekTo(item.startSec)}
                                        title="Bu sahnenin başından dinle"
                                        className="flex items-center gap-1 text-[#94A3B8] transition-colors hover:text-[#D99B26]"
                                      >
                                        <Play className="h-2.5 w-2.5" />
                                        <span>
                                          {formatHHMMSS(item.startSec)} – {formatHHMMSS(item.endSec)}
                                        </span>
                                      </button>
                                      <span aria-hidden="true">·</span>
                                      <span>{durRounded} saniye</span>
                                      {item.era && (
                                        <>
                                          <span aria-hidden="true">·</span>
                                          <span className="font-sans text-[#94A3B8]">{item.era}</span>
                                        </>
                                      )}
                                    </div>
                                  </div>

                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard(item.imagePrompt, copyKey)}
                                    title="Bu sahnenin görsel promptunu kopyala"
                                    className="flex shrink-0 items-center gap-1 rounded border border-white/[0.08] bg-[#131924] px-2 py-1 text-[11px] text-[#94A3B8] transition-colors hover:border-white/[0.18] hover:text-[#F1F5F9]"
                                  >
                                    {copiedType === copyKey ? (
                                      <>
                                        <Check className="h-3 w-3 text-emerald-400" />
                                        <span className="text-emerald-300">Kopyalandı</span>
                                      </>
                                    ) : (
                                      <>
                                        <Copy className="h-3 w-3" />
                                        <span>Prompt</span>
                                      </>
                                    )}
                                  </button>
                                </div>

                                <p className="text-xs leading-relaxed text-[#CBD5E1]">
                                  {item.imagePrompt}
                                </p>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </>
                  ) : (
                    <textarea
                      readOnly
                      value={unifiedPlanTxt}
                      rows={18}
                      className="w-full rounded-md border border-white/[0.07] bg-[#0B0F17]/70 p-4 font-mono text-xs leading-relaxed text-[#CBD5E1] focus:border-[#D99B26]/50 focus:outline-none"
                    />
                  )}
                </div>
              )}
            </>
          )}

          {/* Bottom 1-Click Handoff to Step 1 Documentary Editor */}
          {(segments.length > 0 || scenePlan.length > 0) && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-4 text-xs text-[#64748B]">
              <span>
                {scenePlan.length > 0
                  ? 'Üretilen sahne süre planını (.TXT) ve transkripti (.SRT) tek tıkla Kurgu Adım 1’e aktarın; ardından numaralı görselleri bırakmanız yeterli.'
                  : 'Bu transkripti doğrudan Kurgu Adım 1’e aktarabilirsiniz.'}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  onUseTranscriptInEditor(
                    segments,
                    `${baseName}.srt`,
                    audioFile,
                    audioDuration,
                    scenePlan.length > 0 ? scenePlan : undefined,
                    scenePlan.length > 0 ? `${baseName}_sahne_plani_ve_promptlar.txt` : undefined
                  )
                }
                className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[#D99B26]/40 bg-[#D99B26]/10 px-3 py-1.5 font-medium text-[#F1F5F9] transition-colors hover:bg-[#D99B26]/20 disabled:opacity-50"
              >
                <span>
                  {scenePlan.length > 0
                    ? "Plan + Transkripti Adım 1'e Aktar"
                    : "Transkripti Adım 1'e Aktar"}
                </span>
                <ArrowRight className="h-3.5 w-3.5 text-[#D99B26]" />
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
