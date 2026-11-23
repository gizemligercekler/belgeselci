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
} from 'lucide-react';
import { EditorSettings, TranscriptSegment } from '../types/editor';
import { readAudioDuration, segmentsToSrt } from '../utils/mediaUtils';
import { formatMMSS } from '../utils/timelineMath';
import { downloadTextFile } from '../utils/exportBundle';
import {
  RetryNotice,
  TranscribeProgress,
  transcribeAudioInChunks,
} from '../services/editorApi';

interface StandaloneTranscriberProps {
  settings: EditorSettings;
  hasDeepgramKey: boolean;
  onOpenSettings: () => void;
  onUseTranscriptInEditor: (segments: TranscriptSegment[], sourceName: string, audioFile: File | null, durationSec: number) => void;
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').trim() || 'transkript';
}

export const StandaloneTranscriber: React.FC<StandaloneTranscriberProps> = ({
  settings,
  hasDeepgramKey,
  onOpenSettings,
  onUseTranscriptInEditor,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioElRef = useRef<HTMLAudioElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioObjectUrl, setAudioObjectUrl] = useState<string | null>(null);
  const [audioDuration, setAudioDuration] = useState<number>(0);
  const [dragOver, setDragOver] = useState(false);

  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<TranscribeProgress | null>(null);
  const [retryNotice, setRetryNotice] = useState<RetryNotice | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [viewMode, setViewMode] = useState<'timed' | 'plain'>('timed');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedType, setCopiedType] = useState<'text' | 'srt' | null>(null);
  const [currentPlaySec, setCurrentPlaySec] = useState<number>(-1);

  const audioUrlRef = useRef<string | null>(null);
  audioUrlRef.current = audioObjectUrl;

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  const handleSelectFile = async (file: File) => {
    setErrorMessage(null);
    try {
      const { durationSec, objectUrl } = await readAudioDuration(file);
      if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
      setAudioFile(file);
      setAudioObjectUrl(objectUrl);
      setAudioDuration(durationSec);
      setSegments([]);
      setSearchQuery('');
      setCurrentPlaySec(-1);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Ses dosyası okunamadı.');
    }
  };

  const handleClearFile = () => {
    abortRef.current?.abort();
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    setAudioFile(null);
    setAudioObjectUrl(null);
    setAudioDuration(0);
    setSegments([]);
    setSearchQuery('');
    setErrorMessage(null);
    setCurrentPlaySec(-1);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (isProcessing) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void handleSelectFile(file);
  };

  const handleStartTranscribe = async () => {
    if (!audioFile) {
      setErrorMessage('Lütfen önce bir ses dosyası (.mp3, .wav, .m4a) seçin.');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setIsProcessing(true);
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
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        setErrorMessage('Transkript işlemi iptal edildi.');
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Transkript çıkarılırken beklenmeyen bir hata oluştu.'
        );
      }
    } finally {
      setIsProcessing(false);
      setProgress(null);
      setRetryNotice(null);
      abortRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleSeekTo = (sec: number) => {
    const el = audioElRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, sec);
    void el.play().catch(() => undefined);
  };

  const plainText = useMemo(() => {
    if (segments.length === 0) return '';
    // Group every ~4 sentences into a clean readable paragraph
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

  const handleCopy = async (kind: 'text' | 'srt') => {
    const payload = kind === 'srt' ? segmentsToSrt(segments) : plainText;
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(payload);
      setCopiedType(kind);
      window.setTimeout(() => setCopiedType(null), 2000);
    } catch {
      setErrorMessage('Panoya kopyalanamadı; dosya olarak indirebilirsiniz.');
    }
  };

  const handleDownloadSrt = () => {
    if (segments.length === 0) return;
    const base = stripExtension(audioFile?.name || 'transkript');
    downloadTextFile(`${base}.srt`, segmentsToSrt(segments), 'application/x-subrip;charset=utf-8');
  };

  const handleDownloadTxt = () => {
    if (!plainText) return;
    const base = stripExtension(audioFile?.name || 'transkript');
    downloadTextFile(`${base}.txt`, plainText, 'text/plain;charset=utf-8');
  };

  const progressPercent =
    progress && progress.phase === 'transcribing' && progress.totalChunks > 0
      ? Math.round(((progress.currentChunk - 0.5) / progress.totalChunks) * 92)
      : progress?.phase === 'decoding'
        ? 10
        : 0;

  const deepgramModel = settings.deepgramModel === 'nova-2' ? 'nova-2' : 'nova-3';
  const hasAnyDeepgramKey = Boolean(settings.deepgramApiKey.trim() || hasDeepgramKey);

  return (
    <div className="mx-auto max-w-[1160px] space-y-6 px-4 py-8 sm:px-6">
      {/* Calm Header */}
      <div className="flex flex-col justify-between gap-4 border-b border-white/[0.07] pb-6 sm:flex-row sm:items-end">
        <div className="space-y-1.5">
          <p className="font-mono text-xs tracking-wider text-[#D99B26]">
            Bağımsız Araç
          </p>
          <h1 className="font-display text-2xl font-medium tracking-tight text-[#F1F5F9] sm:text-3xl">
            Ses → Transkript Dönüştürücü
          </h1>
          <p className="max-w-2xl text-sm text-[#94A3B8]">
            Görsel yüklemeden yalnızca ses dosyasından zaman damgalı Türkçe transkript çıkarın,
            dinleyerek kontrol edin ve <span className="font-mono text-[#CBD5E1]">.SRT</span> veya{' '}
            <span className="font-mono text-[#CBD5E1]">.TXT</span> olarak indirin.
          </p>
        </div>

        <div className="flex items-center gap-3 text-xs text-[#94A3B8]">
          <span>
            Model: <span className="font-mono text-[#E2E8F0]">Deepgram {deepgramModel}</span>
          </span>
          <span aria-hidden="true" className="text-white/20">·</span>
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex items-center gap-1 text-[#CBD5E1] underline decoration-white/20 underline-offset-4 transition-colors hover:text-[#D99B26]"
          >
            <Settings className="h-3.5 w-3.5" />
            <span>Ayarlar</span>
          </button>
        </div>
      </div>

      {/* Main 2-Column Workspace */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
        {/* Left: Audio Upload, Player & Action */}
        <section className="space-y-5 rounded-lg border border-white/[0.08] bg-[#131924] p-6 lg:col-span-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-[#F1F5F9]">
              <FileAudio className="h-4 w-4 text-[#D99B26]" />
              <span>Ses Dosyası</span>
            </div>
            <span className="font-mono text-[11px] text-[#64748B]">MP3 · WAV · M4A · FLAC</span>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,audio/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleSelectFile(file);
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
            onClick={() => !isProcessing && fileInputRef.current?.click()}
            className={`group flex min-h-[176px] cursor-pointer flex-col items-center justify-center rounded-md border border-dashed p-6 text-center transition-colors ${
              dragOver
                ? 'border-[#D99B26] bg-[#D99B26]/[0.06]'
                : audioFile
                  ? 'border-white/[0.14] bg-[#0B0F17]/70 hover:border-white/[0.24]'
                  : 'border-white/[0.12] bg-[#0B0F17]/50 hover:border-[#D99B26]/50 hover:bg-[#0B0F17]'
            }`}
          >
            {audioFile ? (
              <div className="w-full space-y-3">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md border border-[#D99B26]/30 bg-[#D99B26]/10 text-[#D99B26]">
                  <FileAudio className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <p className="truncate px-2 text-sm font-medium text-[#F1F5F9]" title={audioFile.name}>
                    {audioFile.name}
                  </p>
                  <p className="font-mono text-xs tabular-nums text-[#D99B26]">
                    Süre: {formatMMSS(audioDuration)} · {(audioFile.size / (1024 * 1024)).toFixed(1)} MB
                  </p>
                </div>
                {!isProcessing && (
                  <div className="flex items-center justify-center gap-3 pt-1">
                    <span className="text-xs text-[#94A3B8] underline decoration-white/20 underline-offset-4 group-hover:text-[#F1F5F9]">
                      Dosyayı Değiştir
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleClearFile();
                      }}
                      className="text-xs text-[#64748B] hover:text-rose-400"
                    >
                      Kaldır
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md border border-white/[0.08] bg-[#1A2230] text-[#94A3B8] group-hover:text-[#D99B26]">
                  <Upload className="h-4 w-4" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-[#E2E8F0]">
                    Ses dosyasını buraya bırakın veya seçin
                  </p>
                  <p className="text-xs text-[#64748B]">
                    Uzun kayıtlar otomatik olarak 5 dakikalık 16kHz WAV parçalarına bölünür
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Built-in Audio Player for timestamp verification */}
          {audioObjectUrl && (
            <div className="space-y-1.5">
              <audio
                ref={audioElRef}
                src={audioObjectUrl}
                controls
                onTimeUpdate={(e) => setCurrentPlaySec(e.currentTarget.currentTime)}
                className="h-10 w-full rounded-md"
              />
              {segments.length > 0 && (
                <p className="text-[11px] text-[#64748B]">
                  Sağdaki herhangi bir zaman damgasına tıklayarak kaydı doğrudan o saniyeden dinleyebilirsiniz.
                </p>
              )}
            </div>
          )}

          {/* Missing API Key Hint */}
          {!hasAnyDeepgramKey && !isProcessing && (
            <div className="flex items-start justify-between gap-3 rounded-md border border-[#D99B26]/25 bg-[#D99B26]/[0.06] px-3.5 py-2.5 text-xs text-[#CBD5E1]">
              <p className="leading-relaxed">
                Transkript için Ayarlar&apos;dan Deepgram API anahtarınızı (<span className="font-mono">console.deepgram.com</span>) girin.
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

          {/* Error Banner */}
          {errorMessage && (
            <div className="flex items-start gap-2.5 rounded-md border border-rose-500/30 bg-rose-950/30 px-3.5 py-2.5 text-xs text-rose-200">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              <p className="leading-relaxed">{errorMessage}</p>
            </div>
          )}

          {/* Progress or Primary Action */}
          {isProcessing ? (
            <div className="space-y-3 border-t border-white/[0.06] pt-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#D99B26]" />
                  <span className="truncate text-xs font-medium text-[#F1F5F9]">
                    {progress?.message || 'Hazırlanıyor...'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="shrink-0 rounded-md border border-white/[0.1] px-2.5 py-1 text-xs font-medium text-[#94A3B8] transition-colors hover:border-rose-400/40 hover:text-rose-300"
                >
                  İptal Et
                </button>
              </div>

              {retryNotice !== null && (
                <p className="font-mono text-xs tabular-nums text-[#D99B26]">
                  {retryNotice.reason} — {retryNotice.secondsLeft} sn sonra otomatik yeniden denenecek...
                </p>
              )}

              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#0B0F17]">
                <div
                  className="h-full bg-[#D99B26] transition-all duration-300"
                  style={{ width: `${Math.max(6, progressPercent)}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="border-t border-white/[0.06] pt-4">
              <button
                type="button"
                onClick={handleStartTranscribe}
                className={`flex w-full items-center justify-center gap-2 rounded-md px-5 py-2.5 text-sm font-semibold transition-colors ${
                  audioFile
                    ? 'cursor-pointer bg-[#D99B26] text-[#0B0F17] hover:bg-[#E5AA38]'
                    : 'cursor-pointer border border-white/[0.12] bg-[#1E293B] text-[#CBD5E1] hover:border-[#D99B26]/40 hover:text-[#F1F5F9]'
                }`}
              >
                <FileText className="h-4 w-4" />
                <span>{segments.length > 0 ? 'Yeniden Transkript Çıkar' : 'Transkript Çıkar'}</span>
              </button>
            </div>
          )}
        </section>

        {/* Right: Transcript Viewer & Export */}
        <section className="flex flex-col rounded-lg border border-white/[0.08] bg-[#131924] p-6 lg:col-span-7">
          {segments.length === 0 ? (
            <div className="flex min-h-[380px] flex-col items-center justify-center text-center">
              <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-md border border-white/[0.08] bg-[#0B0F17] text-[#64748B]">
                <FileText className="h-5 w-5" />
              </div>
              <h2 className="text-sm font-medium text-[#E2E8F0]">
                Transkript burada görünecek
              </h2>
              <p className="mt-1.5 max-w-md text-xs leading-relaxed text-[#64748B]">
                Sol taraftan bir ses dosyası yükleyip <span className="text-[#CBD5E1]">Transkript Çıkar</span>{' '}
                düğmesine bastığınızda noktalama işaretli ve cümle sonlarından bölünmüş Türkçe metin burada
                oluşturulur. Mevcut kurgu zaman çizelgenizi etkilemez.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Top Meta & Export Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] pb-4">
                <div className="space-y-0.5">
                  <h2 className="text-sm font-medium text-[#F1F5F9]">Çıkarılan Transkript</h2>
                  <p className="font-mono text-xs tabular-nums text-[#64748B]">
                    {segments.length} satır · {wordCount} kelime · {formatMMSS(audioDuration)}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleCopy(viewMode === 'plain' ? 'text' : 'srt')}
                    className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-white/[0.1] bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-[#CBD5E1] transition-colors hover:border-white/[0.2] hover:text-[#F1F5F9]"
                  >
                    {copiedType ? (
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
                    onClick={handleDownloadTxt}
                    className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-white/[0.1] bg-[#0B0F17] px-3 py-1.5 text-xs font-medium text-[#CBD5E1] transition-colors hover:border-white/[0.2] hover:text-[#F1F5F9]"
                  >
                    <Download className="h-3.5 w-3.5 text-[#94A3B8]" />
                    <span>.TXT İndir</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleDownloadSrt}
                    className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-[#D99B26] px-3.5 py-1.5 text-xs font-semibold text-[#0B0F17] transition-colors hover:bg-[#E5AA38]"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>.SRT İndir</span>
                  </button>
                </div>
              </div>

              {/* View Switcher + Search */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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

                {viewMode === 'timed' && (
                  <div className="relative flex-1 sm:max-w-xs">
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
              </div>

              {/* Transcript Content */}
              {viewMode === 'timed' ? (
                <div className="max-h-[460px] divide-y divide-white/[0.05] overflow-y-auto rounded-md border border-white/[0.07] bg-[#0B0F17]/60">
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

              {/* Optional 1-click handoff to Documentary Editor */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-3 text-xs text-[#64748B]">
                <span>Bu transkripti isterseniz doğrudan belgesel kurgusuna aktarabilirsiniz.</span>
                <button
                  type="button"
                  onClick={() =>
                    onUseTranscriptInEditor(
                      segments,
                      `${stripExtension(audioFile?.name || 'transkript')}.srt`,
                      audioFile,
                      audioDuration
                    )
                  }
                  className="flex items-center gap-1.5 whitespace-nowrap font-medium text-[#CBD5E1] transition-colors hover:text-[#D99B26]"
                >
                  <span>Kurgu Adım 1&apos;e Aktar</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
