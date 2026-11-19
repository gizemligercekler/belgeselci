import React, { useRef, useState } from 'react';
import { ArrowRight, FileText, Loader2, Sparkles, Upload } from 'lucide-react';
import { ProjectRecord } from '../../types/studio';
import { generateDocumentaryOutline } from '../../services/geminiService';

interface Step1TopicProps {
  project: ProjectRecord;
  onUpdateProject: (updater: (prev: ProjectRecord) => ProjectRecord) => void;
  onLoadDemo: () => void;
  onNextStep: () => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

export const Step1Topic: React.FC<Step1TopicProps> = ({
  project,
  onUpdateProject,
  onLoadDemo,
  onNextStep,
  onNotify,
}) => {
  const [loading, setLoading] = useState(false);
  const [statusNote, setStatusNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const { topicBrief, studioSettings } = project;

  const updateBrief = (patch: Partial<ProjectRecord['topicBrief']>) => {
    onUpdateProject((prev) => ({
      ...prev,
      topicBrief: { ...prev.topicBrief, ...patch },
    }));
  };

  const handleGenerateOutline = async () => {
    if (!topicBrief.topic.trim()) {
      onNotify('Lütfen önce belgesel konusunu yazın.', 'error');
      return;
    }
    setLoading(true);
    setStatusNote(`İskelet oluşturuluyor (${studioSettings.scriptModel})...`);
    try {
      const outline = await generateDocumentaryOutline(topicBrief, studioSettings, {
        onKeySwitch: (idx, total) => {
          if (total > 1) setStatusNote(`Anahtar #${idx}/${total} ile iskelet hazırlanıyor...`);
        },
        onRetryWait: (sec) => {
          if (sec > 0) setStatusNote(`Kota beklemesi: ${sec} sn sonra yeniden denenecek...`);
        },
      });

      onUpdateProject((prev) => ({
        ...prev,
        name:
          prev.name === 'Yeni Belgesel Projesi'
            ? topicBrief.topic.slice(0, 64)
            : prev.name,
        outline,
        activeStep: 2,
      }));
      onNotify(`${outline.length} bölümlük belgesel iskeleti oluşturuldu.`);
      onNextStep();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setLoading(false);
      setStatusNote('');
    }
  };

  const handleImportScriptTxt = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      onUpdateProject((prev) => ({
        ...prev,
        rawScript: text,
        activeStep: 2,
      }));
      onNotify(`"${file.name}" içe aktarıldı. Adım 2'de inceleyebilirsiniz.`);
      onNextStep();
    } catch (err) {
      onNotify(`Dosya okunamadı: ${(err as Error).message}`, 'error');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header Row */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-slate-800/80 pb-6">
        <div className="space-y-2 max-w-2xl">
          <p className="text-xs font-mono text-[#D99B26]">Adım 01 · Hazırlık ve Araştırma</p>
          <h1 className="font-editorial text-3xl sm:text-4xl font-semibold text-slate-100 tracking-tight">
            Konu, Bakış Açısı ve Kaynaklar
          </h1>
          <p className="text-sm text-slate-400 leading-relaxed">
            30–60 dakikalık BBC belgeselinizin omurgasını belirleyin. İskelet üretildikten sonra
            her bölümü onaylayıp düzenlemeden sonraki aşamaya geçilmez.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onLoadDemo}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-slate-100 bg-[#1A2230] hover:bg-[#232E40] border border-slate-700/80 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            <FileText className="w-4 h-4 text-[#D99B26]" />
            <span>Demo / Test Metni Yükle</span>
          </button>

          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,text/plain"
            onChange={handleImportScriptTxt}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-2 px-3.5 py-2.5 text-xs font-medium text-slate-300 hover:text-white border border-slate-800 hover:border-slate-700 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            <Upload className="w-4 h-4 text-slate-400" />
            <span>Hazır script.txt Yükle</span>
          </button>
        </div>
      </div>

      {/* Main Brief Form */}
      <div className="bg-[#131924] border border-slate-800/80 rounded-2xl p-6 sm:p-8 space-y-6">
        <div className="space-y-2">
          <label htmlFor="doc-topic" className="block text-sm font-medium text-slate-200">
            Belgesel Konusu
          </label>
          <input
            id="doc-topic"
            type="text"
            value={topicBrief.topic}
            onChange={(e) => updateBrief({ topic: e.target.value })}
            placeholder="Örn: Antik Kutsal Metinlerin Yazıya Geçişi ve İlk El Yazmaları"
            className="w-full bg-[#0B0F17] border border-slate-800 rounded-xl px-4 py-3 text-base text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-[#D99B26]/70"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="space-y-2">
            <label htmlFor="doc-duration" className="block text-sm font-medium text-slate-200">
              Hedef Süre (Dakika)
            </label>
            <div className="flex items-center gap-3">
              <input
                id="doc-duration"
                type="number"
                min={5}
                max={120}
                value={topicBrief.targetMinutes}
                onChange={(e) =>
                  updateBrief({ targetMinutes: Math.max(5, Math.min(120, Number(e.target.value) || 30)) })
                }
                className="w-28 bg-[#0B0F17] border border-slate-800 rounded-xl px-4 py-3 text-sm font-mono tabular-nums text-slate-100 focus:outline-none focus:border-[#D99B26]/70"
              />
              <span className="text-xs text-slate-400 font-mono tabular-nums">
                ≈ {(topicBrief.targetMinutes * 125).toLocaleString('tr-TR')} kelime
              </span>
            </div>
          </div>

          <div className="md:col-span-2 space-y-2">
            <label htmlFor="doc-tone" className="block text-sm font-medium text-slate-200">
              Anlatım Tonu ve Bakış Açısı
            </label>
            <input
              id="doc-tone"
              type="text"
              value={topicBrief.toneAndAngle}
              onChange={(e) => updateBrief({ toneAndAngle: e.target.value })}
              placeholder="Ağırbaşlı, sakin, akademik kanıtlara dayalı BBC belgesel üslubu..."
              className="w-full bg-[#0B0F17] border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-[#D99B26]/70"
            />
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="doc-sources" className="block text-sm font-medium text-slate-200">
            Kaynak Notları, Tezler ve Özellikle Değinilecek Noktalar{' '}
            <span className="text-slate-500 font-normal">(Opsiyonel)</span>
          </label>
          <textarea
            id="doc-sources"
            rows={5}
            value={topicBrief.sourceNotes}
            onChange={(e) => updateBrief({ sourceNotes: e.target.value })}
            placeholder="Tarihçiler, el yazması adları, ayet/kaynak referansları, belgeselin savunduğu ana tez veya çürütmek istediğiniz yanlış kabuller..."
            className="w-full bg-[#0B0F17] border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200 placeholder:text-slate-600 leading-relaxed focus:outline-none focus:border-[#D99B26]/70"
          />
        </div>

        {/* Action Bar */}
        <div className="pt-4 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="text-xs text-slate-400 font-mono">
            {statusNote || (
              <>
                Aktif Model: <span className="text-slate-200">{studioSettings.scriptModel}</span> ·
                Kota Modu:{' '}
                <span className="text-slate-200">
                  {studioSettings.tierMode === 'free' ? 'Free Tier' : 'Paid Tier'}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-3">
            {project.outline.length > 0 || project.rawScript.trim().length > 0 ? (
              <button
                type="button"
                onClick={onNextStep}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-200 hover:text-white border border-slate-700 rounded-xl hover:bg-slate-800/70 transition-colors cursor-pointer"
              >
                <span>Adım 2&apos;ye Geç</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : null}

            <button
              type="button"
              disabled={loading}
              onClick={handleGenerateOutline}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] disabled:opacity-60 rounded-xl transition-colors whitespace-nowrap cursor-pointer"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              <span>{loading ? 'Oluşturuluyor...' : 'İskelet Önerisi Oluştur'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
