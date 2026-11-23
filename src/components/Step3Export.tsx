import React, { useMemo, useState } from 'react';
import {
  Download,
  ArrowLeft,
  FileCode2,
  FileJson,
  BookOpen,
  ShieldCheck,
  Check,
  Copy,
  Subtitles,
} from 'lucide-react';
import { TimelineScene, TranscriptSegment } from '../types/editor';
import {
  buildTimelineJson,
  downloadKurguPaketiZip,
  downloadTextFile,
  generateExportReadme,
  generateRenderPy,
} from '../utils/exportBundle';
import { segmentsToSrt } from '../utils/mediaUtils';
import { formatMMSS, formatZoomSpeedPct } from '../utils/timelineMath';

interface Step3ExportProps {
  audioFileName: string;
  totalAudioDuration: number;
  zoomSpeedPerSec: number;
  burnSubtitles: boolean;
  transcriptSegments: TranscriptSegment[];
  scenes: TimelineScene[];
  onChangeAudioFileName: (name: string) => void;
  onToggleSubtitles: (enabled: boolean) => void;
  onBackToTimeline: () => void;
}

type PreviewTab = 'readme' | 'render' | 'timeline' | 'subtitles';

export const Step3Export: React.FC<Step3ExportProps> = ({
  audioFileName,
  totalAudioDuration,
  zoomSpeedPerSec,
  burnSubtitles,
  transcriptSegments,
  scenes,
  onChangeAudioFileName,
  onToggleSubtitles,
  onBackToTimeline,
}) => {
  const [activeTab, setActiveTab] = useState<PreviewTab>('readme');
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadedOnce, setDownloadedOnce] = useState(false);
  const [copiedTab, setCopiedTab] = useState<PreviewTab | null>(null);

  const hasSubtitlesAvailable = transcriptSegments.length > 0;
  const effectiveBurnSubtitles = burnSubtitles && hasSubtitlesAvailable;
  const packageFileCount = effectiveBurnSubtitles ? 4 : 3;

  const isLosslessAudio = /\.(wav|aif|aiff|flac)$/i.test(audioFileName);
  const outputVideoName = isLosslessAudio ? 'belgesel_1080p.mov' : 'belgesel_1080p.mp4';

  const timelineJsonStr = useMemo(
    () =>
      JSON.stringify(
        buildTimelineJson(
          audioFileName,
          totalAudioDuration,
          zoomSpeedPerSec,
          scenes,
          effectiveBurnSubtitles
        ),
        null,
        2
      ),
    [audioFileName, totalAudioDuration, zoomSpeedPerSec, scenes, effectiveBurnSubtitles]
  );

  const renderPyStr = useMemo(() => generateRenderPy(), []);

  const subtitlesSrtStr = useMemo(
    () => (hasSubtitlesAvailable ? segmentsToSrt(transcriptSegments) : ''),
    [hasSubtitlesAvailable, transcriptSegments]
  );

  const readmeStr = useMemo(
    () =>
      generateExportReadme(
        audioFileName,
        totalAudioDuration,
        scenes.length,
        zoomSpeedPerSec,
        effectiveBurnSubtitles
      ),
    [audioFileName, totalAudioDuration, scenes.length, zoomSpeedPerSec, effectiveBurnSubtitles]
  );

  const currentTab: PreviewTab =
    activeTab === 'subtitles' && !effectiveBurnSubtitles ? 'readme' : activeTab;

  const activeContent =
    currentTab === 'timeline'
      ? timelineJsonStr
      : currentTab === 'render'
        ? renderPyStr
        : currentTab === 'subtitles'
          ? subtitlesSrtStr
          : readmeStr;

  const activeFileName =
    currentTab === 'timeline'
      ? 'timeline.json'
      : currentTab === 'render'
        ? 'render.py'
        : currentTab === 'subtitles'
          ? 'subtitles.srt'
          : 'README.md';

  const handleDownloadZip = async () => {
    setIsDownloading(true);
    try {
      await downloadKurguPaketiZip(
        audioFileName,
        totalAudioDuration,
        zoomSpeedPerSec,
        scenes,
        effectiveBurnSubtitles,
        transcriptSegments
      );
      setDownloadedOnce(true);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleCopyActive = async () => {
    try {
      await navigator.clipboard.writeText(activeContent);
      setCopiedTab(currentTab);
      window.setTimeout(() => setCopiedTab(null), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="mx-auto max-w-[1160px] space-y-8 px-4 py-8 sm:px-6">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 border-b border-white/[0.07] pb-6 sm:flex-row sm:items-end">
        <div className="space-y-1.5">
          <p className="font-mono text-xs uppercase tracking-widest text-[#D99B26]">
            Adım 03 / 03
          </p>
          <h1 className="font-display text-2xl font-medium tracking-tight text-[#F1F5F9] sm:text-3xl">
            16:9 1080p Render Paketini İndir
          </h1>
          <p className="max-w-2xl text-sm text-[#94A3B8]">
            Büyük medya dosyaları yeniden indirilmez. Paket yalnızca {packageFileCount} hafif dosya içerir:{' '}
            <span className="font-mono text-[#CBD5E1]">timeline.json</span>,{' '}
            <span className="font-mono text-[#CBD5E1]">render.py</span>
            {effectiveBurnSubtitles && (
              <>
                , <span className="font-mono text-[#CBD5E1]">subtitles.srt</span>
              </>
            )}{' '}
            ve <span className="font-mono text-[#CBD5E1]">README.md</span>.
          </p>
        </div>

        <button
          type="button"
          onClick={onBackToTimeline}
          className="flex shrink-0 items-center gap-1.5 self-start rounded-md border border-white/[0.1] bg-[#131924] px-3.5 py-2 text-xs font-medium text-[#CBD5E1] transition-colors hover:border-white/[0.2] hover:bg-[#1A2230] hover:text-[#F1F5F9] sm:self-auto"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Zaman Çizelgesine Dön</span>
        </button>
      </div>

      {/* Main Export Card */}
      <section className="rounded-lg border border-white/[0.08] bg-[#131924] p-6">
        <div className="grid grid-cols-2 gap-4 border-b border-white/[0.07] pb-6 sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <p className="text-[11px] text-[#64748B]">Ses Dosyası</p>
            <p
              className="mt-1 truncate font-mono text-xs text-[#F1F5F9]"
              title={audioFileName || 'Sadece görüntü (ses belirtilmedi)'}
            >
              {audioFileName || 'Sadece görüntü'}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-[#64748B]">Toplam Süre</p>
            <p className="mt-1 font-mono text-xs tabular-nums text-[#F1F5F9]">
              {formatMMSS(totalAudioDuration)}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-[#64748B]">Görsel Sayısı</p>
            <p className="mt-1 font-mono text-xs tabular-nums text-[#F1F5F9]">
              {scenes.length} adet
            </p>
          </div>
          <div>
            <p className="text-[11px] text-[#64748B]">Sabit Zoom Hızı</p>
            <p className="mt-1 font-mono text-xs tabular-nums text-[#D99B26]">
              {formatZoomSpeedPct(zoomSpeedPerSec)}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-[#64748B]">Altyazı</p>
            <p className="mt-1 font-mono text-xs text-[#F1F5F9]">
              {effectiveBurnSubtitles ? 'Açık (Gömülü)' : 'Kapalı'}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-[#64748B]">Çıktı Dosyası</p>
            <p className="mt-1 font-mono text-xs text-[#F1F5F9]">{outputVideoName}</p>
          </div>
        </div>

        {/* Optional Burn Subtitles Switch */}
        {hasSubtitlesAvailable && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-white/[0.07] bg-[#0B0F17]/70 px-4 py-3">
            <div className="flex items-start gap-2.5">
              <Subtitles
                className={`mt-0.5 h-4 w-4 shrink-0 ${
                  effectiveBurnSubtitles ? 'text-[#D99B26]' : 'text-[#64748B]'
                }`}
              />
              <div>
                <p className="text-xs font-medium text-[#E2E8F0]">
                  Videoya Altyazı Göm (İsteğe Bağlı)
                </p>
                <p className="mt-0.5 text-[11px] text-[#94A3B8]">
                  Açık olduğunda pakete <span className="font-mono text-[#CBD5E1]">subtitles.srt</span> eklenir ve{' '}
                  <span className="font-mono text-[#CBD5E1]">render.py</span> Türkçe UTF-8 altyazıyı 1080p videonun altına sinematik stille işler.
                </p>
              </div>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={effectiveBurnSubtitles}
              onClick={() => onToggleSubtitles(!burnSubtitles)}
              className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                effectiveBurnSubtitles
                  ? 'border-[#D99B26]/60 bg-[#D99B26]/15 text-[#F1F5F9]'
                  : 'border-white/[0.1] bg-[#131924] text-[#94A3B8] hover:border-white/[0.2] hover:text-[#F1F5F9]'
              }`}
            >
              <span>{effectiveBurnSubtitles ? 'Altyazı Açık' : 'Altyazı Kapalı'}</span>
            </button>
          </div>
        )}

        {/* Optional Local Audio Filename Input (helpful when user uploaded SRT without audio) */}
        <div className="mt-5 flex flex-col justify-between gap-3 rounded-md border border-white/[0.07] bg-[#0B0F17]/70 px-4 py-3 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <label htmlFor="export-audio-filename" className="block text-xs font-medium text-[#E2E8F0]">
              Medya Klasöründeki Ses Dosyası Adı <span className="font-normal text-[#64748B]">(İsteğe bağlı)</span>
            </label>
            <p className="mt-0.5 text-[11px] text-[#94A3B8]">
              Sadece .SRT yüklediyseniz bilgisayarınızdaki ses dosyasının adını buraya yazabilirsiniz (örn.{' '}
              <span className="font-mono text-[#CBD5E1]">belgesel.mp3</span>). Boş bırakırsanız sessiz 16:9 1080p video üretilir.
            </p>
          </div>
          <input
            id="export-audio-filename"
            type="text"
            value={audioFileName}
            onChange={(e) => onChangeAudioFileName(e.target.value)}
            placeholder="örn. belgesel.mp3 (isteğe bağlı)"
            className="w-full shrink-0 rounded-md border border-white/[0.1] bg-[#131924] px-3 py-1.5 font-mono text-xs text-[#F1F5F9] placeholder-[#475569] focus:border-[#D99B26]/60 focus:outline-none sm:w-64"
          />
        </div>

        <div className="mt-6 flex flex-col items-start justify-between gap-5 lg:flex-row lg:items-center">
          <div className="space-y-2 text-xs text-[#94A3B8]">
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#D99B26]" />
              <p className="leading-relaxed">
                {audioFileName.trim() ? (
                  <>
                    <strong className="font-medium text-[#E2E8F0]">Orijinal ses dokunulmadan korunur:</strong>{' '}
                    {isLosslessAudio
                      ? 'Ses dosyanız kayıpsız (.wav/.flac) olduğu için betik sesi sıkıştırmadan (-c:a copy) doğrudan Filmora uyumlu belgesel_1080p.mov oluşturur.'
                      : 'Betik sesi yeniden kodlamadan (-c:a copy) doğrudan Filmora uyumlu belgesel_1080p.mp4 oluşturur.'}
                  </>
                ) : (
                  <>
                    <strong className="font-medium text-[#E2E8F0]">Ses dosyası belirtilmedi:</strong>{' '}
                    Betik yalnızca 16:9 1080p görsel akışını (<span className="font-mono text-[#CBD5E1]">belgesel_1080p.mp4</span>) üretir; Filmora&apos;da doğrudan ses kanalınızın üzerine bırakabilirsiniz.
                  </>
                )}
              </p>
            </div>
            <p className="pl-6 text-[#64748B]">
              ZIP içindeki <span className="font-mono text-[#94A3B8]">timeline.json</span>,{' '}
              <span className="font-mono text-[#94A3B8]">render.py</span>
              {effectiveBurnSubtitles && (
                <>
                  {' '}
                  ve <span className="font-mono text-[#94A3B8]">subtitles.srt</span>
                </>
              )}{' '}
              dosyalarını ses ve görsellerinizin olduğu klasöre bırakıp{' '}
              <span className="font-mono text-[#CBD5E1]">python render.py</span> komutunu çalıştırmanız yeterli.
            </p>
          </div>

          <button
            type="button"
            disabled={isDownloading}
            onClick={handleDownloadZip}
            className="flex w-full shrink-0 items-center justify-center gap-2 rounded-md bg-[#D99B26] px-6 py-3 text-sm font-semibold text-[#0B0F17] transition-colors hover:bg-[#E5AA38] disabled:opacity-60 lg:w-auto"
          >
            {downloadedOnce ? (
              <Check className="h-4 w-4" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            <span>
              {isDownloading
                ? 'Paket Hazırlanıyor...'
                : downloadedOnce
                  ? `kurgu_paketi.zip Tekrar İndir (${packageFileCount} Dosya)`
                  : `kurgu_paketi.zip İndir (${packageFileCount} Dosya)`}
            </span>
          </button>
        </div>
      </section>

      {/* File Inspector Tabs */}
      <section className="overflow-hidden rounded-lg border border-white/[0.08] bg-[#131924]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveTab('readme')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                currentTab === 'readme'
                  ? 'bg-[#1A2230] text-[#F1F5F9]'
                  : 'text-[#94A3B8] hover:text-[#F1F5F9]'
              }`}
            >
              <BookOpen className="h-3.5 w-3.5 text-[#D99B26]" />
              <span>README.md</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('render')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                currentTab === 'render'
                  ? 'bg-[#1A2230] text-[#F1F5F9]'
                  : 'text-[#94A3B8] hover:text-[#F1F5F9]'
              }`}
            >
              <FileCode2 className="h-3.5 w-3.5 text-[#D99B26]" />
              <span>render.py</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('timeline')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                currentTab === 'timeline'
                  ? 'bg-[#1A2230] text-[#F1F5F9]'
                  : 'text-[#94A3B8] hover:text-[#F1F5F9]'
              }`}
            >
              <FileJson className="h-3.5 w-3.5 text-[#D99B26]" />
              <span>timeline.json</span>
            </button>
            {effectiveBurnSubtitles && (
              <button
                type="button"
                onClick={() => setActiveTab('subtitles')}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  currentTab === 'subtitles'
                    ? 'bg-[#1A2230] text-[#F1F5F9]'
                    : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                }`}
              >
                <Subtitles className="h-3.5 w-3.5 text-[#D99B26]" />
                <span>subtitles.srt</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopyActive}
              className="flex items-center gap-1.5 rounded border border-white/[0.08] bg-[#0B0F17] px-2.5 py-1 text-xs text-[#94A3B8] transition-colors hover:border-white/[0.16] hover:text-[#F1F5F9]"
            >
              {copiedTab === currentTab ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-emerald-300">Kopyalandı</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Kopyala</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => downloadTextFile(activeFileName, activeContent)}
              className="flex items-center gap-1.5 rounded border border-white/[0.08] bg-[#0B0F17] px-2.5 py-1 text-xs text-[#94A3B8] transition-colors hover:border-white/[0.16] hover:text-[#F1F5F9]"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Tekil İndir</span>
            </button>
          </div>
        </div>

        <pre className="max-h-[440px] overflow-auto bg-[#0B0F17] p-5 font-mono text-xs leading-relaxed text-[#CBD5E1]">
          {activeContent}
        </pre>
      </section>
    </div>
  );
};
