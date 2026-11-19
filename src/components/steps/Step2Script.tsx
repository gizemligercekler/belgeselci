import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Eraser,
  Loader2,
  PenTool,
  Plus,
  Square,
  Trash2,
  Upload,
  CheckCircle2,
  ListOrdered,
} from 'lucide-react';
import { OutlineChapter, ProjectRecord } from '../../types/studio';
import {
  cleanAiCliches,
  getEffectiveDelayMs,
  sleepWithAbort,
  writeDocumentaryChapter,
} from '../../services/geminiService';

interface Step2ScriptProps {
  project: ProjectRecord;
  onUpdateProject: (updater: (prev: ProjectRecord) => ProjectRecord) => void;
  onNextStep: () => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

type SubTab = 'outline' | 'writer' | 'cleaner';

export const Step2Script: React.FC<Step2ScriptProps> = ({
  project,
  onUpdateProject,
  onNextStep,
  onNotify,
}) => {
  const [subTab, setSubTab] = useState<SubTab>(
    project.rawScript.trim() && project.outline.length === 0 ? 'cleaner' : 'outline'
  );
  const [selectedChapterId, setSelectedChapterId] = useState<string>(
    project.outline[0]?.id || ''
  );
  const [newClicheInput, setNewClicheInput] = useState('');
  const [writingAll, setWritingAll] = useState(false);
  const [writingId, setWritingId] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const selectedChapter =
    project.outline.find((c) => c.id === selectedChapterId) || project.outline[0] || null;

  const detectedCliches = useMemo(() => {
    if (!project.rawScript.trim()) return [];
    const lowerScript = project.rawScript.toLocaleLowerCase('tr-TR');
    return project.bannedCliches
      .map((phrase) => {
        const cleanPhrase = phrase.trim();
        if (!cleanPhrase) return null;
        // Handle template pattern "Sadece X değil, aynı zamanda Y"
        if (/sadece\s+x\s+değil/i.test(cleanPhrase)) {
          const matches = project.rawScript.match(/sadece\s+[^.,;\n]{2,50}\s+değil,?\s+aynı\s+zamanda/gi);
          return matches && matches.length > 0 ? { phrase: cleanPhrase, count: matches.length } : null;
        }
        const escaped = cleanPhrase.toLocaleLowerCase('tr-TR').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(escaped, 'g');
        const matches = lowerScript.match(re);
        return matches && matches.length > 0 ? { phrase: cleanPhrase, count: matches.length } : null;
      })
      .filter((x): x is { phrase: string; count: number } => Boolean(x));
  }, [project.rawScript, project.bannedCliches]);

  const assembleScriptFromOutline = (outline: OutlineChapter[]): string => {
    return outline
      .map((c) => c.draftText.trim())
      .filter(Boolean)
      .join('\n\n---\n\n');
  };

  const renumberOutline = (list: OutlineChapter[]): OutlineChapter[] => {
    let chNum = 0;
    return list.map((item) => {
      if (item.kind === 'chapter') {
        chNum += 1;
        return { ...item, number: chNum };
      }
      return { ...item, number: undefined };
    });
  };

  const updateChapter = (id: string, patch: Partial<OutlineChapter>) => {
    onUpdateProject((prev) => {
      const nextOutline = prev.outline.map((c) => (c.id === id ? { ...c, ...patch } : c));
      return {
        ...prev,
        outline: nextOutline,
        rawScript:
          patch.draftText !== undefined ? assembleScriptFromOutline(nextOutline) : prev.rawScript,
      };
    });
  };

  const moveChapter = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= project.outline.length) return;
    onUpdateProject((prev) => {
      const copy = [...prev.outline];
      const [moved] = copy.splice(index, 1);
      copy.splice(target, 0, moved);
      return { ...prev, outline: renumberOutline(copy) };
    });
  };

  const addChapter = (kind: OutlineChapter['kind'] = 'chapter') => {
    const newCh: OutlineChapter = {
      id: `ch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      kind,
      title:
        kind === 'cold_open'
          ? 'SOĞUK AÇILIŞ'
          : kind === 'conclusion'
            ? 'KAPANIŞ VE DEĞERLENDİRME'
            : 'YENİ BÖLÜM BAŞLIĞI',
      hook: '',
      summaryPoints: '',
      draftText: '',
    };
    onUpdateProject((prev) => ({
      ...prev,
      outline: renumberOutline([...prev.outline, newCh]),
    }));
    setSelectedChapterId(newCh.id);
  };

  const removeChapter = (id: string) => {
    onUpdateProject((prev) => ({
      ...prev,
      outline: renumberOutline(prev.outline.filter((c) => c.id !== id)),
    }));
  };

  const writeSingleChapter = async (chapter: OutlineChapter, outlineSnapshot: OutlineChapter[]) => {
    const idx = outlineSnapshot.findIndex((c) => c.id === chapter.id);
    const prevChapters = outlineSnapshot.slice(0, Math.max(0, idx));
    const prevSummary = prevChapters
      .slice(-2)
      .map((c) => {
        const snippet = c.draftText ? c.draftText.slice(-360) : c.summaryPoints;
        return `- ${c.title}: ${snippet}`;
      })
      .join('\n');

    setWritingId(chapter.id);
    setStatusMessage(`Yazılıyor: ${chapter.title}...`);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const text = await writeDocumentaryChapter(
        project.topicBrief,
        chapter,
        prevSummary,
        project.bannedCliches,
        project.studioSettings,
        {
          signal: controller.signal,
          onKeySwitch: (keyIdx, total) => {
            if (total > 1) setStatusMessage(`Anahtar #${keyIdx}/${total} · Yazılıyor: ${chapter.title}`);
          },
          onRetryWait: (sec) => {
            if (sec > 0) setStatusMessage(`429 Kota beklemesi: ${sec} sn...`);
          },
        }
      );

      let updatedList: OutlineChapter[] = [];
      onUpdateProject((prev) => {
        updatedList = prev.outline.map((c) =>
          c.id === chapter.id ? { ...c, draftText: text, writtenAt: Date.now() } : c
        );
        return {
          ...prev,
          outline: updatedList,
          rawScript: assembleScriptFromOutline(updatedList),
        };
      });
      return text;
    } finally {
      setWritingId(null);
    }
  };

  const handleWriteSelected = async () => {
    if (!selectedChapter) return;
    try {
      await writeSingleChapter(selectedChapter, project.outline);
      onNotify(`"${selectedChapter.title}" bölümü yazıldı.`);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        onNotify((err as Error).message, 'error');
      }
    } finally {
      setStatusMessage('');
    }
  };

  const handleWriteAllSequentially = async () => {
    if (project.outline.length === 0) return;
    setWritingAll(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const workingOutline = project.outline.map((c) => ({ ...c }));
    const delayMs = getEffectiveDelayMs(project.studioSettings);

    try {
      for (let i = 0; i < workingOutline.length; i++) {
        if (controller.signal.aborted) break;
        const ch = workingOutline[i];
        setSelectedChapterId(ch.id);
        setWritingId(ch.id);
        setStatusMessage(`(${i + 1}/${workingOutline.length}) Yazılıyor: ${ch.title}...`);

        const prevSummary = workingOutline
          .slice(Math.max(0, i - 2), i)
          .map((c) => `- ${c.title}: ${c.draftText ? c.draftText.slice(-360) : c.summaryPoints}`)
          .join('\n');

        const text = await writeDocumentaryChapter(
          project.topicBrief,
          ch,
          prevSummary,
          project.bannedCliches,
          project.studioSettings,
          {
            signal: controller.signal,
            onKeySwitch: (keyIdx, total) => {
              if (total > 1) {
                setStatusMessage(
                  `(${i + 1}/${workingOutline.length}) Anahtar #${keyIdx}/${total} · ${ch.title}`
                );
              }
            },
            onRetryWait: (sec) => {
              if (sec > 0) setStatusMessage(`429 Kota beklemesi: ${sec} sn...`);
            },
          }
        );

        workingOutline[i] = { ...ch, draftText: text, writtenAt: Date.now() };
        const snapshot = workingOutline.map((item) => ({ ...item }));
        onUpdateProject((prev) => ({
          ...prev,
          outline: snapshot,
          rawScript: assembleScriptFromOutline(snapshot),
        }));

        if (i + 1 < workingOutline.length && delayMs > 0) {
          await sleepWithAbort(delayMs, controller.signal);
        }
      }
      onNotify('Tüm bölümler sırayla yazıldı ve tam senaryoda birleştirildi.');
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        onNotify('Sıralı bölüm yazımı kullanıcı tarafından durduruldu.');
      } else {
        onNotify((err as Error).message, 'error');
      }
    } finally {
      setWritingAll(false);
      setWritingId(null);
      setStatusMessage('');
      abortRef.current = null;
    }
  };

  const handleStopWriting = () => {
    abortRef.current?.abort();
  };

  const handleCleanCliches = async () => {
    if (!project.rawScript.trim()) {
      onNotify('Temizlenecek senaryo metni bulunamadı.', 'error');
      return;
    }
    setCleaning(true);
    setStatusMessage('YZ klişeleri taranıyor ve akış iyileştiriliyor...');
    try {
      const cleaned = await cleanAiCliches(
        project.rawScript,
        project.bannedCliches,
        project.studioSettings,
        {
          onRetryWait: (sec) => {
            if (sec > 0) setStatusMessage(`Kota beklemesi: ${sec} sn...`);
          },
        }
      );
      onUpdateProject((prev) => ({
        ...prev,
        rawScript: cleaned,
      }));
      onNotify('Senaryo YZ klişelerinden temizlendi; kaynaklar ve etiketler korundu.');
    } catch (err) {
      onNotify((err as Error).message, 'error');
    } finally {
      setCleaning(false);
      setStatusMessage('');
    }
  };

  const handleImportTxt = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    onUpdateProject((prev) => ({ ...prev, rawScript: text }));
    onNotify(`"${file.name}" senaryo editörüne aktarıldı.`);
    if (importFileRef.current) importFileRef.current.value = '';
  };

  const wordCount = project.rawScript.trim()
    ? project.rawScript.trim().split(/\s+/).length
    : 0;

  return (
    <div className="space-y-6">
      {/* Header & Sub-tab Switcher */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-slate-800/80 pb-5">
        <div className="space-y-1.5">
          <p className="text-xs font-mono text-[#D99B26]">Adım 02 · Senaryo Masası</p>
          <h1 className="font-editorial text-3xl font-semibold text-slate-100">
            İskelet, Bölüm Yazımı ve Klişe Temizleyici
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
            <span>{project.outline.length} iskelet bölümü</span>
            <span aria-hidden="true">·</span>
            <span>{wordCount.toLocaleString('tr-TR')} kelime</span>
            <span aria-hidden="true">·</span>
            <span>≈ {Math.max(1, Math.round(wordCount / 125))} dk tahmini okuma</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Interactive Sub-Tabs */}
          <div className="inline-flex items-center p-1 bg-[#131924] border border-slate-800 rounded-xl">
            {(
              [
                { id: 'outline', label: 'A. İskelet', icon: ListOrdered },
                { id: 'writer', label: 'B. Bölüm Yazımı', icon: PenTool },
                { id: 'cleaner', label: 'C. Klişe Temizleyici & Tam Metin', icon: Eraser },
              ] as Array<{ id: SubTab; label: string; icon: React.ComponentType<{ className?: string }> }>
            ).map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSubTab(t.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                    subTab === t.id
                      ? 'bg-[#1F293A] text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            disabled={!project.rawScript.trim()}
            onClick={onNextStep}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] disabled:opacity-40 rounded-xl transition-colors whitespace-nowrap cursor-pointer"
          >
            <span>Ses Stüdyosuna Geç</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {statusMessage && (
        <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl bg-[#161E2E] border border-[#D99B26]/40 text-xs text-slate-200 font-mono">
          <div className="flex items-center gap-2.5">
            <Loader2 className="w-4 h-4 animate-spin text-[#D99B26]" />
            <span>{statusMessage}</span>
          </div>
          {writingAll && (
            <button
              type="button"
              onClick={handleStopWriting}
              className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-500/15 text-red-300 hover:bg-red-500/25 rounded-md cursor-pointer"
            >
              <Square className="w-3 h-3" />
              <span>Durdur</span>
            </button>
          )}
        </div>
      )}

      {/* SUB-TAB A: İSKELET */}
      {subTab === 'outline' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-400">
              Yazıma geçmeden önce bölümleri sıralayın, kancaları (hook) ve başlıkları düzenleyin.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => addChapter('cold_open')}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-slate-300 hover:text-white bg-[#131924] border border-slate-800 rounded-lg cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Soğuk Açılış</span>
              </button>
              <button
                type="button"
                onClick={() => addChapter('chapter')}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-slate-100 bg-[#1A2230] hover:bg-[#232F42] border border-slate-700 rounded-lg cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 text-[#D99B26]" />
                <span>Bölüm Ekle</span>
              </button>
              <button
                type="button"
                onClick={() => addChapter('conclusion')}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-slate-300 hover:text-white bg-[#131924] border border-slate-800 rounded-lg cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Kapanış</span>
              </button>
            </div>
          </div>

          {project.outline.length === 0 ? (
            <div className="bg-[#131924] border border-slate-800 rounded-2xl p-10 text-center space-y-3">
              <p className="text-sm text-slate-300">
                Henüz iskelet oluşturulmadı. Adım 1&apos;den otomatik iskelet üretebilir, yukarıdan
                manuel bölüm ekleyebilir veya <strong>C. Tam Metin</strong> sekmesine hazır
                senaryonuzu yapıştırabilirsiniz.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {project.outline.map((ch, idx) => (
                <div
                  key={ch.id}
                  className="bg-[#131924] border border-slate-800/80 rounded-xl p-5 space-y-3"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <span className="font-mono text-xs text-[#D99B26] whitespace-nowrap">
                        {ch.kind === 'cold_open'
                          ? 'SOĞUK AÇILIŞ'
                          : ch.kind === 'conclusion'
                            ? 'KAPANIŞ'
                            : `BÖLÜM ${ch.number}`}
                      </span>
                      <input
                        type="text"
                        value={ch.title}
                        onChange={(e) => updateChapter(ch.id, { title: e.target.value })}
                        className="flex-1 bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-100 focus:outline-none focus:border-[#D99B26]/60"
                      />
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {ch.draftText.trim() && (
                        <span className="text-xs text-emerald-400 mr-2 flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Yazıldı
                        </span>
                      )}
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => moveChapter(idx, -1)}
                        title="Yukarı taşı"
                        className="p-1.5 text-slate-400 hover:text-white disabled:opacity-30 rounded-md hover:bg-slate-800 cursor-pointer"
                      >
                        <ArrowUp className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === project.outline.length - 1}
                        onClick={() => moveChapter(idx, 1)}
                        title="Aşağı taşı"
                        className="p-1.5 text-slate-400 hover:text-white disabled:opacity-30 rounded-md hover:bg-slate-800 cursor-pointer"
                      >
                        <ArrowDown className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeChapter(ch.id)}
                        title="Bölümü sil"
                        className="p-1.5 text-slate-500 hover:text-red-400 rounded-md hover:bg-red-500/10 cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Bölüm Kancası (Hook)
                      </label>
                      <input
                        type="text"
                        value={ch.hook}
                        onChange={(e) => updateChapter(ch.id, { hook: e.target.value })}
                        placeholder="İzleyiciyi bu bölüme bağlayan açılış sorusu..."
                        className="w-full bg-[#0B0F17] border border-slate-800/80 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-[#D99B26]/60"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">
                        İşlenecek Kanıtlar ve Ana Noktalar
                      </label>
                      <input
                        type="text"
                        value={ch.summaryPoints}
                        onChange={(e) => updateChapter(ch.id, { summaryPoints: e.target.value })}
                        placeholder="Tarihsel kaynaklar, ayet/belge referansları..."
                        className="w-full bg-[#0B0F17] border border-slate-800/80 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-[#D99B26]/60"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* SUB-TAB B: BÖLÜM BÖLÜM YAZIM */}
      {subTab === 'writer' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Chapter Sidebar */}
          <div className="lg:col-span-4 bg-[#131924] border border-slate-800/80 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-800/80">
              <h2 className="text-sm font-semibold text-slate-200">Bölümler</h2>
              <button
                type="button"
                disabled={writingAll || project.outline.length === 0}
                onClick={handleWriteAllSequentially}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] disabled:opacity-50 rounded-lg cursor-pointer"
              >
                {writingAll ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <PenTool className="w-3.5 h-3.5" />
                )}
                <span>Tümünü Sırayla Yaz</span>
              </button>
            </div>

            {project.outline.length === 0 ? (
              <p className="text-xs text-slate-400 py-4">
                Önce &quot;A. İskelet&quot; sekmesinden bölüm ekleyin.
              </p>
            ) : (
              <div className="space-y-1.5">
                {project.outline.map((ch) => {
                  const active = selectedChapter?.id === ch.id;
                  const words = ch.draftText.trim()
                    ? ch.draftText.trim().split(/\s+/).length
                    : 0;
                  return (
                    <button
                      key={ch.id}
                      type="button"
                      onClick={() => setSelectedChapterId(ch.id)}
                      className={`w-full text-left p-3 rounded-xl border transition-colors cursor-pointer ${
                        active
                          ? 'bg-[#1A2230] border-[#D99B26]/60 text-white'
                          : 'bg-[#0E131D] border-transparent hover:border-slate-800 text-slate-300'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
                        <span className="text-[#D99B26]">
                          {ch.kind === 'cold_open'
                            ? 'SOĞUK AÇILIŞ'
                            : ch.kind === 'conclusion'
                              ? 'KAPANIŞ'
                              : `BÖLÜM ${ch.number}`}
                        </span>
                        <span className="text-slate-400 tabular-nums">
                          {writingId === ch.id ? 'Yazılıyor...' : words > 0 ? `${words} kelime` : 'Taslak boş'}
                        </span>
                      </div>
                      <div className="text-xs font-medium mt-1 truncate">{ch.title}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Active Chapter Editor */}
          <div className="lg:col-span-8 bg-[#131924] border border-slate-800/80 rounded-2xl p-6 space-y-4">
            {selectedChapter ? (
              <>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
                  <div>
                    <h3 className="font-editorial text-xl font-semibold text-slate-100">
                      {selectedChapter.title}
                    </h3>
                    {selectedChapter.hook && (
                      <p className="text-xs text-slate-400 mt-1">{selectedChapter.hook}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={Boolean(writingId) || writingAll}
                    onClick={handleWriteSelected}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] disabled:opacity-50 rounded-lg whitespace-nowrap cursor-pointer"
                  >
                    {writingId === selectedChapter.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <PenTool className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {selectedChapter.draftText.trim()
                        ? 'Seçili Bölümü Yeniden Yaz'
                        : 'Seçili Bölümü Yaz'}
                    </span>
                  </button>
                </div>

                <div className="text-xs text-slate-400 bg-[#0B0F17] border border-slate-800/80 rounded-lg px-3.5 py-2.5 font-mono">
                  Yönetmen Etiketleri: <span className="text-slate-200">[[BOLUM: Başlık]]</span> ·{' '}
                  <span className="text-slate-200">[[AYET: En&apos;âm:38 | Metin]]</span> ·{' '}
                  <span className="text-slate-200">[[ETIKET: Hûd:114 ve İsrâ:78]]</span>
                </div>

                <textarea
                  rows={18}
                  value={selectedChapter.draftText}
                  onChange={(e) => updateChapter(selectedChapter.id, { draftText: e.target.value })}
                  placeholder="Bu bölümün metni burada oluşacak. Dilediğiniz gibi elle düzenleyebilirsiniz..."
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded-xl p-4 text-[15px] leading-relaxed text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-[#D99B26]/60"
                />
              </>
            ) : (
              <p className="text-sm text-slate-400 py-10 text-center">
                Düzenlemek için sol taraftan bir bölüm seçin.
              </p>
            )}
          </div>
        </div>
      )}

      {/* SUB-TAB C: YZ KLİŞE TEMİZLEYİCİ & TAM SENARYO */}
      {subTab === 'cleaner' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Banned Cliché List & Scanner */}
          <div className="lg:col-span-4 bg-[#131924] border border-slate-800/80 rounded-2xl p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">Yasaklı YZ Klişeleri</h2>
              <p className="text-xs text-slate-400 mt-1">
                Metinde tespit edilen yapay kalıplar temizlenirken tüm tarihsel gerçekler ve
                yönetmen etiketleri korunur.
              </p>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const val = newClicheInput.trim();
                if (!val) return;
                onUpdateProject((prev) => ({
                  ...prev,
                  bannedCliches: [val, ...prev.bannedCliches],
                }));
                setNewClicheInput('');
              }}
              className="flex gap-2"
            >
              <input
                type="text"
                value={newClicheInput}
                onChange={(e) => setNewClicheInput(e.target.value)}
                placeholder="Yeni yasaklı kalıp ekle..."
                className="flex-1 bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-[#D99B26]/60"
              />
              <button
                type="submit"
                className="px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg cursor-pointer"
              >
                Ekle
              </button>
            </form>

            {/* Detection Summary */}
            <div className="p-3 rounded-xl bg-[#0B0F17] border border-slate-800/80 space-y-1.5">
              <div className="text-xs font-medium text-slate-300">
                Anlık Tarama:{' '}
                <span
                  className={
                    detectedCliches.length > 0 ? 'text-amber-400 font-mono' : 'text-emerald-400'
                  }
                >
                  {detectedCliches.length > 0
                    ? `${detectedCliches.reduce((a, b) => a + b.count, 0)} klişe eşleşmesi`
                    : 'Yasaklı klişe tespit edilmedi'}
                </span>
              </div>
              {detectedCliches.length > 0 && (
                <ul className="space-y-1 pt-1">
                  {detectedCliches.map((d) => (
                    <li
                      key={d.phrase}
                      className="text-xs text-amber-300/90 flex items-center justify-between gap-2"
                    >
                      <span className="truncate">{d.phrase}</span>
                      <span className="font-mono tabular-nums text-[11px]">{d.count}x</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="max-h-60 overflow-y-auto divide-y divide-slate-800/60 border-t border-slate-800/60">
              {project.bannedCliches.map((item, idx) => (
                <div
                  key={`${item}_${idx}`}
                  className="py-2 flex items-center justify-between gap-2 text-xs text-slate-300"
                >
                  <span className="truncate">{item}</span>
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateProject((prev) => ({
                        ...prev,
                        bannedCliches: prev.bannedCliches.filter((_, i) => i !== idx),
                      }))
                    }
                    className="text-slate-500 hover:text-red-400 p-1 cursor-pointer"
                    title="Listeden çıkar"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <button
              type="button"
              disabled={cleaning || !project.rawScript.trim()}
              onClick={handleCleanCliches}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] disabled:opacity-50 rounded-xl cursor-pointer"
            >
              {cleaning ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Eraser className="w-4 h-4" />
              )}
              <span>{cleaning ? 'Temizleniyor...' : 'Klişeleri Tara ve Temizle (AI)'}</span>
            </button>
          </div>

          {/* Full Raw Script Editor */}
          <div className="lg:col-span-8 bg-[#131924] border border-slate-800/80 rounded-2xl p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
              <div>
                <h2 className="font-editorial text-xl font-semibold text-slate-100">
                  Tam Belgesel Senaryosu
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Dışarıda yazdığınız metni doğrudan buraya yapıştırabilir veya .txt yükleyebilirsiniz.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {project.outline.some((c) => c.draftText.trim()) && (
                  <button
                    type="button"
                    onClick={() => {
                      const merged = assembleScriptFromOutline(project.outline);
                      onUpdateProject((prev) => ({ ...prev, rawScript: merged }));
                      onNotify('Bölüm taslakları tam senaryo alanına aktarıldı.');
                    }}
                    className="px-3 py-1.5 text-xs text-slate-300 hover:text-white border border-slate-700 rounded-lg cursor-pointer"
                  >
                    Bölümlerden Birleştir
                  </button>
                )}
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".txt,.md,text/plain"
                  onChange={handleImportTxt}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => importFileRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>script.txt İçe Aktar</span>
                </button>
              </div>
            </div>

            <textarea
              rows={22}
              value={project.rawScript}
              onChange={(e) =>
                onUpdateProject((prev) => ({ ...prev, rawScript: e.target.value }))
              }
              placeholder="Belgesel senaryonuzu buraya yazın veya yapıştırın...&#10;&#10;Örnek:&#10;### BÖLÜM 1: BAŞLIK&#10;[[AYET: En'âm:38 | Biz kitapta hiçbir şeyi eksik bırakmadık.]]"
              className="w-full bg-[#0B0F17] border border-slate-800 rounded-xl p-4 text-[15px] leading-relaxed text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-[#D99B26]/60"
            />
          </div>
        </div>
      )}
    </div>
  );
};
