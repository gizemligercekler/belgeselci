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
} from 'lucide-react';
import { TimelineScene } from '../types/editor';
import {
  buildTimelineJson,
  downloadKurguPaketiZip,
  downloadTextFile,
  generateExportReadme,
  generateRenderPy,
} from '../utils/exportBundle';
import { formatMMSS, formatZoomSpeedPct } from '../utils/timelineMath';

interface Step3ExportProps {
  audioFileName: string;
  totalAudioDuration: number;
  zoomSpeedPerSec: number;
  scenes: TimelineScene[];
  onBackToTimeline: () => void;
}

type PreviewTab = 'readme' | 'render' | 'timeline';

export const Step3Export: React.FC<Step3ExportProps> = ({
  audioFileName,
  totalAudioDuration,
  zoomSpeedPerSec,
  scenes,
  onBackToTimeline,
}) => {
  const [activeTab, setActiveTab] = useState<PreviewTab>('readme');
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadedOnce, setDownloadedOnce] = useState(false);
  const [copiedTab, setCopiedTab] = useState<PreviewTab | null>(null);

  const isLosslessAudio = /\.(wav|aif|aiff|flac)$/i.test(audioFileName);
  const outputVideoName = isLosslessAudio ? 'belgesel_1080p.mov' : 'belgesel_1080p.mp4';

  const timelineJsonStr = useMemo(
    () =>
      JSON.stringify(
        buildTimelineJson(audioFileName, totalAudioDuration, zoomSpeedPerSec, scenes),
        null,
        2
      ),
    [audioFileName, totalAudioDuration, zoomSpeedPerSec, scenes]
  );

  const renderPyStr = useMemo(() => generateRenderPy(), []);

  const readmeStr = useMemo(
    () => generateExportReadme(audioFileName, totalAudioDuration, scenes.length, zoomSpeedPerSec),
    [audioFileName, totalAudioDuration, scenes.length, zoomSpeedPerSec]
  );

  const activeContent =
    activeTab === 'timeline'
      ? timelineJsonStr
      : activeTab === 'render'
        ? renderPyStr
        : readmeStr;

  const activeFileName =
    activeTab === 'timeline'
      ? 'timeline.json'
      : activeTab === 'render'
        ? 'render.py'
        : 'README.md';

  const handleDownloadZip = async () => {
    setIsDownloading(true);
    try {
      await downloadKurguPaketiZip(audioFileName, totalAudioDuration, zoomSpeedPerSec, scenes);
      setDownloadedOnce(true);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleCopyActive = async () => {
    try {
      await navigator.clipboard.writeText(activeContent);
      setCopiedTab(activeTab);
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
            Büyük medya dosyaları yeniden indirilmez. Paket yalnızca 3 hafif dosya içerir:{' '}
            <span className="font-mono text-[#CBD5E1]">timeline.json</span>,{' '}
            <span className="font-mono text-[#CBD5E1]">render.py</span> ve{' '}
            <span className="font-mono text-[#CBD5E1]">README.md</span>.
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
            <p className="mt-1 truncate font-mono text-xs text-[#F1F5F9]" title={audioFileName}>
              {audioFileName}
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
            <p className="text-[11px] text-[#64748B]">Video Formatı</p>
            <p className="mt-1 font-mono text-xs tabular-nums text-[#F1F5F9]">
              1920×1080 · 30fps
            </p>
          </div>
          <div>
            <p className="text-[11px] text-[#64748B]">Çıktı Dosyası</p>
            <p className="mt-1 font-mono text-xs text-[#F1F5F9]">{outputVideoName}</p>
          </div>
        </div>

        <div className="mt-6 flex flex-col items-start justify-between gap-5 lg:flex-row lg:items-center">
          <div className="space-y-2 text-xs text-[#94A3B8]">
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#D99B26]" />
              <p className="leading-relaxed">
                <strong className="font-medium text-[#E2E8F0]">Orijinal ses dokunulmadan korunur:</strong>{' '}
                {isLosslessAudio
                  ? 'Ses dosyanız kayıpsız (.wav/.flac) olduğu için betik sesi sıkıştırmadan (-c:a copy) doğrudan Filmora uyumlu belgesel_1080p.mov oluşturur.'
                  : 'Betik sesi yeniden kodlamadan (-c:a copy) doğrudan Filmora uyumlu belgesel_1080p.mp4 oluşturur.'}
              </p>
            </div>
            <p className="pl-6 text-[#64748B]">
              ZIP içindeki <span className="font-mono text-[#94A3B8]">timeline.json</span> ve{' '}
              <span className="font-mono text-[#94A3B8]">render.py</span> dosyalarını ses ve görsellerinizin
              olduğu klasöre bırakıp <span className="font-mono text-[#CBD5E1]">python render.py</span> komutunu çalıştırmanız yeterli.
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
                  ? 'kurgu_paketi.zip Tekrar İndir'
                  : 'kurgu_paketi.zip İndir (3 Dosya)'}
            </span>
          </button>
        </div>
      </section>

      {/* File Inspector Tabs */}
      <section className="overflow-hidden rounded-lg border border-white/[0.08] bg-[#131924]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] px-4 py-2.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveTab('readme')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                activeTab === 'readme'
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
                activeTab === 'render'
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
                activeTab === 'timeline'
                  ? 'bg-[#1A2230] text-[#F1F5F9]'
                  : 'text-[#94A3B8] hover:text-[#F1F5F9]'
              }`}
            >
              <FileJson className="h-3.5 w-3.5 text-[#D99B26]" />
              <span>timeline.json</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopyActive}
              className="flex items-center gap-1.5 rounded border border-white/[0.08] bg-[#0B0F17] px-2.5 py-1 text-xs text-[#94A3B8] transition-colors hover:border-white/[0.16] hover:text-[#F1F5F9]"
            >
              {copiedTab === activeTab ? (
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
