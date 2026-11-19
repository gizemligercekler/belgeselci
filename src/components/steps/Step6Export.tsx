import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Code2,
  Download,
  FileText,
  FolderArchive,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { ProjectRecord } from '../../types/studio';
import {
  buildProductionBundleZip,
  generateRenderPythonScript,
  generateTurkishReadme,
  triggerBrowserDownload,
} from '../../utils/renderScriptGenerator';
import { formatDurationClock } from '../../utils/wavEncoder';

interface Step6ExportProps {
  project: ProjectRecord;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

export const Step6Export: React.FC<Step6ExportProps> = ({ project, onNotify }) => {
  const [previewTab, setPreviewTab] = useState<'python' | 'readme'>('python');
  const [exporting, setExporting] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');

  const pythonScript = useMemo(() => generateRenderPythonScript(project), [project]);
  const readmeText = useMemo(() => generateTurkishReadme(project), [project]);

  const readyAudioCount = project.chunks.filter((c) => Boolean(c.audioBlobId)).length;
  const readyVisualCount = project.scenes.filter(
    (s) => Boolean(s.visualBlobId || s.remoteVideoUrl)
  ).length;
  const totalAudioSec = project.chunks.reduce((acc, c) => acc + (c.durationSec || 0), 0);

  const safeSlug =
    project.name
      .toLowerCase()
      .replace(/[^a-z0-9çğıöşü]+/gi, '_')
      .replace(/^_|_$/g, '') || 'belgesel_paketi';

  const handleDownloadZipBundle = async () => {
    setExporting(true);
    setProgressPct(0);
    setProgressLabel('Paket hazırlanıyor...');
    try {
      const zipBlob = await buildProductionBundleZip(project, (pct, label) => {
        setProgressPct(pct);
        setProgressLabel(label);
      });
      triggerBrowserDownload(zipBlob, `${safeSlug}_render_paketi.zip`);
      onNotify('Tam üretim paketi (.ZIP) başarıyla indirildi!');
    } catch (err) {
      onNotify(`ZIP oluşturma hatası: ${(err as Error).message}`, 'error');
    } finally {
      setExporting(false);
    }
  };

  const handleDownloadSingleFile = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    triggerBrowserDownload(blob, filename);
    onNotify(`${filename} indirildi.`);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-slate-800/80 pb-5">
        <div className="space-y-1.5 max-w-2xl">
          <p className="text-xs font-mono text-[#D99B26]">Adım 06 · Dışa Aktar &amp; Yerel Render</p>
          <h1 className="font-editorial text-3xl font-semibold text-slate-100">
            Üretim Paketi (ZIP) ve Yerel FFmpeg Render Betiği
          </h1>
          <p className="text-sm text-slate-400">
            Uzun metraj 1080p/4K videoları tarayıcı bellek sınırına takılmadan bilgisayarınızda tek
            komutla birleştirin: <code className="font-mono text-slate-200">python render_documentary.py</code>
          </p>
        </div>

        <button
          type="button"
          disabled={exporting}
          onClick={handleDownloadZipBundle}
          className="inline-flex items-center justify-center gap-2.5 px-6 py-3 text-sm font-semibold text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] disabled:opacity-50 rounded-xl transition-colors whitespace-nowrap cursor-pointer self-start lg:self-auto"
        >
          {exporting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <FolderArchive className="w-4 h-4" />
          )}
          <span>{exporting ? `Hazırlanıyor (%${progressPct})` : 'Tüm Üretim Paketini İndir (.ZIP)'}</span>
        </button>
      </div>

