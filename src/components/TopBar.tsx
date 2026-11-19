import React, { useState } from 'react';
import {
  BookOpen,
  Check,
  FolderOpen,
  Settings,
  Pencil,
} from 'lucide-react';
import { ProjectRecord, WizardStep } from '../types/studio';

interface TopBarProps {
  project: ProjectRecord;
  activeStep: WizardStep;
  onSelectStep: (step: WizardStep) => void;
  onRenameProject: (newName: string) => void;
  onOpenProjects: () => void;
  onOpenReadme: () => void;
  onOpenSettings: () => void;
  completedSteps: Record<WizardStep, boolean>;
}

const STEPS: Array<{ step: WizardStep; shortTitle: string; label: string }> = [
  { step: 1, shortTitle: '01', label: 'Konu & Kaynaklar' },
  { step: 2, shortTitle: '02', label: 'İskelet & Senaryo' },
  { step: 3, shortTitle: '03', label: 'Ses Stüdyosu (TTS)' },
  { step: 4, shortTitle: '04', label: 'Görsel & Storyboard' },
  { step: 5, shortTitle: '05', label: 'Kurgu & Önizleme' },
  { step: 6, shortTitle: '06', label: 'Dışa Aktar & Render' },
];

export const TopBar: React.FC<TopBarProps> = ({
  project,
  activeStep,
  onSelectStep,
  onRenameProject,
  onOpenProjects,
  onOpenReadme,
  onOpenSettings,
  completedSteps,
}) => {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(project.name);

  const commitName = () => {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== project.name) {
      onRenameProject(trimmed);
    } else {
      setDraftName(project.name);
    }
    setEditingName(false);
  };

  return (
    <div className="sticky top-0 z-30 bg-[#0B0F17]/95 backdrop-blur-md border-b border-slate-800/80">
      {/* Primary Top Bar (3-zone contract) */}
      <header className="max-w-[1440px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
        {/* Zone 1: Brand Wordmark */}
        <div className="flex items-center gap-4 min-w-0 shrink-0">
          <span className="font-editorial text-lg font-semibold tracking-tight text-[#F3F5F9] whitespace-nowrap shrink-0">
            Belgesel Stüdyosu
          </span>
        </div>

        {/* Zone 2: Active Project Context (Editable Title) */}
        <div className="hidden md:flex items-center justify-center min-w-0 flex-1 max-w-md">
          {editingName ? (
            <input
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName();
                if (e.key === 'Escape') {
                  setDraftName(project.name);
                  setEditingName(false);
                }
              }}
              autoFocus
              className="w-full bg-[#131924] border border-[#D99B26]/60 rounded-md px-3 py-1.5 text-sm text-slate-100 focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraftName(project.name);
                setEditingName(true);
              }}
              title="Proje adını düzenle"
              className="group flex items-center gap-2 text-sm text-slate-300 hover:text-white transition-colors truncate max-w-full px-2 py-1 rounded-md hover:bg-slate-800/50"
            >
              <span className="truncate">{project.name}</span>
              <Pencil className="w-3.5 h-3.5 text-slate-500 group-hover:text-slate-300 shrink-0" />
            </button>
          )}
        </div>

        {/* Zone 3: Utility Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onOpenProjects}
            className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800/70 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FolderOpen className="w-4 h-4 text-slate-400" />
            <span>Projeler</span>
          </button>

          <button
            type="button"
            onClick={onOpenReadme}
            className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800/70 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <BookOpen className="w-4 h-4 text-slate-400" />
            <span className="hidden sm:inline">Kullanım Kılavuzu</span>
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Settings className="w-4 h-4" />
            <span>Ayarlar</span>
          </button>
        </div>
      </header>

      {/* Horizontal 6-Step Stepper */}
      <nav
        aria-label="Üretim adımları"
        className="border-t border-slate-800/60 bg-[#0E131D]/80"
      >
        <div className="max-w-[1440px] mx-auto px-6 overflow-x-auto">
          <ol className="flex items-center justify-between min-w-[780px] py-2 gap-1">
            {STEPS.map((item) => {
              const isActive = activeStep === item.step;
              const isDone = completedSteps[item.step];

              return (
                <li key={item.step} className="flex-1">
                  <button
                    type="button"
                    onClick={() => onSelectStep(item.step)}
                    className={`w-full flex items-center justify-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                      isActive
                        ? 'bg-[#1A2230] text-[#F5F7FA] ring-1 ring-[#D99B26]/50'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                    }`}
                  >
                    <span
                      className={`font-mono tabular-nums text-[11px] flex items-center justify-center w-5 h-5 rounded-md shrink-0 ${
                        isActive
                          ? 'bg-[#D99B26] text-[#0B0F17] font-semibold'
                          : isDone
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : 'bg-slate-800/80 text-slate-400'
                      }`}
                    >
                      {isDone && !isActive ? <Check className="w-3 h-3" /> : item.shortTitle}
                    </span>
                    <span className="truncate">{item.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </nav>
    </div>
  );
};
