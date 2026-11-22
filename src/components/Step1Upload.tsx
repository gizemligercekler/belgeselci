import React, { useRef, useState } from 'react';
import {
  FileAudio,
  Images,
  Upload,
  FileText,
  X,
  ArrowRight,
  Trash2,
  Loader2,
  ShieldCheck,
  AlertCircle,
} from 'lucide-react';
import { TranscriptSegment, UploadedImage } from '../types/editor';
import { formatMMSS } from '../utils/timelineMath';
import { TranscribeProgress } from '../services/editorApi';

interface Step1UploadProps {
  audioFile: File | null;
  audioFileName: string;
  totalAudioDuration: number;
  images: UploadedImage[];
  srtFileName: string;
  srtSegments: TranscriptSegment[];
  isProcessing: boolean;
  progress: TranscribeProgress | null;
  retryWaitSec: number | null;
  errorMessage: string | null;
  hasExistingTimeline: boolean;
  onSelectAudio: (file: File) => void;
  onClearAudio: () => void;
  onAddImages: (files: File[]) => void;
  onRemoveImage: (id: string) => void;
  onClearImages: () => void;
  onUploadSrt: (file: File) => void;
  onClearSrt: () => void;
  onStartProcess: () => void;
  onCancelProcess: () => void;
  onGoToExistingTimeline: () => void;
}