      {/* Export Progress Bar */}
      {exporting && (
        <div className="bg-[#161E2E] border border-[#D99B26]/40 rounded-2xl p-4 space-y-2">
          <div className="flex items-center justify-between text-xs font-mono text-slate-200">
            <span>{progressLabel}</span>
            <span className="tabular-nums">%{progressPct}</span>
          </div>
          <div className="w-full h-2 bg-[#0B0F17] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#D99B26] transition-all duration-200"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Readiness Summary Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#131924] border border-slate-800/80 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-400">Ses Parçaları (audio/*.wav)</div>
          <div className="text-xl font-mono tabular-nums font-semibold text-slate-100">
            {readyAudioCount} / {project.chunks.length}
          </div>
          <div className="text-xs font-mono text-slate-500">
            Toplam Süre: {formatDurationClock(totalAudioSec)}
          </div>
        </div>

        <div className="bg-[#131924] border border-slate-800/80 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-400">Sahne Görselleri (visuals/*)</div>
          <div className="text-xl font-mono tabular-nums font-semibold text-slate-100">
            {readyVisualCount} / {project.scenes.length}
          </div>
          <div className="text-xs text-slate-500">
            {project.scenes.length - readyVisualCount === 0 && project.scenes.length > 0
              ? 'Tüm sahneler eksiksiz'
              : 'Eksik sahneler koyu fonla doldurulur'}
          </div>
        </div>

        <div className="bg-[#131924] border border-slate-800/80 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-400">Çıktı Video Profili</div>
          <div className="text-xl font-mono tabular-nums font-semibold text-slate-100">
            {project.editSettings.resolution}
          </div>
          <div className="text-xs font-mono text-slate-500">
            {project.editSettings.fps} FPS · Crossfade {project.editSettings.transitionDurationSec}s
          </div>
        </div>

        <div className="bg-[#131924] border border-slate-800/80 rounded-xl p-4 space-y-1">
          <div className="text-xs text-slate-400">Ses İşleme &amp; Hizalama</div>
          <div className="text-sm font-mono font-semibold text-slate-100 pt-1">
            {project.studioSettings.gentleNormalize ? '-16 LUFS + 10ms Fade' : 'Ham Ses'}
          </div>
          <div className="text-xs font-mono text-slate-500">
            Duraklama: {project.studioSettings.normalPauseMs}ms / {project.studioSettings.chapterPauseMs}ms
          </div>
        </div>
      </div>

      {/* Bundle Contents & Quick Warnings */}
      <div className="bg-[#131924] border border-slate-800/80 rounded-2xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-2 text-xs text-slate-300">
          <div className="font-semibold text-slate-100">ZIP Paketi İçeriği</div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-slate-400">
            <span className="inline-flex items-center gap-1.5 text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5" /> project_manifest.json
            </span>
            <span className="inline-flex items-center gap-1.5 text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5" /> render_documentary.py
            </span>
            <span className="inline-flex items-center gap-1.5 text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5" /> README.md
            </span>
            <span>audio/ ({readyAudioCount} dosya)</span>
            <span>visuals/ ({readyVisualCount} dosya)</span>
          </div>
          {(readyAudioCount < project.chunks.length || readyVisualCount < project.scenes.length) && (
            <div className="flex items-center gap-2 text-amber-300/90 pt-1">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                Bazı ses parçaları veya sahne görselleri henüz üretilmemiş. Yine de paketi şimdi
                indirebilir veya önceki adımlara dönüp tamamlayabilirsiniz.
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() =>
              handleDownloadSingleFile(pythonScript, 'render_documentary.py', 'text/x-python')
            }
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>render_documentary.py</span>
          </button>
          <button
            type="button"
            onClick={() =>
              handleDownloadSingleFile(readmeText, 'README.md', 'text/markdown;charset=utf-8')
            }
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>README.md</span>
          </button>
        </div>
      </div>

      {/* Preview Tabs for Python Script & README */}
      <div className="bg-[#131924] border border-slate-800/80 rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div className="inline-flex items-center p-1 bg-[#0B0F17] border border-slate-800 rounded-lg">
            <button
              type="button"
              onClick={() => setPreviewTab('python')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                previewTab === 'python' ? 'bg-[#1F293A] text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" />
              <span>render_documentary.py</span>
            </button>
            <button
              type="button"
              onClick={() => setPreviewTab('readme')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                previewTab === 'readme' ? 'bg-[#1F293A] text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>README.md (Türkçe Kılavuz)</span>
            </button>
          </div>
          <span className="text-[11px] font-mono text-slate-500">
            Ayarlarınıza göre otomatik güncellenir
          </span>
        </div>

        <div className="p-5 bg-[#0B0F17] max-h-[460px] overflow-auto">
          <pre className="text-xs font-mono leading-relaxed text-slate-300 whitespace-pre-wrap">
            {previewTab === 'python' ? pythonScript : readmeText}
          </pre>
        </div>
      </div>
    </div>
  );
};
