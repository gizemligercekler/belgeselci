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
  MessageSquareQuote,
  Plus,
  Trash2,
  Palette,
} from 'lucide-react';
import {
  DialogueSubtitleEntry,
  DialogueSubtitleKind,
  EditorSettings,
  GeneratedScenePlanItem,
  SubtitleStyleConfig,
  TranscriptSegment,
} from '../types/editor';
import {
  dialogueEntriesToSrt,
  formatHHMMSS,
  parseFlexibleTimeSec,
  parseSrtToSegments,
  readAudioDuration,
  scenePlanToPromptsOnlyTxt,
  scenePlanToUnifiedTxt,
  segmentsToSrt,
} from '../utils/mediaUtils';
import { formatMMSS } from '../utils/timelineMath';
import { downloadTextFile } from '../utils/exportBundle';
import {
  DialogueSubtitleProgress,
  extractDialogueSubtitlesWithHydrogen,
  generateScenePlanWithHydrogen,
  RetryNotice,
  ScenePlanProgress,
  TranscribeProgress,
  transcribeAudioInChunks,
} from '../services/editorApi';
import { SubtitleStyleEditor } from './SubtitleStyleEditor';

interface StandaloneTranscriberProps {
  settings: EditorSettings;
  hasDeepgramKey: boolean;
  subtitleStyle: SubtitleStyleConfig;
  onChangeSubtitleStyle: (next: SubtitleStyleConfig) => void;
  onOpenSettings: () => void;
  onUseTranscriptInEditor: (
    segments: TranscriptSegment[],
    sourceName: string,
    audioFile: File | null,
    durationSec: number,
    generatedPlan?: GeneratedScenePlanItem[],
    planFileName?: string,
    selectiveSubtitles?: DialogueSubtitleEntry[]
  ) => void;
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').trim() || 'belgesel';
}