export const Step1Upload: React.FC<Step1UploadProps> = ({
  audioFile,
  audioFileName,
  totalAudioDuration,
  images,
  srtFileName,
  srtSegments,
  isProcessing,
  progress,
  retryWaitSec,
  errorMessage,
  hasExistingTimeline,
  onSelectAudio,
  onClearAudio,
  onAddImages,
  onRemoveImage,
  onClearImages,
  onUploadSrt,
  onClearSrt,
  onStartProcess,
  onCancelProcess,
  onGoToExistingTimeline,
}) => {
  const audioInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);

  const [audioDragOver, setAudioDragOver] = useState(false);
  const [imagesDragOver, setImagesDragOver] = useState(false);

  const hasAudioReady = totalAudioDuration > 0 && Boolean(audioFile || (srtSegments.length > 0 && audioFileName));
  const canProcess = !isProcessing && hasAudioReady && images.length > 0 && Boolean(audioFile || srtSegments.length > 0);

  const handleAudioDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setAudioDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onSelectAudio(file);
  };

  const handleImagesDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setImagesDragOver(false);
    const list = Array.from(e.dataTransfer.files || []);
    if (list.length > 0) onAddImages(list);
  };

  const progressPercent =
    progress && progress.phase === 'transcribing' && progress.totalChunks > 0
      ? Math.round(((progress.currentChunk - 0.5) / progress.totalChunks) * 85)
      : progress?.phase === 'aligning'
        ? 92
        : progress?.phase === 'decoding'
          ? 10
          : 0;

  return (
    <div className="mx-auto max-w-[1160px] space-y-8 px-4 py-8 sm:px-6">
      {/* Calm Header */}
      <div className="flex flex-col justify-between gap-4 border-b border-white/[0.07] pb-6 sm:flex-row sm:items-end">
        <div className="space-y-1.5">
          <p className="font-mono text-xs uppercase tracking-widest text-[#D99B26]">
            Adım 01 / 03
          </p>
          <h1 className="font-display text-2xl font-medium tracking-tight text-[#F1F5F9] sm:text-3xl">
            Ses &amp; Sıralı Görselleri Yükle
          </h1>
          <p className="max-w-2xl text-sm text-[#94A3B8]">
            Belgesel sesinizi ve numaralandırılmış görsellerinizi bırakın. Görseller doğal sayısal sıraya dizilir,
            ses kaydınız dokunulmadan çözümlenir ve her görsel anlatıldığı tam saniyeye yerleştirilir.
          </p>
        </div>

        {hasExistingTimeline && !isProcessing && (
          <button
            type="button"
            onClick={onGoToExistingTimeline}
            className="flex shrink-0 items-center gap-1.5 self-start rounded-md border border-white/[0.1] bg-[#131924] px-3.5 py-2 text-xs font-medium text-[#CBD5E1] transition-colors hover:border-white/[0.2] hover:bg-[#1A2230] hover:text-[#F1F5F9] sm:self-auto"
          >
            <span>Kayıtlı Zaman Çizelgesine Dön</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Two-Column Upload Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: Documentary Audio Upload + Optional SRT */}
        <section className="flex flex-col justify-between gap-5 rounded-lg border border-white/[0.08] bg-[#131924] p-6 lg:col-span-5">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-[#F1F5F9]">
                <FileAudio className="h-4 w-4 text-[#D99B26]" />
                <span>Belgesel Ses Dosyası</span>
              </div>
              <span className="font-mono text-[11px] text-[#64748B]">MP3 · WAV · M4A</span>
            </div>

            {/* Dropzone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setAudioDragOver(true);
              }}
              onDragLeave={() => setAudioDragOver(false)}
              onDrop={handleAudioDrop}
              onClick={() => !isProcessing && audioInputRef.current?.click()}
              className={`group flex min-h-[180px] cursor-pointer flex-col items-center justify-center rounded-md border border-dashed p-6 text-center transition-colors ${
                audioDragOver
                  ? 'border-[#D99B26] bg-[#D99B26]/[0.06]'
                  : audioFileName
                    ? 'border-white/[0.14] bg-[#0B0F17]/70 hover:border-white/[0.24]'
                    : 'border-white/[0.12] bg-[#0B0F17]/50 hover:border-[#D99B26]/50 hover:bg-[#0B0F17]'
              }`}
            >
              <input
                ref={audioInputRef}
                type="file"
                accept=".mp3,.wav,.m4a,.aac,.flac,audio/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onSelectAudio(file);
                  e.target.value = '';
                }}
              />

              {audioFileName ? (
                <div className="w-full space-y-3">
                  <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md border border-[#D99B26]/30 bg-[#D99B26]/10 text-[#D99B26]">
                    <FileAudio className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <p className="truncate px-2 text-sm font-medium text-[#F1F5F9]" title={audioFileName}>
                      {audioFileName}
                    </p>
                    <p className="font-mono text-xs tabular-nums text-[#D99B26]">
                      Toplam Süre: {formatMMSS(totalAudioDuration)} ({totalAudioDuration.toFixed(1)} sn)
                    </p>
                    {!audioFile && (
                      <p className="text-[11px] text-[#94A3B8]">
                        Önizleme veya yeniden transkript için ses dosyasını tekrar seçebilirsiniz.
                      </p>
                    )}
                  </div>
                  <div className="flex items-center justify-center gap-3 pt-1">
                    <span className="text-xs text-[#94A3B8] underline decoration-white/20 underline-offset-4 group-hover:text-[#F1F5F9]">
                      Dosyayı Değiştir
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onClearAudio();
                      }}
                      className="text-xs text-[#64748B] hover:text-rose-400"
                    >
                      Kaldır
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md border border-white/[0.08] bg-[#1A2230] text-[#94A3B8] group-hover:text-[#D99B26]">
                    <Upload className="h-4 w-4" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-[#E2E8F0]">
                      Ses dosyasını sürükleyip bırakın
                    </p>
                    <p className="text-xs text-[#64748B]">
                      veya bilgisayarınızdan seçmek için tıklayın
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Untouched Audio Guarantee */}
            <div className="flex items-start gap-2.5 rounded-md border border-white/[0.06] bg-[#0B0F17]/60 px-3.5 py-2.5 text-xs text-[#94A3B8]">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#D99B26]" />
              <p className="leading-relaxed">
                Orijinal ses dosyanız hiçbir aşamada değiştirilmez, normalize edilmez veya yeniden kodlanmaz.
                Render paketinde <span className="font-mono text-[#CBD5E1]">-c:a copy</span> ile birebir korunur.
              </p>
            </div>
          </div>

          {/* Subtle Secondary Optional .srt Upload */}
          <div className="border-t border-white/[0.06] pt-4">
            <input
              ref={srtInputRef}
              type="file"
              accept=".srt,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUploadSrt(file);
                e.target.value = '';
              }}
            />

            {srtSegments.length > 0 ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-white/[0.08] bg-[#0B0F17] px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-[#D99B26]" />
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-[#E2E8F0]">
                      {srtFileName || 'Hazır Transkript (.srt)'}
                    </p>
                    <p className="font-mono text-[11px] tabular-nums text-[#64748B]">
                      {srtSegments.length} zaman damgalı satır yüklendi · Ses transkripti atlanacak
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClearSrt}
                  title="SRT dosyasını kaldır"
                  className="rounded p-1 text-[#64748B] hover:bg-white/[0.05] hover:text-rose-400"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-[#64748B]">
                  Hazır zaman damgalı metniniz varsa:
                </span>
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => srtInputRef.current?.click()}
                  className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-transparent px-2.5 py-1.5 text-xs text-[#94A3B8] transition-colors hover:border-white/[0.16] hover:bg-white/[0.04] hover:text-[#F1F5F9] disabled:opacity-50"
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>Opsiyonel .SRT Yükle</span>
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Right: Multi-Image Natural Numeric Sort Dropzone */}
        <section className="flex flex-col rounded-lg border border-white/[0.08] bg-[#131924] p-6 lg:col-span-7">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-[#F1F5F9]">
              <Images className="h-4 w-4 text-[#D99B26]" />
              <span>Sıralı Belgesel Görselleri</span>
              {images.length > 0 && (
                <span className="font-mono text-xs tabular-nums text-[#94A3B8]">
                  · {images.length} görsel
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {images.length > 0 && !isProcessing && (
                <>
                  <button
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    className="rounded-md border border-white/[0.08] bg-[#0B0F17] px-2.5 py-1 text-xs text-[#CBD5E1] transition-colors hover:border-white/[0.18] hover:text-[#F1F5F9]"
                  >
                    + Görsel Ekle
                  </button>
                  <button
                    type="button"
                    onClick={onClearImages}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[#64748B] transition-colors hover:text-rose-400"
                  >
                    <Trash2 className="h-3 w-3" />
                    <span>Temizle</span>
                  </button>
                </>
              )}
            </div>
          </div>

          <input
            ref={imageInputRef}
            type="file"
            multiple
            accept="image/*,.png,.jpg,.jpeg,.webp"
            className="hidden"
            onChange={(e) => {
              const list = Array.from(e.target.files || []);
              if (list.length > 0) onAddImages(list);
              e.target.value = '';
            }}
          />

          {images.length === 0 ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setImagesDragOver(true);
              }}
              onDragLeave={() => setImagesDragOver(false)}
              onDrop={handleImagesDrop}
              onClick={() => !isProcessing && imageInputRef.current?.click()}
              className={`group flex flex-1 min-h-[260px] cursor-pointer flex-col items-center justify-center rounded-md border border-dashed p-8 text-center transition-colors ${
                imagesDragOver
                  ? 'border-[#D99B26] bg-[#D99B26]/[0.06]'
                  : 'border-white/[0.12] bg-[#0B0F17]/50 hover:border-[#D99B26]/50 hover:bg-[#0B0F17]'
              }`}
            >
              <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-md border border-white/[0.08] bg-[#1A2230] text-[#94A3B8] group-hover:text-[#D99B26]">
                <Images className="h-5 w-5" />
              </div>
              <p className="text-sm font-medium text-[#E2E8F0]">
                Tüm numaralı görselleri toplu olarak buraya bırakın
              </p>
              <p className="mt-1.5 max-w-md text-xs leading-relaxed text-[#64748B]">
                Örnek: <span className="font-mono text-[#94A3B8]">1. giris.png</span>,{' '}
                <span className="font-mono text-[#94A3B8]">10. ilk parşömen.png</span>,{' '}
                <span className="font-mono text-[#94A3B8]">52. sana yazmalari.png</span>.
                Dosyalar asla alfabetik değil, doğal sayısal sırayla (1, 2, ..., 10, ..., 52) dizilir.
              </p>
            </div>
          ) : (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setImagesDragOver(true);
              }}
              onDragLeave={() => setImagesDragOver(false)}
              onDrop={handleImagesDrop}
              className={`flex max-h-[340px] flex-col overflow-y-auto rounded-md border bg-[#0B0F17]/60 transition-colors ${
                imagesDragOver ? 'border-[#D99B26]' : 'border-white/[0.07]'
              }`}
            >
              <div className="divide-y divide-white/[0.05]">
                {images.map((img, idx) => (
                  <div
                    key={img.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 transition-colors hover:bg-white/[0.02]"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="w-8 shrink-0 font-mono text-xs tabular-nums text-[#D99B26]">
                        #{img.orderNumber}
                      </span>
                      {img.objectUrl ? (
                        <img
                          src={img.objectUrl}
                          alt={img.cleanTitle}
                          className="h-9 w-16 shrink-0 rounded-sm border border-white/[0.08] object-cover"
                        />
                      ) : (
                        <div className="flex h-9 w-16 shrink-0 items-center justify-center rounded-sm border border-white/[0.08] bg-[#131924] font-mono text-[10px] text-[#475569]">
                          {idx + 1}
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-[#E2E8F0]">
                          {img.cleanTitle}
                        </p>
                        <p className="truncate font-mono text-[11px] text-[#64748B]" title={img.filename}>
                          {img.filename}
                        </p>
                      </div>
                    </div>

                    {!isProcessing && (
                      <button
                        type="button"
                        onClick={() => onRemoveImage(img.id)}
                        title="Görseli kaldır"
                        className="rounded p-1 text-[#64748B] hover:bg-white/[0.05] hover:text-rose-400"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Error Message */}
      {errorMessage && (
        <div className="flex items-start gap-3 rounded-lg border border-rose-500/30 bg-rose-950/30 px-4 py-3 text-sm text-rose-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          <p className="leading-relaxed">{errorMessage}</p>
        </div>
      )}

      {/* Action Footer & Live Chunk Progress */}
      <div className="rounded-lg border border-white/[0.08] bg-[#131924] p-5">
        {isProcessing ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Loader2 className="h-4 w-4 animate-spin text-[#D99B26]" />
                <span className="text-sm font-medium text-[#F1F5F9]">
                  {progress?.message || 'İşlem hazırlanıyor...'}
                </span>
              </div>
              <button
                type="button"
                onClick={onCancelProcess}
                className="rounded-md border border-white/[0.1] px-3 py-1.5 text-xs font-medium text-[#94A3B8] transition-colors hover:border-rose-400/40 hover:text-rose-300"
              >
                İptal Et
              </button>
            </div>

            {retryWaitSec !== null && (
              <p className="font-mono text-xs tabular-nums text-[#D99B26]">
                Free Tier hız sınırı (429) algılandı — {retryWaitSec} saniye sonra otomatik yeniden denenecek...
              </p>
            )}

            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#0B0F17]">
              <div
                className="h-full bg-[#D99B26] transition-all duration-300"
                style={{ width: `${Math.max(6, progressPercent)}%` }}
              />
            </div>

            <p className="text-xs text-[#64748B]">
              Uzun belgesellerde zaman kaymasını önlemek için ses 5 dakikalık hafif 16kHz WAV parçalarına bölünür ve
              kota koruması için parçalar arasında 2 saniye beklenir.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div className="space-y-0.5 text-xs text-[#94A3B8]">
              <p className="font-medium text-[#CBD5E1]">
                {srtSegments.length > 0
                  ? 'Hazır .SRT yüklü — doğrudan görseller zaman çizelgesine eşleştirilecek.'
                  : '5 dakikalık parçalama ile drift-free Türkçe transkript + sıralı görsel eşleştirme.'}
              </p>
              <p className="font-mono text-[11px] tabular-nums text-[#64748B]">
                {audioFileName
                  ? `Ses: ${formatMMSS(totalAudioDuration)} · Görsel: ${images.length} adet`
                  : 'Başlamak için 1 ses dosyası ve en az 1 görsel seçin.'}
              </p>
            </div>

            <button
              type="button"
              disabled={!canProcess}
              onClick={onStartProcess}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-[#D99B26] px-5 py-2.5 text-sm font-semibold text-[#0B0F17] transition-colors hover:bg-[#E5AA38] disabled:cursor-not-allowed disabled:bg-[#1E293B] disabled:text-[#64748B] sm:w-auto"
            >
              <span>
                {srtSegments.length > 0
                  ? 'Resimleri .SRT ile Eşleştir'
                  : 'Transkript Çıkar ve Resimleri Eşleştir'}
              </span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
