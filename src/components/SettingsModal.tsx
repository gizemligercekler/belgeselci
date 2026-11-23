import React, { useState, useEffect } from 'react';
import { X, Eye, EyeOff, Check } from 'lucide-react';
import { DeepgramModel, EditorSettings } from '../types/editor';

interface SettingsModalProps {
  open: boolean;
  settings: EditorSettings;
  hasServerGeminiKey: boolean;
  hasDeepgramKey: boolean;
  onSave: (next: EditorSettings) => void;
  onClose: () => void;
}

const DEEPGRAM_MODEL_OPTIONS: Array<{ id: DeepgramModel; label: string; note: string }> = [
  {
    id: 'nova-3',
    label: 'nova-3',
    note: 'Varsayılan — Türkçe için en yüksek doğruluk',
  },
  {
    id: 'nova-2',
    label: 'nova-2',
    note: 'Hızlı & ekonomik',
  },
];

const ALIGNMENT_MODEL_OPTIONS = [
  { id: 'gemini-4-hydrogen', label: 'gemini-4-hydrogen (Önerilen · Free Tier)' },
  { id: 'gemini-3.8-flash', label: 'gemini-3.8-flash (Yedek)' },
  { id: 'gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite (Hızlı)' },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  settings,
  hasServerGeminiKey,
  hasDeepgramKey,
  onSave,
  onClose,
}) => {
  const [deepgramApiKey, setDeepgramApiKey] = useState(settings.deepgramApiKey || '');
  const [deepgramModel, setDeepgramModel] = useState<DeepgramModel>(
    settings.deepgramModel === 'nova-2' ? 'nova-2' : 'nova-3'
  );
  const [alignmentModel, setAlignmentModel] = useState(
    settings.alignmentModel || 'gemini-4-hydrogen'
  );
  const [customApiKey, setCustomApiKey] = useState(settings.customApiKey || '');
  const [showDeepgramKey, setShowDeepgramKey] = useState(false);
  const [showGeminiKey, setShowGeminiKey] = useState(false);

  useEffect(() => {
    if (open) {
      setDeepgramApiKey(settings.deepgramApiKey || '');
      setDeepgramModel(settings.deepgramModel === 'nova-2' ? 'nova-2' : 'nova-3');
      setAlignmentModel(settings.alignmentModel || 'gemini-4-hydrogen');
      setCustomApiKey(settings.customApiKey || '');
    }
  }, [open, settings]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      deepgramApiKey: deepgramApiKey.trim(),
      deepgramModel,
      alignmentModel: alignmentModel.trim() || 'gemini-4-hydrogen',
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

        <form onSubmit={handleSubmit} className="max-h-[82vh] space-y-5 overflow-y-auto p-5">
          {/* 1. Deepgram Pre-Recorded Audio Transcription */}
          <div className="space-y-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="deepgram-api-key" className="block text-xs font-medium text-[#CBD5E1]">
                  Deepgram API Anahtarı
                </label>
                <span className="font-mono text-[11px] text-[#94A3B8]">
                  {hasDeepgramKey ? 'Sunucu anahtarı hazır' : 'Sunucu anahtarı yok'}
                </span>
              </div>
              <div className="relative">
                <input
                  id="deepgram-api-key"
                  type={showDeepgramKey ? 'text' : 'password'}
                  value={deepgramApiKey}
                  onChange={(e) => setDeepgramApiKey(e.target.value)}
                  placeholder="Boş bırakırsanız sunucu DEEPGRAM_API_KEY kullanılır"
                  autoComplete="off"
                  className="w-full rounded-md border border-white/[0.1] bg-[#0B0F17] py-2 pl-3 pr-9 font-mono text-xs text-[#F1F5F9] placeholder-[#475569] focus:border-[#D99B26]/60 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowDeepgramKey((v) => !v)}
                  aria-label={showDeepgramKey ? 'Deepgram anahtarını gizle' : 'Deepgram anahtarını göster'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#64748B] hover:text-[#CBD5E1]"
                >
                  {showDeepgramKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-[#64748B]">
                Ücretsiz $200 kredi:{' '}
                <span className="font-mono text-[#94A3B8]">console.deepgram.com</span>{' '}
                (kredi kartı gerekmez)
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="deepgram-model-select" className="block text-xs font-medium text-[#CBD5E1]">
                Transkript Modeli <span className="font-normal text-[#64748B]">(Deepgram)</span>
              </label>
              <select
                id="deepgram-model-select"
                value={deepgramModel}
                onChange={(e) =>
                  setDeepgramModel(e.target.value === 'nova-2' ? 'nova-2' : 'nova-3')
                }
                className="w-full rounded-md border border-white/[0.1] bg-[#0B0F17] px-3 py-2 text-xs text-[#F1F5F9] focus:border-[#D99B26]/60 focus:outline-none"
              >
                {DEEPGRAM_MODEL_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id} className="bg-[#0B0F17] text-[#F1F5F9]">
                    {opt.label} ({opt.note})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 2. Gemini Image-to-Transcript Alignment Only */}
          <div className="space-y-3 border-t border-white/[0.06] pt-4">
            <div className="space-y-2">
              <label
                htmlFor="gemini-alignment-model-input"
                className="block text-xs font-medium text-[#CBD5E1]"
              >
                Görsel–Transkript Eşleştirme Modeli <span className="font-normal text-[#64748B]">(Gemini)</span>
              </label>
              <input
                id="gemini-alignment-model-input"
                type="text"
                value={alignmentModel}
                onChange={(e) => setAlignmentModel(e.target.value)}
                placeholder="gemini-4-hydrogen"
                className="w-full rounded-md border border-white/[0.1] bg-[#0B0F17] px-3 py-2 font-mono text-sm text-[#F1F5F9] placeholder-[#475569] focus:border-[#D99B26]/60 focus:outline-none"
              />
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {ALIGNMENT_MODEL_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setAlignmentModel(opt.id)}
                    className={`rounded border px-2 py-1 font-mono text-[11px] transition-colors ${
                      alignmentModel.trim() === opt.id
                        ? 'border-[#D99B26]/50 bg-[#D99B26]/10 text-[#F1F5F9]'
                        : 'border-white/[0.08] bg-[#0B0F17] text-[#94A3B8] hover:border-white/[0.16] hover:text-[#F1F5F9]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="custom-api-key" className="block text-xs font-medium text-[#CBD5E1]">
                  Özel Gemini API Anahtarı <span className="font-normal text-[#64748B]">(İsteğe bağlı)</span>
                </label>
                <span className="font-mono text-[11px] text-[#94A3B8]">
                  {hasServerGeminiKey ? 'Sunucu anahtarı hazır' : 'Sunucu anahtarı yok'}
                </span>
              </div>
              <div className="relative">
                <input
                  id="custom-api-key"
                  type={showGeminiKey ? 'text' : 'password'}
                  value={customApiKey}
                  onChange={(e) => setCustomApiKey(e.target.value)}
                  placeholder="Boş bırakırsanız sunucu GEMINI_API_KEY kullanılır"
                  autoComplete="off"
                  className="w-full rounded-md border border-white/[0.1] bg-[#0B0F17] py-2 pl-3 pr-9 font-mono text-xs text-[#F1F5F9] placeholder-[#475569] focus:border-[#D99B26]/60 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowGeminiKey((v) => !v)}
                  aria-label={showGeminiKey ? 'Gemini anahtarını gizle' : 'Gemini anahtarını göster'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#64748B] hover:text-[#CBD5E1]"
                >
                  {showGeminiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-[#64748B]">
                Yalnızca görsel–transkript eşleştirmesi için kullanılır; ses transkripti Deepgram ile yapılır.
              </p>
            </div>
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
