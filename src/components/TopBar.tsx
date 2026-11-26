import React from 'react';
import { RotateCcw, Settings, Film, FileText } from 'lucide-react';
import { WizardStep } from '../types/editor';

export type AppView = 'editor' | 'transcribe';

interface TopBarProps {
  activeView: AppView;
  activeStep: WizardStep;
  canAccessStep2: boolean;
  canAccessStep3: boolean;
  hasAnyData: boolean;
  onSelectStep: (step: WizardStep) => void;
  onSelectTranscribeView: () => void;
  onOpenSettings: () => void;
  onResetSession: () => void;
}

const STEPS: Array<{ step: WizardStep; num: string; label: string }> = [
  { step: 1, num: '01', label: 'Ses & Görseller' },
  { step: 2, num: '02', label: 'Zaman Çizelgesi' },
  { step: 3, num: '03', label: 'Dışa Aktar' },
];

export const TopBar: React.FC<TopBarProps> = ({
  activeView,
  activeStep,
  canAccessStep2,
  canAccessStep3,
  hasAnyData,
  onSelectStep,
  onSelectTranscribeView,
  onOpenSettings,
  onResetSession,
}) => {
  const isStepClickable = (step: WizardStep) => {
    if (step === 1) return true;
    if (step === 2) return canAccessStep2;
    return canAccessStep3;
  };

  const isTranscribeActive = activeView === 'transcribe';

  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#0B0F17]/95 backdrop-blur-md">
      <div className="mx-auto max-w-[1280px] px-4 sm:px-6">
        <div className="flex h-14 items-center justify-between gap-4">
          {/* Left: Minimalist Wordmark */}
          <div className="flex shrink-0 items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md border border-[#D99B26]/30 bg-[#D99B26]/10 text-[#D99B26]">
              <Film className="h-4 w-4" />
            </div>
            <span className="whitespace-nowrap font-display text-lg font-medium tracking-tight text-[#F1F5F9]">
              Belgesel Kurgu Asistanı
            </span>
          </div>

          {/* Center: 3-step editor navigation + separate standalone Transkript tool (desktop) */}
          <nav aria-label="Ana Gezinme" className="hidden items-center gap-1 md:flex">
            {STEPS.map((item, idx) => {
              const active = activeView === 'editor' && activeStep === item.step;
              const enabled = isStepClickable(item.step);
              return (
                <React.Fragment key={item.step}>
                  <button
                    type="button"
                    disabled={!enabled}
                    onClick={() => enabled && onSelectStep(item.step)}
                    className={`flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors ${
                      active
                        ? 'bg-[#1A2230] font-medium text-[#F1F5F9]'
                        : enabled
                          ? 'text-[#94A3B8] hover:bg-white/[0.04] hover:text-[#F1F5F9]'
                          : 'cursor-not-allowed text-[#475569]'
                    }`}
                  >
                    <span
                      className={`font-mono text-xs tabular-nums ${
                        active ? 'text-[#D99B26]' : enabled ? 'text-[#64748B]' : 'text-[#334155]'
                      }`}
                    >
                      {item.num}
                    </span>
                    <span>{item.label}</span>
                  </button>
                  {idx < STEPS.length - 1 && (
                    <span className="mx-0.5 h-px w-3 bg-white/[0.08]" aria-hidden="true" />
                  )}
                </React.Fragment>
              );
            })}

            <span className="mx-2 h-4 w-px bg-white/[0.12]" aria-hidden="true" />

            <button
              type="button"
              onClick={onSelectTranscribeView}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors ${
                isTranscribeActive
                  ? 'bg-[#1A2230] font-medium text-[#F1F5F9]'
                  : 'text-[#94A3B8] hover:bg-white/[0.04] hover:text-[#F1F5F9]'
              }`}
            >
              <FileText
                className={`h-3.5 w-3.5 ${isTranscribeActive ? 'text-[#D99B26]' : 'text-[#64748B]'}`}
              />
              <span>Transkript &amp; Plan</span>
            </button>
          </nav>

          {/* Right: Quiet Actions */}
          <div className="flex shrink-0 items-center gap-2">
            {hasAnyData && activeView === 'editor' && (
              <button
                type="button"
                onClick={onResetSession}
                title="Mevcut kurguyu temizle ve yeni kurgu başlat"
                className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-white/[0.08] bg-transparent px-2.5 py-1.5 text-xs font-medium text-[#94A3B8] transition-colors hover:border-white/[0.15] hover:bg-white/[0.04] hover:text-[#F1F5F9]"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Yeni Kurgu</span>
              </button>
            )}
            <button
              type="button"
              onClick={onOpenSettings}
              className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-white/[0.08] bg-[#131924] px-2.5 py-1.5 text-xs font-medium text-[#CBD5E1] transition-colors hover:border-white/[0.16] hover:bg-[#1A2230] hover:text-[#F1F5F9]"
            >
              <Settings className="h-3.5 w-3.5 text-[#94A3B8]" />
              <span>Ayarlar</span>
            </button>
          </div>
        </div>

        {/* Mobile Navigation Bar */}
        <nav
          aria-label="Ana Gezinme Mobil"
          className="flex items-center justify-between gap-1 border-t border-white/[0.05] py-2 md:hidden"
        >
          {STEPS.map((item) => {
            const active = activeView === 'editor' && activeStep === item.step;
            const enabled = isStepClickable(item.step);
            return (
              <button
                key={item.step}
                type="button"
                disabled={!enabled}
                onClick={() => enabled && onSelectStep(item.step)}
                className={`flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors ${
                  active
                    ? 'bg-[#1A2230] font-medium text-[#F1F5F9]'
                    : enabled
                      ? 'text-[#94A3B8]'
                      : 'cursor-not-allowed text-[#475569]'
                }`}
              >
                <span className={`font-mono tabular-nums ${active ? 'text-[#D99B26]' : ''}`}>
                  {item.num}
                </span>
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={onSelectTranscribeView}
            className={`flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors ${
              isTranscribeActive
                ? 'bg-[#1A2230] font-medium text-[#F1F5F9]'
                : 'text-[#94A3B8]'
            }`}
          >
            <FileText className={`h-3 w-3 shrink-0 ${isTranscribeActive ? 'text-[#D99B26]' : ''}`} />
            <span className="truncate">Transkript &amp; Plan</span>
          </button>
        </nav>
      </div>
    </header>
  );
};
