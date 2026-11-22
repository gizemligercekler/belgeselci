import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ZoomIn,
  ZoomOut,
  FileText,
  Download,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Lock,
  Upload,
  Image as ImageIcon,
} from 'lucide-react';
import {
  FIXED_DISSOLVE_SEC,
  TimelineScene,
  TranscriptSegment,
  UploadedImage,
  ZOOM_SPEED_PRESETS,
} from '../types/editor';
import {
  formatMMSS,
  formatPct,
  formatZoomSpeedPct,
} from '../utils/timelineMath';
import { segmentsToSrt } from '../utils/mediaUtils';
import { downloadTextFile } from '../utils/exportBundle';

interface Step2TimelineProps {
  audioFileName: string;
  audioObjectUrl: string | null;
  totalAudioDuration: number;
  zoomSpeedPerSec: number;
  transcriptSegments: TranscriptSegment[];
  scenes: TimelineScene[];
  images: UploadedImage[];
  onChangeZoomSpeed: (nextSpeed: number) => void;
  onAdjustSceneDuration: (sceneIndex: number, newDurationSec: number) => void;
  onToggleZoomDirection: (sceneIndex: number) => void;
  onReattachAudio: (file: File) => void;
  onReattachImages: (files: File[]) => void;
  onProceedToExport: () => void;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function findSceneIndexAtTime(scenes: TimelineScene[], t: number): number {
  if (scenes.length === 0) return -1;
  for (let i = 0; i < scenes.length; i++) {
    if (t < scenes[i].endSec || i === scenes.length - 1) {
      return i;
    }
  }
  return scenes.length - 1;
}

function evalScaleAtTime(scene: TimelineScene, t: number): number {
  const elapsed = Math.max(0, t - scene.startSec);
  const denom = Math.max(0.1, scene.renderDurationSec);
  const ratio = clamp(elapsed / denom, 0, 1);
  return scene.startScale + (scene.endScale - scene.startScale) * ratio;
}

export const Step2Timeline: React.FC<Step2TimelineProps> = ({
  audioFileName,
  audioObjectUrl,
  totalAudioDuration,
  zoomSpeedPerSec,
  transcriptSegments,
  scenes,
  images,
  onChangeZoomSpeed,
  onAdjustSceneDuration,
  onToggleZoomDirection,
  onReattachAudio,
  onReattachImages,
  onProceedToExport,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameTsRef = useRef<number | null>(null);
  const reattachAudioInputRef = useRef<HTMLInputElement>(null);
  const reattachImagesInputRef = useRef<HTMLInputElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [showTranscript, setShowTranscript] = useState(false);
  const [editingDraft, setEditingDraft] = useState<Record<string, string>>({});

  // Map filename -> objectUrl for instant preview lookup
  const imageUrlByFilename = useMemo(() => {
    const map = new Map<string, string>();
    for (const img of images) {
      if (img.objectUrl) {
        map.set(img.filename, img.objectUrl);
      }
    }
    return map;
  }, [images]);

  const missingImagesCount = useMemo(
    () => scenes.filter((sc) => !imageUrlByFilename.has(sc.filename)).length,
    [scenes, imageUrlByFilename]
  );

  // Sync playhead via requestAnimationFrame when playing
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameTsRef.current = null;
      return;
    }

    const tick = (now: number) => {
      const audioEl = audioRef.current;
      if (audioEl && audioObjectUrl) {
        const current = audioEl.currentTime;
        setPlayheadSec(current);
        if (audioEl.ended || current >= totalAudioDuration) {
          setIsPlaying(false);
          setPlayheadSec(totalAudioDuration);
          return;
        }
      } else {
        // Fallback visual clock if audio file was not re-attached after page reload
        if (lastFrameTsRef.current !== null) {
          const dt = (now - lastFrameTsRef.current) / 1000;
          setPlayheadSec((prev) => {
            const next = prev + dt;
            if (next >= totalAudioDuration) {
              setIsPlaying(false);
              return totalAudioDuration;
            }
            return next;
          });
        }
        lastFrameTsRef.current = now;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isPlaying, audioObjectUrl, totalAudioDuration]);

  // Pause audio on unmount
  useEffect(() => {
    const el = audioRef.current;
    return () => {
      el?.pause();
    };
  }, []);

  const seekTo = (sec: number, autoPlay?: boolean) => {
    const clamped = clamp(sec, 0, Math.max(0, totalAudioDuration - 0.05));
    setPlayheadSec(clamped);
    const el = audioRef.current;
    if (el && audioObjectUrl) {
      el.currentTime = clamped;
      if (autoPlay) {
        el.play()
          .then(() => setIsPlaying(true))
          .catch(() => setIsPlaying(false));
      }
    } else if (autoPlay) {
      setIsPlaying(true);
    }
  };

  const togglePlayPause = () => {
    const el = audioRef.current;
    if (isPlaying) {
      el?.pause();
      setIsPlaying(false);
      return;
    }

    const startPos = playheadSec >= totalAudioDuration - 0.15 ? 0 : playheadSec;
    if (el && audioObjectUrl) {
      el.currentTime = startPos;
      el.play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    } else {
      setPlayheadSec(startPos);
      setIsPlaying(true);
    }
  };

  // Compute active scene & optional 1.0-second dissolve transition layer (1:1 with render.py)
  const activeIdx = findSceneIndexAtTime(scenes, playheadSec);
  const activeScene = activeIdx >= 0 ? scenes[activeIdx] : null;
  const prevScene = activeIdx > 0 ? scenes[activeIdx - 1] : null;

  const isInDissolve =
    Boolean(activeScene && prevScene) &&
    playheadSec >= (activeScene?.startSec ?? 0) &&
    playheadSec < (activeScene?.startSec ?? 0) + FIXED_DISSOLVE_SEC;

  const dissolveProgress =
    isInDissolve && activeScene
      ? clamp((playheadSec - activeScene.startSec) / FIXED_DISSOLVE_SEC, 0, 1)
      : 1;

  const activeScale = activeScene ? evalScaleAtTime(activeScene, playheadSec) : 1.0;
  const prevScale =
    isInDissolve && prevScene ? evalScaleAtTime(prevScene, playheadSec) : 1.0;

  const activeImgUrl = activeScene ? imageUrlByFilename.get(activeScene.filename) : undefined;
  const prevImgUrl = prevScene ? imageUrlByFilename.get(prevScene.filename) : undefined;

  const handleStepScene = (delta: number) => {
    if (scenes.length === 0) return;
    const nextIdx = clamp((activeIdx < 0 ? 0 : activeIdx) + delta, 0, scenes.length - 1);
    seekTo(scenes[nextIdx].startSec, isPlaying);
  };

  const handleDownloadSrt = () => {
    if (transcriptSegments.length === 0) return;
    const base = audioFileName.replace(/\.[^.]+$/, '') || 'belgesel';
    downloadTextFile(`${base}.srt`, segmentsToSrt(transcriptSegments), 'application/x-subrip;charset=utf-8');
  };

  const commitDurationDraft = (sceneIndex: number, sceneId: string, fallbackDur: number) => {
    const raw = editingDraft[sceneId];
    setEditingDraft((prev) => {
      const next = { ...prev };
      delete next[sceneId];
      return next;
    });
    if (raw === undefined) return;
    const parsed = Number(raw.replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    if (Math.abs(parsed - fallbackDur) < 0.01) return;
    onAdjustSceneDuration(sceneIndex, parsed);
  };

  return (
    <div className="mx-auto max-w-[1280px] space-y-6 px-4 py-6 sm:px-6">
      {/* Hidden native audio element — never modifies or re-encodes the user's audio */}
      {audioObjectUrl && (
        <audio
          ref={audioRef}
          src={audioObjectUrl}
          preload="auto"
          onEnded={() => setIsPlaying(false)}
          className="hidden"
        />
      )}

      {/* TOP MINIMAL CONTROL BAR */}
      <section className="rounded-lg border border-white/[0.08] bg-[#131924] p-4 sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          {/* 1. Global Constant Zoom Speed Slider + 5 Presets */}
          <div className="flex flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className="text-xs font-medium text-[#CBD5E1]">
                  Genel Zoom Hızı
                </span>
                <span className="font-mono text-sm font-semibold tabular-nums text-[#D99B26]">
                  {formatZoomSpeedPct(zoomSpeedPerSec)}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {ZOOM_SPEED_PRESETS.map((preset) => {
                  const selected = Math.abs(zoomSpeedPerSec - preset.speedPerSec) < 0.0001;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => onChangeZoomSpeed(preset.speedPerSec)}
                      className={`rounded border px-2 py-1 text-[11px] transition-colors ${
                        selected
                          ? 'border-[#D99B26]/60 bg-[#D99B26]/15 font-medium text-[#F1F5F9]'
                          : 'border-white/[0.07] bg-[#0B0F17] text-[#94A3B8] hover:border-white/[0.18] hover:text-[#F1F5F9]'
                      }`}
                    >
                      <span>{preset.label}</span>{' '}
                      <span className="font-mono tabular-nums text-[#64748B]">
                        {preset.pctLabel}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <span className="font-mono text-[11px] tabular-nums text-[#64748B]">%0.10</span>
              <input
                type="range"
                aria-label="Genel Zoom Hızı (%/sn)"
                min={0.001}
                max={0.01}
                step={0.0005}
                value={zoomSpeedPerSec}
                onChange={(e) => onChangeZoomSpeed(Number(e.target.value))}
                className="studio-slider flex-1"
              />
              <span className="font-mono text-[11px] tabular-nums text-[#64748B]">%1.00</span>
            </div>
          </div>

          {/* Divider */}
          <div className="hidden h-12 w-px bg-white/[0.08] xl:block" />

          {/* 2. Fixed 1.0s Dissolve + Total Duration & Image Count + Transcript Toggle + Export */}
          <div className="flex flex-wrap items-center justify-between gap-4 xl:justify-end">
            <div className="flex items-center gap-5 border-t border-white/[0.06] pt-3 xl:border-t-0 xl:pt-0">
              <div>
                <p className="text-[11px] text-[#64748B]">Geçiş</p>
                <p className="font-mono text-xs font-medium tabular-nums text-[#E2E8F0]">
                  1.0 sn Dissolve
                </p>
              </div>
              <div className="h-6 w-px bg-white/[0.08]" />
              <div>
                <p className="text-[11px] text-[#64748B]">Toplam Süre</p>
                <p className="font-mono text-xs font-medium tabular-nums text-[#E2E8F0]">
                  {formatMMSS(totalAudioDuration)}
                </p>
              </div>
              <div className="h-6 w-px bg-white/[0.08]" />
              <div>
                <p className="text-[11px] text-[#64748B]">Görsel</p>
                <p className="font-mono text-xs font-medium tabular-nums text-[#E2E8F0]">
                  {scenes.length} adet
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {transcriptSegments.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowTranscript((v) => !v)}
                  className={`flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                    showTranscript
                      ? 'border-[#D99B26]/40 bg-[#D99B26]/10 text-[#F1F5F9]'
                      : 'border-white/[0.08] bg-[#0B0F17] text-[#94A3B8] hover:border-white/[0.18] hover:text-[#F1F5F9]'
                  }`}
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>Transkript</span>
                  {showTranscript ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </button>
              )}

              <button
                type="button"
                onClick={onProceedToExport}
                className="flex items-center gap-1.5 rounded-md bg-[#D99B26] px-4 py-2 text-xs font-semibold text-[#0B0F17] transition-colors hover:bg-[#E5AA38]"
              >
                <span>Dışa Aktar</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Collapsible Transcript & .SRT Drawer */}
        {showTranscript && transcriptSegments.length > 0 && (
          <div className="mt-4 border-t border-white/[0.07] pt-4">
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-[#CBD5E1]">
                Zaman Damgalı Türkçe Transkript ({transcriptSegments.length} satır · Tıklayarak o ana gidin)
              </span>
              <button
                type="button"
                onClick={handleDownloadSrt}
                className="flex items-center gap-1.5 rounded border border-white/[0.1] bg-[#0B0F17] px-2.5 py-1 text-xs text-[#CBD5E1] transition-colors hover:border-[#D99B26]/50 hover:text-[#F1F5F9]"
              >
                <Download className="h-3.5 w-3.5 text-[#D99B26]" />
                <span>.SRT İndir</span>
              </button>
            </div>
            <div className="max-h-56 divide-y divide-white/[0.04] overflow-y-auto rounded-md border border-white/[0.07] bg-[#0B0F17]">
              {transcriptSegments.map((seg, idx) => (
                <button
                  key={`${seg.startSec}_${idx}`}
                  type="button"
                  onClick={() => seekTo(seg.startSec, true)}
                  className="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-white/[0.03]"
                >
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-[#D99B26]">
                    [{formatMMSS(seg.startSec)} – {formatMMSS(seg.endSec)}]
                  </span>
                  <span className="text-xs leading-relaxed text-[#CBD5E1]">{seg.text}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Gentle Local Blob Reattach Strip (only after browser reload) */}
      {(!audioObjectUrl || missingImagesCount > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#D99B26]/25 bg-[#131924] px-4 py-3 text-xs text-[#CBD5E1]">
          <p>
            Zaman çizelgeniz tarayıcıdan geri yüklendi. Canlı 16:9 önizleme için yerel medya dosyalarını tekrar bağlayabilirsiniz:
          </p>
          <div className="flex items-center gap-2">
            <input
              ref={reattachAudioInputRef}
              type="file"
              accept=".mp3,.wav,.m4a,.aac,.flac,audio/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onReattachAudio(file);
                e.target.value = '';
              }}
            />
            <input
              ref={reattachImagesInputRef}
              type="file"
              multiple
              accept="image/*,.png,.jpg,.jpeg,.webp"
              className="hidden"
              onChange={(e) => {
                const list = Array.from(e.target.files || []);
                if (list.length > 0) onReattachImages(list);
                e.target.value = '';
              }}
            />

            {!audioObjectUrl && (
              <button
                type="button"
                onClick={() => reattachAudioInputRef.current?.click()}
                className="flex items-center gap-1.5 rounded border border-white/[0.12] bg-[#0B0F17] px-2.5 py-1.5 text-xs text-[#F1F5F9] hover:border-[#D99B26]/50"
              >
                <Upload className="h-3.5 w-3.5 text-[#D99B26]" />
                <span>Sesi Bağla ({audioFileName})</span>
              </button>
            )}
            {missingImagesCount > 0 && (
              <button
                type="button"
                onClick={() => reattachImagesInputRef.current?.click()}
                className="flex items-center gap-1.5 rounded border border-white/[0.12] bg-[#0B0F17] px-2.5 py-1.5 text-xs text-[#F1F5F9] hover:border-[#D99B26]/50"
              >
                <ImageIcon className="h-3.5 w-3.5 text-[#D99B26]" />
                <span>Görselleri Bağla ({missingImagesCount} eksik)</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* LIVE 16:9 PREVIEW PLAYER */}
      <section className="overflow-hidden rounded-lg border border-white/[0.08] bg-[#131924]">
        <div className="mx-auto max-w-[920px] p-4 pb-3 sm:p-5 sm:pb-4">
          {/* 16:9 Stage */}
          <div className="relative aspect-video w-full overflow-hidden rounded-md border border-white/[0.08] bg-[#05070B]">
            {/* Previous Clip (underneath during exact 1.0s dissolve overlap, still smoothly zooming) */}
            {isInDissolve && prevScene && prevImgUrl && (
              <img
                src={prevImgUrl}
                alt={prevScene.cleanTitle}
                className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover will-change-transform"
                style={{
                  transform: `scale(${prevScale.toFixed(5)})`,
                  opacity: 1,
                }}
              />
            )}

            {/* Active Clip (fades in 0 -> 1 over the first 1.0s dissolve overlap while zooming linearly) */}
            {activeScene && activeImgUrl ? (
              <img
                src={activeImgUrl}
                alt={activeScene.cleanTitle}
                className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover will-change-transform"
                style={{
                  transform: `scale(${activeScale.toFixed(5)})`,
                  opacity: isInDissolve ? dissolveProgress : 1,
                }}
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-[#64748B]">
                <ImageIcon className="h-8 w-8 opacity-40" />
                <p className="text-xs">
                  {activeScene
                    ? `${activeScene.filename} önizleme için yerel görsel bekleniyor`
                    : 'Önizlenecek görsel yok'}
                </p>
              </div>
            )}

            {/* Subtle Bottom Overlay Bar on Stage */}
            {activeScene && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent px-4 pb-3 pt-10">
                <div className="flex items-end justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-[#F1F5F9]">
                      <span className="text-[#D99B26]">#{activeScene.orderNumber}</span>{' '}
                      <span>{activeScene.filename}</span>
                    </p>
                    <p className="mt-0.5 truncate text-xs text-[#CBD5E1]/90">
                      {activeScene.matchedExcerpt}
                    </p>
                  </div>
                  <div className="shrink-0 text-right font-mono text-[11px] tabular-nums text-[#CBD5E1]">
                    <span>
                      {activeScene.zoomDirection === 'uzaklas' ? 'Uzaklaş' : 'Yakınlaş'} ·{' '}
                      {formatPct(activeScale)}
                    </span>
                    {isInDissolve && (
                      <span className="ml-2 text-[#D99B26]">· 1.0s Dissolve</span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Transport & Scrub Bar */}
          <div className="mt-3.5 flex flex-col gap-2.5">
            <div className="flex items-center gap-3">
              <span className="w-12 shrink-0 font-mono text-xs tabular-nums text-[#F1F5F9]">
                {formatMMSS(playheadSec)}
              </span>
              <input
                type="range"
                aria-label="Oynatma konumu"
                min={0}
                max={Math.max(1, totalAudioDuration)}
                step={0.1}
                value={Math.min(playheadSec, totalAudioDuration)}
                onChange={(e) => seekTo(Number(e.target.value))}
                className="studio-slider flex-1"
              />
              <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-[#64748B]">
                {formatMMSS(totalAudioDuration)}
              </span>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleStepScene(-1)}
                  title="Önceki görsel"
                  className="rounded-md border border-white/[0.08] bg-[#0B0F17] p-2 text-[#CBD5E1] transition-colors hover:border-white/[0.18] hover:text-[#F1F5F9]"
                >
                  <SkipBack className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={togglePlayPause}
                  className="flex items-center gap-2 rounded-md bg-[#D99B26] px-4 py-2 text-xs font-semibold text-[#0B0F17] transition-colors hover:bg-[#E5AA38]"
                >
                  {isPlaying ? (
                    <>
                      <Pause className="h-3.5 w-3.5 fill-current" />
                      <span>Duraklat</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5 fill-current" />
                      <span>Oynat</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => handleStepScene(1)}
                  title="Sonraki görsel"
                  className="rounded-md border border-white/[0.08] bg-[#0B0F17] p-2 text-[#CBD5E1] transition-colors hover:border-white/[0.18] hover:text-[#F1F5F9]"
                >
                  <SkipForward className="h-3.5 w-3.5" />
                </button>
              </div>

              <p className="hidden truncate font-mono text-[11px] text-[#64748B] sm:block">
                {audioFileName}
                {!audioObjectUrl ? ' (Sessiz önizleme — sesi tekrar bağlayın)' : ''}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* IMAGE TIMELINE LIST */}
      <section className="overflow-hidden rounded-lg border border-white/[0.08] bg-[#131924]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] px-5 py-3.5">
          <div>
            <h2 className="text-sm font-medium text-[#F1F5F9]">
              Görsel Zaman Çizelgesi
            </h2>
            <p className="text-xs text-[#64748B]">
              Bir görselin süresini değiştirdiğinizde yalnızca hemen arkasındaki görselin başlangıcı güncellenir; sonraki tüm görseller sabit kalır.
            </p>
          </div>
          <span className="font-mono text-[11px] tabular-nums text-[#94A3B8]">
            Sıralı · Boşluksuz · Çakışmasız
          </span>
        </div>

        <div className="divide-y divide-white/[0.06]">
          {scenes.map((scene, idx) => {
            const isLast = idx === scenes.length - 1;
            const isActive = idx === activeIdx;
            const thumbUrl = imageUrlByFilename.get(scene.filename);
            const dirLabel = scene.zoomDirection === 'uzaklas' ? 'Uzaklaş' : 'Yakınlaş';
            const draftVal =
              editingDraft[scene.id] !== undefined
                ? editingDraft[scene.id]
                : String(Math.round(scene.durationSec * 10) / 10);

            return (
              <div
                key={scene.id}
                onClick={() => seekTo(scene.startSec)}
                className={`group flex flex-col gap-3 px-4 py-3.5 transition-colors lg:flex-row lg:items-center lg:gap-4 sm:px-5 ${
                  isActive ? 'bg-[#1A2230]/80' : 'hover:bg-white/[0.02]'
                }`}
              >
                {/* Left: Play Jump + Thumbnail + Order & Filename + Excerpt */}
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      seekTo(scene.startSec, true);
                    }}
                    title="Bu görselden oynat"
                    className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors ${
                      isActive
                        ? 'border-[#D99B26]/50 bg-[#D99B26]/15 text-[#D99B26]'
                        : 'border-white/[0.08] bg-[#0B0F17] text-[#94A3B8] hover:border-[#D99B26]/40 hover:text-[#D99B26]'
                    }`}
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                  </button>

                  {thumbUrl ? (
                    <img
                      src={thumbUrl}
                      alt={scene.cleanTitle}
                      className="h-12 w-20 shrink-0 rounded-sm border border-white/[0.08] object-cover"
                    />
                  ) : (
                    <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-sm border border-white/[0.08] bg-[#0B0F17] font-mono text-xs text-[#475569]">
                      #{scene.orderNumber}
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-mono text-xs font-semibold tabular-nums text-[#D99B26]">
                        #{scene.orderNumber}
                      </span>
                      <span
                        className="truncate text-sm font-medium text-[#F1F5F9]"
                        title={scene.filename}
                      >
                        {scene.filename}
                      </span>
                      <span className="font-mono text-xs tabular-nums text-[#94A3B8]">
                        {formatMMSS(scene.startSec)} — {formatMMSS(scene.endSec)}
                      </span>
                    </div>

                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[#94A3B8]">
                      “{scene.matchedExcerpt}”
                    </p>

                    {/* Read-only live computed zoom readout */}
                    <p className="mt-1.5 font-mono text-[11px] tabular-nums text-[#64748B]">
                      {dirLabel} · {formatPct(scene.startScale)} → {formatPct(scene.endScale)}{' '}
                      ({Math.round(scene.durationSec)} sn · {formatZoomSpeedPct(zoomSpeedPerSec)})
                    </p>
                  </div>
                </div>

                {/* Right: Duration Editor (Adjacent-Only) + Zoom Direction Toggle */}
                <div
                  className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.05] pt-2.5 lg:justify-end lg:border-t-0 lg:pt-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Editable Duration Control */}
                  {isLast ? (
                    <div
                      title="Son görselin bitişi orijinal ses dosyasının sonuna kilitlidir."
                      className="flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-[#0B0F17]/70 px-3 py-1.5 font-mono text-xs tabular-nums text-[#64748B]"
                    >
                      <Lock className="h-3 w-3" />
                      <span>{scene.durationSec.toFixed(1)} sn</span>
                      <span className="hidden text-[10px] sm:inline">· Son klip</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onAdjustSceneDuration(idx, scene.durationSec - 5)}
                        className="rounded border border-white/[0.08] bg-[#0B0F17] px-2 py-1.5 font-mono text-[11px] tabular-nums text-[#94A3B8] transition-colors hover:border-white/[0.18] hover:text-[#F1F5F9]"
                      >
                        -5s
                      </button>
                      <button
                        type="button"
                        onClick={() => onAdjustSceneDuration(idx, scene.durationSec - 1)}
                        className="rounded border border-white/[0.08] bg-[#0B0F17] px-2 py-1.5 font-mono text-[11px] tabular-nums text-[#94A3B8] transition-colors hover:border-white/[0.18] hover:text-[#F1F5F9]"
                      >
                        -1s
                      </button>

                      <div className="relative flex items-center">
                        <input
                          type="number"
                          aria-label={`${scene.filename} süresi (saniye)`}
                          min={2}
                          step={0.5}
                          value={draftVal}
                          onChange={(e) =>
                            setEditingDraft((prev) => ({ ...prev, [scene.id]: e.target.value }))
                          }
                          onBlur={() => commitDurationDraft(idx, scene.id, scene.durationSec)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              (e.currentTarget as HTMLInputElement).blur();
                            }
                          }}
                          className="w-16 rounded border border-white/[0.12] bg-[#0B0F17] py-1.5 pl-2 pr-5 text-right font-mono text-xs tabular-nums text-[#F1F5F9] focus:border-[#D99B26]/60 focus:outline-none"
                        />
                        <span className="pointer-events-none absolute right-1.5 font-mono text-[10px] text-[#64748B]">
                          sn
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => onAdjustSceneDuration(idx, scene.durationSec + 1)}
                        className="rounded border border-white/[0.08] bg-[#0B0F17] px-2 py-1.5 font-mono text-[11px] tabular-nums text-[#94A3B8] transition-colors hover:border-white/[0.18] hover:text-[#F1F5F9]"
                      >
                        +1s
                      </button>
                      <button
                        type="button"
                        onClick={() => onAdjustSceneDuration(idx, scene.durationSec + 5)}
                        className="rounded border border-white/[0.08] bg-[#0B0F17] px-2 py-1.5 font-mono text-[11px] tabular-nums text-[#94A3B8] transition-colors hover:border-white/[0.18] hover:text-[#F1F5F9]"
                      >
                        +5s
                      </button>
                    </div>
                  )}

                  {/* Zoom Direction Toggle */}
                  <button
                    type="button"
                    onClick={() => onToggleZoomDirection(idx)}
                    title="Zoom yönünü değiştir (Uzaklaş / Yakınlaş)"
                    className="flex w-[104px] items-center justify-center gap-1.5 rounded-md border border-white/[0.1] bg-[#0B0F17] px-2.5 py-1.5 text-xs font-medium text-[#E2E8F0] transition-colors hover:border-[#D99B26]/50 hover:text-[#F1F5F9]"
                  >
                    {scene.zoomDirection === 'uzaklas' ? (
                      <>
                        <ZoomOut className="h-3.5 w-3.5 text-[#D99B26]" />
                        <span>Uzaklaş</span>
                      </>
                    ) : (
                      <>
                        <ZoomIn className="h-3.5 w-3.5 text-[#D99B26]" />
                        <span>Yakınlaş</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};
