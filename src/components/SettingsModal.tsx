import React, { useState, useEffect } from 'react';
import { X, Eye, EyeOff, Check } from 'lucide-react';
import { EditorSettings } from '../types/editor';

interface SettingsModalProps {
  open: boolean;
  settings: EditorSettings;
  hasServerGeminiKey: boolean;
  onSave: (next: EditorSettings) => void;
  onClose: () => void;
}

const MODEL_OPTIONS = [
  { id: 'gemini-3.8-flash', label: 'gemini-3.8-flash (Varsayılan · Free Tier)' },
  { id: 'gemini-4-hydrogen', label: 'gemini-4-hydrogen' },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  settings,
  hasServerGeminiKey,
  onSave,
  onClose,
}) => {
  const [model, setModel] = useState(settings.model);
  const [customApiKey, setCustomApiKey] = useState(settings.customApiKey);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (open) {
      setModel(settings.model);
      setCustomApiKey(settings.customApiKey);
    }
  }, [open, settings]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      model: model.trim() || 'gemini-3.8-flash',
      customApiKey: customApiKey.trim(),
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-white/[0.1] bg-[#131924] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
          <h2 id="settings-modal-title" className="font-display text-lg font-medium text-[#F1F5F9]">
            Ayarlar
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Kapat"
            className="rounded-md p-1 text-[#94A3B8] transition-colors hover:bg-white/[0.05] hover:text-[#F1F5F9]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 p-5">
          {/* Model Selection */}
          <div className="space-y-2">
            <label htmlFor="gemini-model-input" className="block text-xs font-medium text-[#CBD5E1]">
              Gemini Modeli (Transkript &amp; Görsel Eşleştirme)
            </label>
            <input
              id="gemini-model-input"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gemini-3.8-flash"
              className="w-full rounded-md border border-white/[0.1] bg-[#0B0F17] px-3 py-2 font-mono text-sm text-[#F1F5F9] placeholder-[#475569] focus:border-[#D99B26]/60 focus:outline-none"
            />
            <div className="flex flex-wrap gap-2 pt-0.5">
              {MODEL_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setModel(opt.id)}
                  className={`rounded border px-2 py-1 font-mono text-[11px] transition-colors ${
                    model.trim() === opt.id
                      ? 'border-[#D99B26]/50 bg-[#D99B26]/10 text-[#F1F5F9]'
                      : 'border-white/[0.08] bg-[#0B0F17] text-[#94A3B8] hover:border-white/[0.16] hover:text-[#F1F5F9]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Optional Single API Key Override for Local PC Use */}
          <div className="space-y-2 border-t border-white/[0.06] pt-4">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="custom-api-key" className="block text-xs font-medium text-[#CBD5E1]">
                Özel Gemini API Anahtarı <span className="font-normal text-[#64748B]">(İsteğe bağlı)</span>
              </label>
              <span className="font-mono text-[11px] text-[#94A3B8]">
                {hasServerGeminiKey ? 'Sunucu anahtarı hazır' : 'Sunucu anahtarı tanımlı değil'}
              </span>
            </div>
            <div className="relative">
              <input
                id="custom-api-key"
                type={showKey ? 'text' : 'password'}
                value={customApiKey}
                onChange={(e) => setCustomApiKey(e.target.value)}
                placeholder="Boş bırakırsanız sunucu GEMINI_API_KEY kullanılır"
                autoComplete="off"
                className="w-full rounded-md border border-white/[0.1] bg-[#0B0F17] py-2 pl-3 pr-9 font-mono text-xs text-[#F1F5F9] placeholder-[#475569] focus:border-[#D99B26]/60 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? 'Anahtarı gizle' : 'Anahtarı göster'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#64748B] hover:text-[#CBD5E1]"
              >
                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-[#64748B]">
              Bulutta sunucu anahtarı otomatik kullanılır. Uygulamayı kendi bilgisayarınızda çalıştırıyorsanız
              isteğe bağlı olarak Free Tier anahtarınızı buraya girebilirsiniz.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-white/[0.07] pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-white/[0.08] px-3.5 py-2 text-xs font-medium text-[#94A3B8] transition-colors hover:bg-white/[0.04] hover:text-[#F1F5F9]"
            >
              Vazgeç
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 rounded-md bg-[#D99B26] px-4 py-2 text-xs font-semibold text-[#0B0F17] transition-colors hover:bg-[#E5AA38]"
            >
              <Check className="h-3.5 w-3.5" />
              <span>Kaydet</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
