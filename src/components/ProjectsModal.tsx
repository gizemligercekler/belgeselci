import React, { useRef, useState } from 'react';
import { Download, Plus, Trash2, Upload, X, Check } from 'lucide-react';
import { ProjectRecord } from '../types/studio';
import {
  exportProjectToJsonString,
  importProjectFromJsonString,
} from '../utils/storageDb';
import { triggerBrowserDownload } from '../utils/renderScriptGenerator';

interface ProjectsModalProps {
  open: boolean;
  onClose: () => void;
  projects: ProjectRecord[];
  activeProjectId: string;
  onSelectProject: (id: string) => void;
  onCreateProject: (name: string) => void;
  onDeleteProject: (id: string) => void;
  onImportedProject: (project: ProjectRecord) => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

export const ProjectsModal: React.FC<ProjectsModalProps> = ({
  open,
  onClose,
  projects,
  activeProjectId,
  onSelectProject,
  onCreateProject,
  onDeleteProject,
  onImportedProject,
  onNotify,
}) => {
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const title = newName.trim() || `Yeni Belgesel ${projects.length + 1}`;
    onCreateProject(title);
    setNewName('');
    onClose();
  };

  const handleExportJson = async (proj: ProjectRecord, includeMedia: boolean) => {
    try {
      setBusy(true);
      const json = await exportProjectToJsonString(proj, includeMedia);
      const safeName = proj.name
        .toLowerCase()
        .replace(/[^a-z0-9çğıöşü]+/gi, '_')
        .replace(/^_|_$/g, '');
      const blob = new Blob([json], { type: 'application/json' });
      triggerBrowserDownload(
        blob,
        `${safeName || 'belgesel'}_${includeMedia ? 'tam_yedek' : 'proje'}.json`
      );
      onNotify(
        includeMedia
          ? 'Proje tüm ses/görsellerle birlikte JSON olarak indirildi.'
          : 'Proje metin ve ayar yedeği (JSON) indirildi.'
      );
    } catch (err) {
      onNotify(`JSON dışa aktarılamadı: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setBusy(true);
      const text = await file.text();
      const imported = await importProjectFromJsonString(text);
      onImportedProject(imported);
      onNotify(`"${imported.name}" projesi içe aktarıldı.`);
      onClose();
    } catch (err) {
      onNotify(`JSON içe aktarma hatası: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
      <div className="w-full max-w-2xl bg-[#111722] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="px-6 py-5 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="font-editorial text-xl font-semibold text-slate-100">
              Proje Kütüphanesi
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Tüm projeler, ses dosyaları ve görseller tarayıcı IndexedDB belleğinde kalıcı saklanır.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800/70 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Create New + Import JSON */}
        <div className="p-6 border-b border-slate-800/80 bg-[#0E131D] space-y-3">
          <form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-2.5">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Yeni belgesel proje adı..."
              className="flex-1 bg-[#0B0F17] border border-slate-800 rounded-lg px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#D99B26]/60"
            />
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Yeni Proje</span>
            </button>
          </form>

          <div className="flex items-center justify-between text-xs text-slate-400 pt-1">
            <span>Önceden dışa aktarılmış bir JSON proje yedeğini yükleyebilirsiniz.</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleImportFile}
              className="hidden"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 text-[#F3C669] hover:text-[#FAD78C] font-medium cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>JSON Yedek Yükle</span>
            </button>
          </div>
        </div>

        {/* Project List */}
        <div className="flex-1 overflow-y-auto divide-y divide-slate-800/70">
          {projects.map((p) => {
            const isActive = p.id === activeProjectId;
            const readyAudio = p.chunks.filter((c) => Boolean(c.audioBlobId)).length;
            const readyVisuals = p.scenes.filter(
              (s) => Boolean(s.visualBlobId || s.remoteVideoUrl)
            ).length;

            return (
              <div
                key={p.id}
                className={`px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-colors ${
                  isActive ? 'bg-[#172030]/70' : 'hover:bg-slate-800/30'
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onSelectProject(p.id);
                        onClose();
                      }}
                      className="text-sm font-semibold text-slate-100 hover:text-[#F3C669] truncate text-left cursor-pointer"
                    >
                      {p.name}
                    </button>
                    {isActive && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400">
                        <Check className="w-3 h-3" /> Aktif
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mt-1 font-mono tabular-nums">
                    <span>{p.chunks.length} ses parçası ({readyAudio} hazır)</span>
                    <span aria-hidden="true">·</span>
                    <span>{p.scenes.length} sahne ({readyVisuals} görsel)</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {new Date(p.updatedAt).toLocaleDateString('tr-TR', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => {
                        onSelectProject(p.id);
                        onClose();
                      }}
                      className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg cursor-pointer"
                    >
                      Aç
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleExportJson(p, false)}
                    title="Hızlı JSON Yedek (Metin ve Ayarlar)"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-300 hover:text-white border border-slate-700/80 rounded-lg hover:bg-slate-800 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>JSON</span>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleExportJson(p, true)}
                    title="Tam JSON Yedek (Ses ve Görseller Dahil)"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-300 hover:text-white border border-slate-700/80 rounded-lg hover:bg-slate-800 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Tam</span>
                  </button>
                  {projects.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onDeleteProject(p.id)}
                      title="Projeyi Sil"
                      className="p-1.5 text-slate-500 hover:text-red-400 rounded-lg hover:bg-red-500/10 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
