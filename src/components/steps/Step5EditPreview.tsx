import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Music,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Upload,
  Volume2,
} from 'lucide-react';
import { EditSettings, ProjectRecord } from '../../types/studio';
import { getMediaBlob, saveMediaBlob } from '../../utils/storageDb';
import { formatDurationClock } from '../../utils/wavEncoder';

interface Step5EditPreviewProps {
  project: ProjectRecord;
  onUpdateProject: (updater: (prev: ProjectRecord) => ProjectRecord) => void;
  onNextStep: () => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

export const Step5EditPreview: React.FC<Step5EditPreviewProps> = ({
  project,
  onUpdateProject,
  onNextStep,
  onNotify,
}) => {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playNonce, setPlayNonce] = useState(0);
  const [currentVisualUrl, setCurrentVisualUrl] = useState<string>('');
  const [currentAudioUrl, setCurrentAudioUrl] = useState<string>('');
  const [bgMusicUrl, setBgMusicUrl] = useState<string>('');
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);

  const narrationAudioRef = useRef<HTMLAudioElement | null>(null);
  const bgMusicAudioRef = useRef<HTMLAudioElement | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);

  const { editSettings, scenes, chunks } = project;
  const activeScene = scenes[selectedIdx] || scenes[0] || null;
  const linkedChunk = activeScene
    ? chunks.find((c) => c.index === activeScene.chunkIndex) || null
    : null;

  // Keep index valid if scenes shrink
  useEffect(() => {
    if (selectedIdx >= scenes.length && scenes.length > 0) {
      setSelectedIdx(0);
    }
  }, [scenes.length, selectedIdx]);

  // Load visual blob URL for active scene
  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';

    const loadVisual = async () => {
      if (!activeScene) {
        setCurrentVisualUrl('');
        return;
      }
      if (activeScene.visualBlobId) {
        const rec = await getMediaBlob(activeScene.visualBlobId);
        if (rec?.blob && !cancelled) {
          objectUrl = URL.createObjectURL(rec.blob);
          setCurrentVisualUrl(objectUrl);
        }
      } else if (activeScene.remoteVideoUrl) {
        setCurrentVisualUrl(activeScene.remoteVideoUrl);
      } else {
        setCurrentVisualUrl('');
      }
    };

    void loadVisual();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [activeScene]);

  // Load narration audio blob URL for linked chunk
  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';

    const loadAudio = async () => {
      if (!linkedChunk?.audioBlobId) {
        setCurrentAudioUrl('');
        setAudioDuration(activeScene?.durationSec || 15);
        return;
      }
      const rec = await getMediaBlob(linkedChunk.audioBlobId);
      if (rec?.blob && !cancelled) {
        objectUrl = URL.createObjectURL(rec.blob);
        setCurrentAudioUrl(objectUrl);
        setAudioDuration(linkedChunk.durationSec || activeScene?.durationSec || 15);
      }
    };

    void loadAudio();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [linkedChunk, activeScene?.durationSec]);

  // Load optional background music blob URL
  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';
    const loadMusic = async () => {
      if (!editSettings.bgMusicBlobId) {
        setBgMusicUrl('');
        return;
      }
      const rec = await getMediaBlob(editSettings.bgMusicBlobId);
      if (rec?.blob && !cancelled) {
        objectUrl = URL.createObjectURL(rec.blob);
        setBgMusicUrl(objectUrl);
      }
    };
    void loadMusic();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [editSettings.bgMusicBlobId]);

  // Sync background music volume from dB
  useEffect(() => {
    if (bgMusicAudioRef.current) {
      const linearGain = Math.min(1, Math.max(0, Math.pow(10, editSettings.bgMusicVolumeDb / 20)));
      bgMusicAudioRef.current.volume = linearGain;
    }
  }, [editSettings.bgMusicVolumeDb, bgMusicUrl]);

  // Fallback timer when scene has no generated TTS audio yet
  useEffect(() => {
    if (!isPlaying || currentAudioUrl) return;
    const targetDur = activeScene?.durationSec || 15;
    const interval = setInterval(() => {
      setCurrentTime((prev) => {
        if (prev + 0.1 >= targetDur) {
          if (selectedIdx + 1 < scenes.length) {
            setSelectedIdx((i) => i + 1);
            setPlayNonce((n) => n + 1);
            return 0;
          }
          setIsPlaying(false);
          return targetDur;
        }
        return prev + 0.1;
      });
    }, 100);
    return () => clearInterval(interval);
  }, [isPlaying, currentAudioUrl, activeScene?.durationSec, selectedIdx, scenes.length]);

  const updateEdit = <K extends keyof EditSettings>(key: K, val: EditSettings[K]) => {
    onUpdateProject((prev) => ({
      ...prev,
      editSettings: { ...prev.editSettings, [key]: val },
    }));
  };

  const togglePlayback = async () => {
    if (!activeScene) return;
    if (isPlaying) {
      narrationAudioRef.current?.pause();
      bgMusicAudioRef.current?.pause();
      videoElRef.current?.pause();
      setIsPlaying(false);
    } else {
      setIsPlaying(true);
      if (narrationAudioRef.current && currentAudioUrl) {
        try {
          await narrationAudioRef.current.play();
        } catch {
          // Ignore browser autoplay block
        }
      }
      if (bgMusicAudioRef.current && bgMusicUrl) {
        try {
          await bgMusicAudioRef.current.play();
        } catch {
          // Ignore
        }
      }
      if (videoElRef.current) {
        try {
          await videoElRef.current.play();
        } catch {
          // Ignore
        }
      }
    }
  };

  const restartScene = () => {
    setCurrentTime(0);
    setPlayNonce((n) => n + 1);
    if (narrationAudioRef.current) narrationAudioRef.current.currentTime = 0;
    if (videoElRef.current) videoElRef.current.currentTime = 0;
  };

  const handleUploadBgMusic = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const blobId = `music_${project.id}_${Date.now()}`;
    await saveMediaBlob({
      id: blobId,
      projectId: project.id,
      kind: 'music',
      mimeType: file.type || 'audio/mpeg',
      blob: file,
      updatedAt: Date.now(),
    });
    onUpdateProject((prev) => ({
      ...prev,
      editSettings: {
        ...prev.editSettings,
        bgMusicFileName: file.name,
        bgMusicBlobId: blobId,
      },
    }));
    onNotify(`Arka plan müziği yüklendi: ${file.name}`);
    e.target.value = '';
  };

  const isVideoVisual =
    Boolean(activeScene?.remoteVideoUrl) ||
    Boolean(activeScene?.visualMimeType?.startsWith('video/'));

  const kbClass =
    activeScene && activeScene.kenBurnsEffect !== 'none'
      ? `kb-anim-${activeScene.kenBurnsEffect} ${!isPlaying ? 'kb-paused' : ''}`
      : '';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-slate-800/80 pb-5">
        <div className="space-y-1.5">
          <p className="text-xs font-mono text-[#D99B26]">Adım 05 · Kurgu Masası &amp; Önizleme</p>
          <h1 className="font-editorial text-3xl font-semibold text-slate-100">
            Kurgu Ayarları ve Canlı 16:9 Sahne Önizleme
          </h1>
          <p className="text-xs text-slate-400">
            Filmora&apos;ya gerek kalmadan Ken Burns hareketini, bölüm alt bantlarını, ayet
            kutularını ve ses senkronunu dışa aktarma öncesi gerçek zamanlı test edin.
          </p>
        </div>

        <button
          type="button"
          onClick={onNextStep}
          className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] rounded-xl cursor-pointer whitespace-nowrap self-start lg:self-auto"
        >
          <span>Dışa Aktar &amp; Render Paketi</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left 5 Cols: Global Editing & Overlay Settings */}
        <div className="xl:col-span-5 bg-[#131924] border border-slate-800/80 rounded-2xl p-5 space-y-6">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-100">Video ve Geçiş Ayarları</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Çözünürlük</label>
                <select
                  value={editSettings.resolution}
                  onChange={(e) =>
                    updateEdit('resolution', e.target.value as EditSettings['resolution'])
                  }
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
                >
                  <option value="1920x1080">1920×1080 (Full HD)</option>
                  <option value="3840x2160">3840×2160 (4K UHD)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Kare Hızı (FPS)</label>
                <select
                  value={editSettings.fps}
                  onChange={(e) => updateEdit('fps', Number(e.target.value) as 24 | 30)}
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
                >
                  <option value={24}>24 FPS (Sinematik)</option>
                  <option value={30}>30 FPS (YouTube)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Crossfade Süresi (sn)
                </label>
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={3}
                  value={editSettings.transitionDurationSec}
                  onChange={(e) =>
                    updateEdit('transitionDurationSec', Math.max(0, Number(e.target.value) || 0))
                  }
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono tabular-nums text-slate-100"
                />
              </div>
              <div>
                <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                  <span>Ken Burns Yakınlaştırma</span>
                  <span className="font-mono text-[#F3C669]">
                    1.00 → {editSettings.kenBurnsIntensity.toFixed(2)}x
                  </span>
                </div>
                <input
                  type="range"
                  min={1.02}
                  max={1.18}
                  step={0.01}
                  value={editSettings.kenBurnsIntensity}
                  onChange={(e) => updateEdit('kenBurnsIntensity', Number(e.target.value))}
                  className="w-full accent-[#D99B26] mt-1.5 cursor-pointer"
                />
              </div>
            </div>
          </section>

          <hr className="border-slate-800/70" />

          {/* Background Music */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <Music className="w-4 h-4 text-[#D99B26]" />
                <span>Arka Plan Müziği</span>
              </h2>
              <label className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg cursor-pointer">
                <Upload className="w-3.5 h-3.5" />
                <span>Müzik Yükle</span>
                <input
                  type="file"
                  accept="audio/*"
                  onChange={handleUploadBgMusic}
                  className="hidden"
                />
              </label>
            </div>

            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                Müzik Dosya Adı (FFmpeg betiğinde aranan ad)
              </label>
              <input
                type="text"
                value={editSettings.bgMusicFileName}
                onChange={(e) => updateEdit('bgMusicFileName', e.target.value)}
                className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 items-center">
              <div>
                <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                  <span>Müzik Seviyesi</span>
                  <span className="font-mono text-slate-200">{editSettings.bgMusicVolumeDb} dB</span>
                </div>
                <input
                  type="range"
                  min={-36}
                  max={-10}
                  step={1}
                  value={editSettings.bgMusicVolumeDb}
                  onChange={(e) => updateEdit('bgMusicVolumeDb', Number(e.target.value))}
                  className="w-full accent-[#D99B26] cursor-pointer"
                />
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer pt-3">
                <input
                  type="checkbox"
                  checked={editSettings.bgMusicAutoLoop}
                  onChange={(e) => updateEdit('bgMusicAutoLoop', e.target.checked)}
                  className="accent-[#D99B26] rounded cursor-pointer"
                />
                <span>Otomatik Crossfade Döngü</span>
              </label>
            </div>
          </section>

          <hr className="border-slate-800/70" />

          {/* Overlay Styling & Whisper */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-100">
              Ekran Katmanı (Overlay) ve Zamanlama
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Bölüm Alt Bandı Konumu</label>
                <select
                  value={editSettings.overlayChapterPosition}
                  onChange={(e) =>
                    updateEdit(
                      'overlayChapterPosition',
                      e.target.value as EditSettings['overlayChapterPosition']
                    )
                  }
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100"
                >
                  <option value="bottom-left">Sol Alt (BBC Klasik)</option>
                  <option value="top-left">Sol Üst</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Vurgu Rengi</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={editSettings.overlayAccentHex}
                    onChange={(e) => updateEdit('overlayAccentHex', e.target.value)}
                    className="h-8 w-10 bg-transparent border border-slate-700 rounded cursor-pointer"
                  />
                  <span className="text-xs font-mono text-slate-300">
                    {editSettings.overlayAccentHex}
                  </span>
                </div>
              </div>
            </div>

            <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={editSettings.useFasterWhisper}
                onChange={(e) => updateEdit('useFasterWhisper', e.target.checked)}
                className="mt-0.5 accent-[#D99B26] rounded cursor-pointer"
              />
              <span>
                Yerel Python betiğinde <code className="font-mono text-slate-100">faster-whisper</code>{' '}
                desteğini etkinleştir (kurulu değilse otomatik orantısal zamanlamaya düşer).
              </span>
            </label>
          </section>
        </div>

        {/* Right 7 Cols: Live Interactive 16:9 Preview Player */}
        <div className="xl:col-span-7 space-y-4">
          <div className="bg-[#131924] border border-slate-800/80 rounded-2xl p-4 space-y-4">
            {/* 16:9 Stage */}
            <div className="relative aspect-video rounded-xl overflow-hidden bg-[#06090F] border border-slate-800 select-none">
              {activeScene ? (
                <>
                  {/* Background Media Layer */}
                  {currentVisualUrl ? (
                    isVideoVisual ? (
                      <video
                        ref={videoElRef}
                        key={`vid_${activeScene.id}`}
                        src={currentVisualUrl}
                        loop
                        muted
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <img
                        key={`img_${activeScene.id}_${playNonce}`}
                        src={currentVisualUrl}
                        alt={`Sahne ${activeScene.sceneNumber}`}
                        referrerPolicy="no-referrer"
                        style={
                          {
                            '--kb-scale': editSettings.kenBurnsIntensity,
                            '--kb-duration': `${Math.max(6, audioDuration || activeScene.durationSec)}s`,
                          } as React.CSSProperties
                        }
                        className={`w-full h-full object-cover will-change-transform ${kbClass}`}
                      />
                    )
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-center p-8 bg-gradient-to-br from-[#0F172A] via-[#0B0F17] to-[#171E2E]">
                      <p className="font-editorial text-lg text-slate-300">
                        Sahne #{activeScene.sceneNumber} görseli henüz eklenmedi
                      </p>
                      <p className="text-xs text-slate-500 mt-1 max-w-md">
                        Adım 4&apos;te bu sahneye görsel sürükleyip bıraktığınızda canlı Ken Burns
                        önizlemesi burada görünür.
                      </p>
                    </div>
                  )}

                  {/* Measured Contrast Scrim for Media Overlays */}
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent" />

                  {/* Live Overlay Layer: Chapter Lower-Third */}
                  {activeScene.overlayKind === 'bolum' && activeScene.overlayText.trim() && (
                    <div
                      className={`absolute left-6 max-w-[78%] rounded-lg px-5 py-3.5 backdrop-blur-md border border-white/10 ${
                        editSettings.overlayChapterPosition === 'top-left' ? 'top-6' : 'bottom-6'
                      }`}
                      style={{
                        backgroundColor: `rgba(11, 15, 23, ${editSettings.overlayChapterBgOpacity})`,
                        borderBottomWidth: '3px',
                        borderBottomColor: editSettings.overlayAccentHex,
                      }}
                    >
                      <div
                        className="text-[10px] font-mono tracking-wider uppercase"
                        style={{ color: editSettings.overlayAccentHex }}
                      >
                        {activeScene.overlayLabel || 'BÖLÜM'}
                      </div>
                      <div className="font-editorial text-base sm:text-xl font-semibold text-white tracking-wide uppercase mt-0.5 leading-snug">
                        {activeScene.overlayText}
                      </div>
                    </div>
                  )}

                  {/* Live Overlay Layer: Verse / Quote Box */}
                  {activeScene.overlayKind === 'ayet' && activeScene.overlayText.trim() && (
                    <div
                      className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[82%] rounded-xl px-6 py-4 text-center backdrop-blur-md border"
                      style={{
                        backgroundColor: `rgba(11, 15, 23, ${editSettings.overlayVerseBgOpacity})`,
                        borderColor: `${editSettings.overlayAccentHex}66`,
                      }}
                    >
                      {activeScene.overlayLabel && (
                        <div
                          className="text-xs font-semibold tracking-wide mb-1"
                          style={{ color: editSettings.overlayAccentHex }}
                        >
                          {activeScene.overlayLabel}
                        </div>
                      )}
                      <div className="font-editorial text-sm sm:text-lg text-slate-100 leading-relaxed">
                        &ldquo;{activeScene.overlayText}&rdquo;
                      </div>
                    </div>
                  )}

                  {/* Live Overlay Layer: Reference Badge */}
                  {activeScene.overlayKind === 'etiket' && activeScene.overlayText.trim() && (
                    <div className="absolute top-5 right-5 rounded-lg px-3.5 py-2 bg-[#0B0F17]/80 backdrop-blur-md border border-slate-500/30 text-xs font-medium text-slate-100">
                      {activeScene.overlayText}
                    </div>
                  )}
                </>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-sm text-slate-400">
                  Önizlemek için önce Adım 4&apos;te storyboard sahneleri oluşturun.
                </div>
              )}
            </div>

            {/* Hidden Audio Engines */}
            {currentAudioUrl && (
              <audio
                ref={narrationAudioRef}
                src={currentAudioUrl}
                onLoadedMetadata={(e) => {
                  const d = e.currentTarget.duration;
                  if (Number.isFinite(d) && d > 0) setAudioDuration(d);
                }}
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                onEnded={() => {
                  if (selectedIdx + 1 < scenes.length) {
                    setSelectedIdx((i) => i + 1);
                    setPlayNonce((n) => n + 1);
                  } else {
                    setIsPlaying(false);
                    bgMusicAudioRef.current?.pause();
                  }
                }}
              />
            )}
            {bgMusicUrl && (
              <audio ref={bgMusicAudioRef} src={bgMusicUrl} loop={editSettings.bgMusicAutoLoop} />
            )}

            {/* Player Transport Bar */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={selectedIdx <= 0}
                  onClick={() => {
                    setSelectedIdx((i) => Math.max(0, i - 1));
                    setCurrentTime(0);
                    setPlayNonce((n) => n + 1);
                  }}
                  className="p-2 text-slate-300 hover:text-white disabled:opacity-30 bg-[#0B0F17] border border-slate-800 rounded-lg cursor-pointer"
                  title="Önceki sahne"
                >
                  <SkipBack className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  disabled={!activeScene}
                  onClick={() => void togglePlayback()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] disabled:opacity-40 rounded-lg cursor-pointer"
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  <span>{isPlaying ? 'Duraklat' : 'Sahneyi Oynat'}</span>
                </button>

                <button
                  type="button"
                  disabled={!activeScene}
                  onClick={restartScene}
                  className="p-2 text-slate-300 hover:text-white disabled:opacity-30 bg-[#0B0F17] border border-slate-800 rounded-lg cursor-pointer"
                  title="Sahneyi başa sar"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  disabled={selectedIdx >= scenes.length - 1}
                  onClick={() => {
                    setSelectedIdx((i) => Math.min(scenes.length - 1, i + 1));
                    setCurrentTime(0);
                    setPlayNonce((n) => n + 1);
                  }}
                  className="p-2 text-slate-300 hover:text-white disabled:opacity-30 bg-[#0B0F17] border border-slate-800 rounded-lg cursor-pointer"
                  title="Sonraki sahne"
                >
                  <SkipForward className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center gap-3 text-xs font-mono tabular-nums text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <Volume2 className="w-3.5 h-3.5 text-slate-500" />
                  {currentAudioUrl ? `Parça #${activeScene?.chunkIndex} Sesi Bağlı` : 'Sesiz Önizleme'}
                </span>
                <span>
                  {formatDurationClock(currentTime)} / {formatDurationClock(audioDuration)}
                </span>
              </div>
            </div>
          </div>

          {/* Scene Selector Strip */}
          {scenes.length > 0 && (
            <div className="bg-[#131924] border border-slate-800/80 rounded-2xl p-4 space-y-2.5">
              <div className="text-xs font-medium text-slate-300">
                Sahne Zaman Çizelgesi ({scenes.length} sahne)
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {scenes.map((sc, idx) => {
                  const selected = idx === selectedIdx;
                  return (
                    <button
                      key={sc.id}
                      type="button"
                      onClick={() => {
                        setSelectedIdx(idx);
                        setCurrentTime(0);
                        setPlayNonce((n) => n + 1);
                      }}
                      className={`shrink-0 w-44 text-left p-2.5 rounded-xl border transition-colors cursor-pointer ${
                        selected
                          ? 'bg-[#1A2230] border-[#D99B26]/70 text-white'
                          : 'bg-[#0B0F17] border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between text-[11px] font-mono tabular-nums">
                        <span className="text-[#F3C669]">#{String(sc.sceneNumber).padStart(2, '0')}</span>
                        <span>{sc.durationSec}s</span>
                      </div>
                      <div className="text-xs truncate mt-1">
                        {sc.overlayText || sc.excerpt || 'Sahne'}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
