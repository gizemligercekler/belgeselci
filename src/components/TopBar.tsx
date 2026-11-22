import React from 'react';
import { RotateCcw, Settings, Film } from 'lucide-react';
import { WizardStep } from '../types/editor';

interface TopBarProps {
  activeStep: WizardStep;
  canAccessStep2: boolean;
  canAccessStep3: boolean;
  hasAnyData: boolean;
  onSelectStep: (step: WizardStep) => void;
  onOpenSettings: () => void;
  onResetSession: () => void;
}

const STEPS: Array<{ step: WizardStep; num: string; label: string }> = [
  { step: 1, num: '01', label: 'Ses & Görseller' },
  { step: 2, num: '02', label: 'Zaman Çizelgesi' },
  { step: 3, num: '03', label: 'Dışa Aktar' },
];

export const TopBar: React.FC<TopBarProps> = ({
  activeStep,
  canAccessStep2,
  canAccessStep3,
  hasAnyData,
  onSelectStep,
  onOpenSettings,
  onResetSession,
}) => {
  const isStepClickable = (step: WizardStep) => {
    if (step === 1) return true;
    if (step === 2) return canAccessStep2;
    return canAccessStep3;
  };

  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#0B0F17]/95 backdrop-blur-md">
      <div className="mx-auto max-w-[1280px] px-4 sm:px-6">
        <div className="flex h-14 items-center justify-between gap-4">
          {/* Left: Minimalist Wordmark */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md border border-[#D99B26]/30 bg-[#D99B26]/10 text-[#D99B26]">
              <Film className="h-4 w-4" />
            </div>
            <div className="flex items-baseline gap-2.5">
              <span className="font-display text-lg font-medium tracking-tight text-[#F1F5F9]">
                Belgesel Kurgu Asistanı
              </span>
              <span className="hidden text-xs text-[#64748B] sm:inline">
                16:9 Zaman Çizelgesi &amp; Render Stüdyosu
              </span>
            </div>
          </div>

          {/* Center: Clean 3-step horizontal navigation (desktop) */}
          <nav aria-label="Kurgu Adımları" className="hidden items-center gap-1 md:flex">
            {STEPS.map((item, idx) => {
              const active = activeStep === item.step;
              const enabled = isStepClickable(item.step);
              return (
                <React.Fragment key={item.step}>
                  <button
                    type="button"
                    disabled={!enabled}
                    onClick={() => enabled && onSelectStep(item.step)}
                    className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors ${
                      active
                        ? 'bg-[#1A2230] text-[#F1F5F9] font-medium'
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
                    <span className="mx-1 h-px w-4 bg-white/[0.08]" aria-hidden="true" />
                  )}
                </React.Fragment>
              );
            })}
          </nav>

          {/* Right: Quiet Actions */}
          <div className="flex items-center gap-2">
            {hasAnyData && (
              <button
                type="button"
                onClick={onResetSession}
                title="Mevcut kurguyu temizle ve yeni kurgu başlat"
                className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-transparent px-2.5 py-1.5 text-xs font-medium text-[#94A3B8] transition-colors hover:border-white/[0.15] hover:bg-white/[0.04] hover:text-[#F1F5F9]"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Yeni Kurgu</span>
              </button>
            )}
            <button
              type="button"
              onClick={onOpenSettings}
              className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-[#131924] px-2.5 py-1.5 text-xs font-medium text-[#CBD5E1] transition-colors hover:border-white/[0.16] hover:bg-[#1A2230] hover:text-[#F1F5F9]"
            >
              <Settings className="h-3.5 w-3.5 text-[#94A3B8]" />
              <span>Ayarlar</span>
            </button>
          </div>
        </div>

        {/* Mobile Step Bar */}
        <nav
          aria-label="Kurgu Adımları Mobil"
          className="flex items-center justify-between gap-1 border-t border-white/[0.05] py-2 md:hidden"
        >
          {STEPS.map((item) => {
            const active = activeStep === item.step;
            const enabled = isStepClickable(item.step);
            return (
              <button
                key={item.step}
                type="button"
                disabled={!enabled}
                onClick={() => enabled && onSelectStep(item.step)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
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
        </nav>
      </div>
    </header>
  );
};