export const StandaloneTranscriber: React.FC<StandaloneTranscriberProps> = ({
  settings,
  hasDeepgramKey,
  subtitleStyle,
  onChangeSubtitleStyle,
  onOpenSettings,
  onUseTranscriptInEditor,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);
  const audioElRef = useRef<HTMLAudioElement>(null);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const planAbortRef = useRef<AbortController | null>(null);
  const selectiveAbortRef = useRef<AbortController | null>(null);

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
  const [activeRightTab, setActiveRightTab] = useState<'transcript' | 'plan' | 'selective'>('transcript');
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

  // Hydrogen Selective Dialogue & Scripture Subtitle Extractor state
  const [isExtractingSelective, setIsExtractingSelective] = useState(false);
  const [selectiveProgress, setSelectiveProgress] = useState<DialogueSubtitleProgress | null>(null);
  const [selectiveRetryNotice, setSelectiveRetryNotice] = useState<RetryNotice | null>(null);
  const [selectiveError, setSelectiveError] = useState<string | null>(null);
  const [selectiveEntries, setSelectiveEntries] = useState<DialogueSubtitleEntry[]>([]);
  const [selectiveModelUsed, setSelectiveModelUsed] = useState<string>('');
  const [selectiveViewMode, setSelectiveViewMode] = useState<'edit' | 'srt' | 'style'>('edit');
  const [selectiveTimeDrafts, setSelectiveTimeDrafts] = useState<
    Record<string, { start?: string; end?: string }>
  >({});

  const audioUrlRef = useRef<string | null>(null);
  audioUrlRef.current = audioObjectUrl;

  useEffect(() => {
    return () => {
      transcribeAbortRef.current?.abort();
      planAbortRef.current?.abort();
      selectiveAbortRef.current?.abort();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  const handleLoadSrtFile = async (file: File) => {
    setErrorMessage(null);
    setPlanError(null);
    setSelectiveError(null);
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
      setSelectiveEntries([]);
      setSelectiveModelUsed('');
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
    setSelectiveError(null);
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
      setSelectiveEntries([]);
      setSelectiveModelUsed('');
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
    selectiveAbortRef.current?.abort();
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    setAudioFile(null);
    setAudioObjectUrl(null);
    setAudioDuration(0);
    setSourceLabel('');
    setSegments([]);
    setScenePlan([]);
    setPlanModelUsed('');
    setSelectiveEntries([]);
    setSelectiveModelUsed('');
    setSearchQuery('');
    setPlanSearchQuery('');
    setErrorMessage(null);
    setPlanError(null);
    setSelectiveError(null);
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

  const handleExtractSelectiveSubtitles = async () => {
    if (segments.length === 0 || isExtractingSelective) return;

    const controller = new AbortController();
    selectiveAbortRef.current = controller;

    setIsExtractingSelective(true);
    setSelectiveError(null);
    setSelectiveRetryNotice(null);
    setSelectiveEntries([]);
    setSelectiveTimeDrafts({});
    setActiveRightTab('selective');
    setSelectiveViewMode('edit');

    try {
      const effectiveDur =
        audioDuration > 0
          ? audioDuration
          : segments.reduce((m, s) => Math.max(m, s.endSec), 0);

      const { entries, modelUsed } = await extractDialogueSubtitlesWithHydrogen(
        segments,
        effectiveDur,
        settings,
        {
          signal: controller.signal,
          onProgress: (p) => setSelectiveProgress(p),
          onRetryWait: (notice) => setSelectiveRetryNotice(notice),
          onPartialEntries: (partial) => setSelectiveEntries(partial),
        }
      );

      if (controller.signal.aborted) return;

      setSelectiveEntries(entries);
      setSelectiveModelUsed(modelUsed);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        setSelectiveError('Seçme altyazı ayıklama işlemi iptal edildi.');
      } else {
        setSelectiveError(
          err instanceof Error
            ? err.message
            : 'Hydrogen ile diyalog & ayet altyazısı çıkarılırken bir hata oluştu.'
        );
      }
    } finally {
      setIsExtractingSelective(false);
      setSelectiveProgress(null);
      setSelectiveRetryNotice(null);
      selectiveAbortRef.current = null;
    }
  };

  const handleUpdateSelectiveEntry = (
    id: string,
    patch: Partial<Omit<DialogueSubtitleEntry, 'id'>>
  ) => {
    setSelectiveEntries((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  };

  const handleCommitSelectiveTime = (id: string, field: 'start' | 'end') => {
    const draft = selectiveTimeDrafts[id]?.[field];
    setSelectiveTimeDrafts((prev) => {
      const next = { ...prev };
      if (next[id]) {
        const copy = { ...next[id] };
        delete copy[field];
        if (!copy.start && !copy.end) delete next[id];
        else next[id] = copy;
      }
      return next;
    });
    if (draft === undefined) return;
    const parsed = parseFlexibleTimeSec(draft);
    if (parsed === null) return;
    const maxCap = Math.max(audioDuration, 86400);
    const clamped = Math.max(0, Math.min(maxCap, parsed));
    setSelectiveEntries((prev) => {
      const updated = prev.map((item) => {
        if (item.id !== id) return item;
        if (field === 'start') {
          const nextEnd = Math.max(clamped + 0.5, item.endSec);
          return { ...item, startSec: clamped, endSec: nextEnd };
        }
        const nextEnd = Math.max(item.startSec + 0.5, clamped);
        return { ...item, endSec: nextEnd };
      });
      return [...updated].sort((a, b) => a.startSec - b.startSec);
    });
  };

  const handleDeleteSelectiveEntry = (id: string) => {
    setSelectiveEntries((prev) => prev.filter((item) => item.id !== id));
  };

  const handleAddManualSelectiveEntry = () => {
    const startSec =
      currentPlaySec >= 0
        ? Number(currentPlaySec.toFixed(2))
        : selectiveEntries.length > 0
          ? Number((selectiveEntries[selectiveEntries.length - 1].endSec + 1).toFixed(2))
          : 0;
    const endSec = Number((startSec + 4).toFixed(2));
    const newEntry: DialogueSubtitleEntry = {
      id: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      startSec,
      endSec,
      kind: 'diyalog',
      source: 'Konuşmacı',
      text: '',
    };
    setSelectiveEntries((prev) => [...prev, newEntry].sort((a, b) => a.startSec - b.startSec));
    setSelectiveViewMode('edit');
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
  const selectiveSrtText = useMemo(
    () => dialogueEntriesToSrt(selectiveEntries, subtitleStyle.includeSourcePrefix),
    [selectiveEntries, subtitleStyle.includeSourcePrefix]
  );

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

  const handleDownloadSelectiveSrt = () => {
    if (!selectiveSrtText) return;
    downloadTextFile(
      `${baseName}_secme_diyalog_ayet.srt`,
      selectiveSrtText,
      'application/x-subrip;charset=utf-8'
    );
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

  const selectivePercent =
    selectiveProgress && selectiveProgress.totalBlocks > 0
      ? Math.round(((selectiveProgress.currentBlock - 0.4) / selectiveProgress.totalBlocks) * 95)
      : 15;

  const deepgramModel = settings.deepgramModel === 'nova-2' ? 'nova-2' : 'nova-3';
  const hasAnyDeepgramKey = Boolean(settings.deepgramApiKey.trim() || hasDeepgramKey);
  const busy = isTranscribing || isGeneratingPlan || isExtractingSelective;

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
            <span className="text-[#CBD5E1]">Gemini 4 Hydrogen</span> ile Nano Banana / Gemini uyumlu tam kare
            belgesel fotoğraf promptlarını ve saniye bazlı sahne planını tek{' '}
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
                <span>2. Sahne Planı &amp; Görsel Promptlar</span>
              </div>
              <span className="font-mono text-[11px] text-[#64748B]">Nano Banana · Free</span>
            </div>

            <p className="text-xs leading-relaxed text-[#94A3B8]">
              Transkripti <span className="font-mono text-[#CBD5E1]">gemini-4-hydrogen</span>&apos;e göndererek
              siyah şeritsiz, yalnızca pozitif tarihsel betimlemeli tam kare (
              <span className="font-mono text-[#CBD5E1]">full-frame</span>) belgesel fotoğraf promptlarını ve
              sahne sürelerini tek dosyada üretir.
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
                    <option value={20}>Maks. 20 saniye</option>
                    <option value={30}>Maks. 30 saniye</option>
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
                  placeholder="Varsayılan: Tarihsel belgesel fotoğrafçılığı"
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
                    Şu ana kadar {scenePlan.length} sahne ve belgesel fotoğraf promptu oluşturuldu...
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

          {/* Stage 3: Hydrogen Selective Dialogue & Scripture Subtitle Extractor */}
          <div className="space-y-3.5 border-t border-white/[0.08] pt-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium text-[#F1F5F9]">
                <MessageSquareQuote className="h-4 w-4 text-[#D99B26]" />
                <span>3. Seçme Altyazı (Diyalog &amp; Ayet)</span>
              </div>
              <span className="font-mono text-[11px] text-[#64748B]">.SRT · Free</span>
            </div>

            <p className="text-xs leading-relaxed text-[#94A3B8]">
              Anlatıcıyı atlayıp yalnızca karşılıklı diyalogları (kral, peygamber, rahip konuşmaları) ve
              kutsal metin ayetlerini (Kur&apos;an, Tevrat, İncil) kaynak etiketiyle özel{' '}
              <span className="font-mono text-[#CBD5E1]">.SRT</span> olarak ayıklar. Çıkan satırları elle
              düzenleyip yazı stilini belirleyebilirsiniz.
            </p>

            {selectiveError && (
              <div className="flex items-start gap-2.5 rounded-md border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                <p className="leading-relaxed">{selectiveError}</p>
              </div>
            )}

            {isExtractingSelective ? (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#D99B26]" />
                    <span className="truncate text-xs font-medium text-[#F1F5F9]">
                      {selectiveProgress?.message || 'Hydrogen diyalog ve ayetleri ayıklıyor...'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => selectiveAbortRef.current?.abort()}
                    className="shrink-0 rounded-md border border-white/[0.1] px-2.5 py-1 text-xs font-medium text-[#94A3B8] hover:border-rose-400/40 hover:text-rose-300"
                  >
                    İptal Et
                  </button>
                </div>

                {selectiveRetryNotice !== null && (
                  <p className="font-mono text-xs tabular-nums text-[#D99B26]">
                    {selectiveRetryNotice.reason} — {selectiveRetryNotice.secondsLeft} sn sonra yeniden denenecek...
                  </p>
                )}

                <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#0B0F17]">
                  <div
                    className="h-full bg-[#D99B26] transition-all duration-300"
                    style={{ width: `${Math.max(10, selectivePercent)}%` }}
                  />
                </div>

                {selectiveEntries.length > 0 && (
                  <p className="font-mono text-[11px] tabular-nums text-[#64748B]">
                    Şu ana kadar {selectiveEntries.length} diyalog / ayet satırı bulundu...
                  </p>
                )}
              </div>
            ) : (
              <button
                type="button"
                disabled={segments.length === 0 || isTranscribing || isGeneratingPlan}
                onClick={handleExtractSelectiveSubtitles}
                className={`flex w-full items-center justify-center gap-2 rounded-md border px-4 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                  segments.length > 0
                    ? 'cursor-pointer border-[#D99B26]/50 bg-[#D99B26]/12 text-[#F1F5F9] hover:bg-[#D99B26]/22'
                    : 'border-white/[0.1] bg-[#0B0F17] text-[#64748B]'
                }`}
              >
                <MessageSquareQuote className="h-3.5 w-3.5 text-[#D99B26]" />
                <span>
                  {selectiveEntries.length > 0
                    ? 'Hydrogen ile Diyalog & Ayetleri Yeniden Ayıkla'
                    : 'Hydrogen ile Diyalog & Ayet Ayıkla'}
                </span>
              </button>
            )}
          </div>
        </section>

        {/* Right: Unified Tabbed Output (Transkript | Sahne Planı & Promptlar | Seçme Altyazı) */}
        <section className="flex flex-col rounded-lg border border-white/[0.08] bg-[#131924] p-6 lg:col-span-7">
          {/* Output Tab Switcher */}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] pb-4">
            <div className="inline-flex flex-wrap rounded-md border border-white/[0.08] bg-[#0B0F17] p-0.5">
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
                  Sahne Planı{scenePlan.length > 0 ? ` (${scenePlan.length})` : ''}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setActiveRightTab('selective')}
                className={`flex items-center gap-1.5 whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeRightTab === 'selective'
                    ? 'bg-[#1A2230] text-[#F1F5F9]'
                    : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                }`}
              >
                <MessageSquareQuote className="h-3.5 w-3.5 text-[#D99B26]" />
                <span>
                  Seçme Altyazı{selectiveEntries.length > 0 ? ` (${selectiveEntries.length})` : ''}
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
                {scenePlan.length} sahne · ort. {planDurationStats.avgSec} sn · maks. {planDurationStats.maxSec} sn · full-frame
              </p>
            )}
            {activeRightTab === 'selective' && selectiveEntries.length > 0 && (
              <p className="font-mono text-xs tabular-nums text-[#64748B]">
                {selectiveEntries.length} seçme satır{selectiveModelUsed ? ` · ${selectiveModelUsed}` : ''}
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
                    Ardından tek tıkla Hydrogen&apos;e sahne süre planını ve Nano Banana uyumlu belgesel fotoğraf promptlarını yazdırabilirsiniz.
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
                      : 'Sahne planı ve belgesel fotoğraf promptları burada görünecek'}
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

          {/* TAB 3: SELECTIVE DIALOGUE & SCRIPTURE SUBTITLES (.SRT) + VISUAL STYLE */}
          {activeRightTab === 'selective' && (
            <div className="space-y-4">
              {/* Sub-mode & Export Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="inline-flex rounded-md border border-white/[0.08] bg-[#0B0F17] p-0.5">
                  <button
                    type="button"
                    onClick={() => setSelectiveViewMode('edit')}
                    className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                      selectiveViewMode === 'edit'
                        ? 'bg-[#1A2230] text-[#F1F5F9]'
                        : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                    }`}
                  >
                    Satırları Düzenle
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectiveViewMode('srt')}
                    className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                      selectiveViewMode === 'srt'
                        ? 'bg-[#1A2230] text-[#F1F5F9]'
                        : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                    }`}
                  >
                    .SRT Önizleme
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectiveViewMode('style')}
                    className={`flex items-center gap-1 rounded px-3 py-1 text-xs font-medium transition-colors ${
                      selectiveViewMode === 'style'
                        ? 'bg-[#1A2230] text-[#F1F5F9]'
                        : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                    }`}
                  >
                    <Palette className="h-3 w-3 text-[#D99B26]" />
                    <span>Stil &amp; Görünüm</span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleAddManualSelectiveEntry}
                    className="flex items-center gap-1 whitespace-nowrap rounded-md border border-white/[0.1] bg-[#0B0F17] px-2.5 py-1.5 text-xs font-medium text-[#CBD5E1] transition-colors hover:border-[#D99B26]/50 hover:text-[#F1F5F9]"
                  >
                    <Plus className="h-3.5 w-3.5 text-[#D99B26]" />
                    <span>Satır Ekle</span>
                  </button>

                  {selectiveEntries.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(selectiveSrtText, 'selective-srt')}
                        className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-white/[0.1] bg-[#0B0F17] px-2.5 py-1.5 text-xs font-medium text-[#CBD5E1] transition-colors hover:border-white/[0.2] hover:text-[#F1F5F9]"
                      >
                        {copiedType === 'selective-srt' ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                            <span>Kopyalandı</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5 text-[#94A3B8]" />
                            <span>Kopyala</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={handleDownloadSelectiveSrt}
                        className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-[#D99B26] px-3 py-1.5 text-xs font-semibold text-[#0B0F17] transition-colors hover:bg-[#E5AA38]"
                      >
                        <Download className="h-3.5 w-3.5" />
                        <span>Seçme .SRT İndir</span>
                      </button>
                    </>
                  )}
                </div>
              </div>

              {selectiveViewMode === 'style' ? (
                <SubtitleStyleEditor
                  style={subtitleStyle}
                  onChange={onChangeSubtitleStyle}
                  sampleSource={selectiveEntries[0]?.source || 'Kral'}
                  sampleText={
                    selectiveEntries[0]?.text ||
                    '"Bu topraklarda hakikat, kılıçtan daha uzun yaşar."'
                  }
                />
              ) : selectiveEntries.length === 0 ? (
                <div className="flex min-h-[380px] flex-col items-center justify-center text-center">
                  <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-md border border-white/[0.08] bg-[#0B0F17] text-[#64748B]">
                    {isExtractingSelective ? (
                      <Loader2 className="h-5 w-5 animate-spin text-[#D99B26]" />
                    ) : (
                      <MessageSquareQuote className="h-5 w-5" />
                    )}
                  </div>
                  <h2 className="text-sm font-medium text-[#E2E8F0]">
                    {isExtractingSelective
                      ? selectiveProgress?.message || 'Hydrogen diyalog ve ayetleri arıyor...'
                      : 'Seçme diyalog ve ayet satırları burada görünecek'}
                  </h2>
                  <p className="mt-1.5 max-w-md text-xs leading-relaxed text-[#64748B]">
                    {isExtractingSelective
                      ? 'Uzun transkriptler 20 dakikalık bloklarda taranır; bulunan diyalog ve ayetler anlık olarak buraya eklenir.'
                      : 'Soldaki "3. Seçme Altyazı" bölümünden Hydrogen ile otomatik ayıklama başlatabilir ya da "+ Satır Ekle" ile elle ekleyebilirsiniz.'}
                  </p>
                </div>
              ) : selectiveViewMode === 'srt' ? (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-[11px] text-[#94A3B8]">
                    <span>
                      Kaynak etiketi:{' '}
                      <strong className="text-[#E2E8F0]">
                        {subtitleStyle.includeSourcePrefix ? 'Açık (Kaynak: Metin)' : 'Kapalı (Sadece Metin)'}
                      </strong>
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        onChangeSubtitleStyle({
                          ...subtitleStyle,
                          includeSourcePrefix: !subtitleStyle.includeSourcePrefix,
                        })
                      }
                      className="text-[#D99B26] underline underline-offset-4 hover:text-[#E5AA38]"
                    >
                      {subtitleStyle.includeSourcePrefix ? 'Kaynak Etiketini Gizle' : 'Kaynak Etiketini Göster'}
                    </button>
                  </div>
                  <textarea
                    readOnly
                    value={selectiveSrtText}
                    rows={18}
                    className="w-full rounded-md border border-white/[0.07] bg-[#0B0F17]/70 p-4 font-mono text-xs leading-relaxed text-[#CBD5E1] focus:border-[#D99B26]/50 focus:outline-none"
                  />
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Inline Quick Source Prefix & Style Hint Strip */}
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-white/[0.07] bg-[#0B0F17]/60 px-3 py-2 text-[11px] text-[#94A3B8]">
                    <span>
                      Her satırın kaynağını, zamanını ve metnini doğrudan düzeltebilirsiniz.
                    </span>
                    <div className="flex items-center gap-3">
                      <label className="flex cursor-pointer items-center gap-1.5 text-[#CBD5E1]">
                        <input
                          type="checkbox"
                          checked={subtitleStyle.includeSourcePrefix}
                          onChange={(e) =>
                            onChangeSubtitleStyle({
                              ...subtitleStyle,
                              includeSourcePrefix: e.target.checked,
                            })
                          }
                          className="accent-[#D99B26]"
                        />
                        <span>Kaynak öneki göster</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => setSelectiveViewMode('style')}
                        className="text-[#D99B26] underline underline-offset-4 hover:text-[#E5AA38]"
                      >
                        Font &amp; Stil Ayarla
                      </button>
                    </div>
                  </div>

                  {/* Editable Rows List */}
                  <div className="max-h-[460px] divide-y divide-white/[0.06] overflow-y-auto rounded-md border border-white/[0.07] bg-[#0B0F17]/60">
                    {selectiveEntries.map((entry, idx) => {
                      const startVal =
                        selectiveTimeDrafts[entry.id]?.start ?? formatMMSS(entry.startSec);
                      const endVal =
                        selectiveTimeDrafts[entry.id]?.end ?? formatMMSS(entry.endSec);
                      const isPlayingHere =
                        currentPlaySec >= entry.startSec && currentPlaySec <= entry.endSec;

                      return (
                        <div
                          key={entry.id}
                          className={`space-y-2.5 p-3.5 transition-colors ${
                            isPlayingHere ? 'bg-[#D99B26]/[0.07]' : 'hover:bg-white/[0.015]'
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs font-semibold tabular-nums text-[#D99B26]">
                                #{idx + 1}
                              </span>

                              {audioObjectUrl && (
                                <button
                                  type="button"
                                  onClick={() => handleSeekTo(entry.startSec)}
                                  title="Bu saniyeden dinle"
                                  className="flex h-6 w-6 items-center justify-center rounded border border-white/[0.1] bg-[#131924] text-[#CBD5E1] transition-colors hover:border-[#D99B26]/50 hover:text-[#D99B26]"
                                >
                                  <Play className="h-3 w-3 fill-current" />
                                </button>
                              )}

                              <div className="flex items-center gap-1 font-mono text-[11px]">
                                <input
                                  type="text"
                                  aria-label="Başlangıç zamanı"
                                  value={startVal}
                                  onChange={(e) =>
                                    setSelectiveTimeDrafts((prev) => ({
                                      ...prev,
                                      [entry.id]: { ...prev[entry.id], start: e.target.value },
                                    }))
                                  }
                                  onBlur={() => handleCommitSelectiveTime(entry.id, 'start')}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') e.currentTarget.blur();
                                  }}
                                  className="w-16 rounded border border-white/[0.1] bg-[#131924] px-1.5 py-0.5 text-center tabular-nums text-[#F1F5F9] focus:border-[#D99B26]/60 focus:outline-none"
                                />
                                <span className="text-[#64748B]">–</span>
                                <input
                                  type="text"
                                  aria-label="Bitiş zamanı"
                                  value={endVal}
                                  onChange={(e) =>
                                    setSelectiveTimeDrafts((prev) => ({
                                      ...prev,
                                      [entry.id]: { ...prev[entry.id], end: e.target.value },
                                    }))
                                  }
                                  onBlur={() => handleCommitSelectiveTime(entry.id, 'end')}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') e.currentTarget.blur();
                                  }}
                                  className="w-16 rounded border border-white/[0.1] bg-[#131924] px-1.5 py-0.5 text-center tabular-nums text-[#F1F5F9] focus:border-[#D99B26]/60 focus:outline-none"
                                />
                              </div>

                              <select
                                aria-label="Altyazı türü"
                                value={entry.kind}
                                onChange={(e) =>
                                  handleUpdateSelectiveEntry(entry.id, {
                                    kind: e.target.value as DialogueSubtitleKind,
                                  })
                                }
                                className="rounded border border-white/[0.1] bg-[#131924] px-2 py-0.5 text-[11px] text-[#CBD5E1] focus:border-[#D99B26]/60 focus:outline-none"
                              >
                                <option value="diyalog">Diyalog</option>
                                <option value="ayet">Ayet</option>
                                <option value="alinti">Alıntı</option>
                              </select>
                            </div>

                            <button
                              type="button"
                              onClick={() => handleDeleteSelectiveEntry(entry.id)}
                              title="Bu altyazı satırını sil"
                              className="rounded p-1 text-[#64748B] transition-colors hover:bg-rose-500/10 hover:text-rose-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>

                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                            <div className="sm:col-span-4">
                              <input
                                type="text"
                                value={entry.source}
                                onChange={(e) =>
                                  handleUpdateSelectiveEntry(entry.id, { source: e.target.value })
                                }
                                placeholder="Kaynak / Ayet (örn. Kral, Bakara: 15, Matta 5:9 — boş=sadece metin)"
                                className="w-full rounded border border-white/[0.1] bg-[#131924] px-2.5 py-1.5 text-xs font-medium text-[#FDE68A] placeholder-[#475569] focus:border-[#D99B26]/60 focus:outline-none"
                              />
                            </div>
                            <div className="sm:col-span-8">
                              <textarea
                                rows={2}
                                value={entry.text}
                                onChange={(e) =>
                                  handleUpdateSelectiveEntry(entry.id, { text: e.target.value })
                                }
                                placeholder="Altyazı metni..."
                                className="w-full rounded border border-white/[0.1] bg-[#131924] px-2.5 py-1.5 text-xs leading-relaxed text-[#F1F5F9] placeholder-[#475569] focus:border-[#D99B26]/60 focus:outline-none"
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Bottom 1-Click Handoff to Step 1 Documentary Editor */}
          {(segments.length > 0 || scenePlan.length > 0 || selectiveEntries.length > 0) && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-4 text-xs text-[#64748B]">
              <span>
                {selectiveEntries.length > 0
                  ? `Hazırlanan ${selectiveEntries.length} satırlık seçme altyazı ve stil ayarları doğrudan Kurgu & Render paketine aktarılır.`
                  : scenePlan.length > 0
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
                    scenePlan.length > 0 ? `${baseName}_sahne_plani_ve_promptlar.txt` : undefined,
                    selectiveEntries.length > 0 ? selectiveEntries : undefined
                  )
                }
                className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[#D99B26]/40 bg-[#D99B26]/10 px-3 py-1.5 font-medium text-[#F1F5F9] transition-colors hover:bg-[#D99B26]/20 disabled:opacity-50"
              >
                <span>
                  {scenePlan.length > 0 && selectiveEntries.length > 0
                    ? "Plan + Seçme Altyazıyı Adım 1'e Aktar"
                    : selectiveEntries.length > 0
                      ? "Seçme Altyazıyı Adım 1'e Aktar"
                      : scenePlan.length > 0
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
