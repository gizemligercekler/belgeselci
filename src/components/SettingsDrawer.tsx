import React from 'react';
import { X, RotateCcw, ShieldCheck, KeyRound, Sliders, Volume2 } from 'lucide-react';
import { ImageResolution, StudioSettings, TierMode, VisualWorkflowMode } from '../types/studio';
import { DEFAULT_STUDIO_SETTINGS } from '../data/defaults';
import { parseFreeApiKeys, ServerHealthStatus } from '../services/geminiService';

interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  settings: StudioSettings;
  onChange: (next: StudioSettings) => void;
  serverHealth: ServerHealthStatus;
}

const VOICE_PRESETS = ['Charon', 'Kore', 'Puck', 'Fenrir', 'Zephyr', 'Aoede', 'Orus'];

export const SettingsDrawer: React.FC<SettingsDrawerProps> = ({
  open,
  onClose,
  settings,
  onChange,
  serverHealth,
}) => {
  if (!open) return null;

  const update = <K extends keyof StudioSettings>(key: K, value: StudioSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  const handleTierSwitch = (mode: TierMode) => {
    onChange({
      ...settings,
      tierMode: mode,
      interRequestDelaySec: mode === 'paid' ? 0.2 : 2,
    });
  };

  const freeKeyCount = parseFreeApiKeys(settings).length;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-xs">
      <div
        className="w-full max-w-2xl bg-[#111722] border-l border-slate-800 h-full flex flex-col shadow-2xl"
        role="dialog"
        aria-label="Stüdyo Ayarları"
      >
        {/* Drawer Header */}
        <div className="px-6 py-5 border-b border-slate-800 flex items-center justify-between gap-4 shrink-0">
          <div>
            <h2 className="font-editorial text-xl font-semibold text-slate-100">
              Stüdyo Ayarları
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              API kota yönetimi, model seçimleri ve Türkçe TTS kuralları
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...DEFAULT_STUDIO_SETTINGS,
                  freeApiKeysText: settings.freeApiKeysText,
                  paidApiKey: settings.paidApiKey,
                  pexelsApiKey: settings.pexelsApiKey,
                })
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-300 hover:text-white border border-slate-700/80 rounded-lg hover:bg-slate-800/70 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Varsayılanlara Dön</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Kapat"
              className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800/70 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">
          {/* SECTION 1: API & Kota Modu */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <KeyRound className="w-4 h-4 text-[#D99B26]" />
              <h3>API ve Kota Modu (Tier)</h3>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleTierSwitch('free')}
                className={`text-left p-4 rounded-xl border transition-colors cursor-pointer ${
                  settings.tierMode === 'free'
                    ? 'bg-[#1A2230] border-[#D99B26]/70 text-slate-100'
                    : 'bg-[#0E131D] border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="text-sm font-semibold">Ücretsiz Kota (Free Tier)</div>
                <p className="text-xs text-slate-400 mt-1">
                  Çoklu key rotasyonu + 429 kota aşımında güvenli bekleme
                </p>
              </button>

              <button
                type="button"
                onClick={() => handleTierSwitch('paid')}
                className={`text-left p-4 rounded-xl border transition-colors cursor-pointer ${
                  settings.tierMode === 'paid'
                    ? 'bg-[#1A2230] border-[#D99B26]/70 text-slate-100'
                    : 'bg-[#0E131D] border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="text-sm font-semibold">Ücretli Kota (Paid Tier)</div>
                <p className="text-xs text-slate-400 mt-1">
                  Tek anahtar, hızlı / beklemesiz (0.2s gecikme) üretim
                </p>
              </button>
            </div>

            {/* Server Fallback Note */}
            <div className="flex items-start gap-2.5 text-xs text-slate-400 bg-[#0E131D] border border-slate-800/80 rounded-lg p-3">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-slate-300">
                  Sunucu Yedek Durumu:{' '}
                  <span className="font-mono">
                    GEMINI_API_KEY ({serverHealth.hasServerGeminiKey ? 'Hazır' : 'Tanımlı değil'}) ·
                    PEXELS_API_KEY ({serverHealth.hasServerPexelsKey ? 'Hazır' : 'Opsiyonel'})
                  </span>
                </p>
                <p>
                  Aşağıdaki alanları boş bırakırsanız sunucu ortam değişkenleri otomatik yedek
                  olarak kullanılır. Kendi anahtarlarınızı girdiğinizde istek anında güvenli
                  şekilde sunucu proxy&apos;sine iletilir.
                </p>
              </div>
            </div>

            {settings.tierMode === 'free' ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-slate-300">
                    Ücretsiz Gemini API Anahtarları (Satır başına bir anahtar — 429 Rotasyonu)
                  </label>
                  <span className="text-xs font-mono tabular-nums text-slate-400">
                    {freeKeyCount > 0 ? `${freeKeyCount} anahtar tanımlı` : 'Sunucu yedeği aktif'}
                  </span>
                </div>
                <textarea
                  rows={4}
                  value={settings.freeApiKeysText}
                  onChange={(e) => update('freeApiKeysText', e.target.value)}
                  placeholder={'AIzaSy... (1. Anahtar)\nAIzaSy... (2. Anahtar)\nAIzaSy... (3. Anahtar)'}
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3.5 py-2.5 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-[#D99B26]/60"
                />
              </div>
            ) : (
              <div className="space-y-2">
                <label className="text-xs font-medium text-slate-300">
                  Ücretli (Paid Tier) Gemini API Anahtarı (Opsiyonel)
                </label>
                <input
                  type="password"
                  value={settings.paidApiKey}
                  onChange={(e) => update('paidApiKey', e.target.value)}
                  placeholder="Boş bırakılırsa sunucu GEMINI_API_KEY kullanılır"
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3.5 py-2.5 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-[#D99B26]/60"
                />
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">
                  429 Kota Bekleme Süresi (RPM_RETRY_WAIT_SEC)
                </label>
                <input
                  type="number"
                  min={5}
                  max={120}
                  value={settings.rpmRetryWaitSec}
                  onChange={(e) => update('rpmRetryWaitSec', Math.max(5, Number(e.target.value) || 25))}
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono tabular-nums text-slate-100 focus:outline-none focus:border-[#D99B26]/60"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">
                  İstekler Arası Bekleme (INTER_REQUEST_DELAY_SEC)
                </label>
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={30}
                  value={settings.interRequestDelaySec}
                  onChange={(e) => update('interRequestDelaySec', Math.max(0, Number(e.target.value) || 0))}
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono tabular-nums text-slate-100 focus:outline-none focus:border-[#D99B26]/60"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">
                Pexels API Anahtarı (Opsiyonel — 16:9 Ücretsiz Stok Video Araması)
              </label>
              <input
                type="password"
                value={settings.pexelsApiKey}
                onChange={(e) => update('pexelsApiKey', e.target.value)}
                placeholder="pexels.com/api adresinden ücretsiz alınabilir"
                className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3.5 py-2.5 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-[#D99B26]/60"
              />
            </div>
          </section>

          <hr className="border-slate-800/80" />

          {/* SECTION 2: Model Ayarları */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Sliders className="w-4 h-4 text-[#D99B26]" />
              <h3>Model Ayarları (Düzenlenebilir)</h3>
            </div>

            {/* Text / Script Model */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-300">
                Senaryo, Editör &amp; Storyboard LLM Modeli
              </label>
              <input
                type="text"
                value={settings.scriptModel}
                onChange={(e) => update('scriptModel', e.target.value)}
                className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3.5 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-[#D99B26]/60"
              />
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-500">Hızlı seçim:</span>
                {['gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-2.5-flash', 'gemini-4-neon'].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => update('scriptModel', m)}
                    className={`px-2.5 py-1 rounded-md font-mono transition-colors cursor-pointer ${
                      settings.scriptModel === m
                        ? 'bg-[#D99B26]/20 text-[#F3C669] border border-[#D99B26]/40'
                        : 'bg-slate-800/70 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {/* TTS Model & Voice */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">
                  TTS Seslendirme Modeli (v1beta)
                </label>
                <input
                  type="text"
                  value={settings.ttsModel}
                  onChange={(e) => update('ttsModel', e.target.value)}
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-[#D99B26]/60"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">TTS Ses Karakteri</label>
                <input
                  type="text"
                  value={settings.ttsVoice}
                  onChange={(e) => update('ttsVoice', e.target.value)}
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-[#D99B26]/60"
                />
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {VOICE_PRESETS.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => update('ttsVoice', v)}
                      className={`px-2 py-0.5 text-[11px] rounded font-mono cursor-pointer ${
                        settings.ttsVoice === v
                          ? 'bg-[#D99B26]/20 text-[#F3C669]'
                          : 'bg-slate-800/60 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">
                TTS Stil Yönergesi (speechMetadata.style)
              </label>
              <textarea
                rows={2}
                value={settings.ttsStylePrompt}
                onChange={(e) => update('ttsStylePrompt', e.target.value)}
                className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3.5 py-2 text-xs text-slate-200 focus:outline-none focus:border-[#D99B26]/60"
              />
            </div>

            {/* Visual Mode & Optional Paid Image Model */}
            <div className="p-4 rounded-xl bg-[#0E131D] border border-slate-800/80 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-semibold text-slate-200">
                  Adım 4 Görsel Üretim Modu
                </span>
                <div className="flex items-center gap-1 p-1 bg-[#0B0F17] rounded-lg border border-slate-800">
                  {(
                    [
                      { id: 'manual_free', label: 'Sıfır Maliyetli Manuel' },
                      { id: 'auto_api', label: 'Otomatik API (Opsiyonel)' },
                    ] as Array<{ id: VisualWorkflowMode; label: string }>
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => update('visualWorkflowMode', opt.id)}
                      className={`px-2.5 py-1 text-xs rounded-md transition-colors cursor-pointer ${
                        settings.visualWorkflowMode === opt.id
                          ? 'bg-[#1A2230] text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2 space-y-1">
                  <label className="text-xs text-slate-400">
                    Görsel Modeli (Yalnızca Otomatik API modunda kullanılır)
                  </label>
                  <input
                    type="text"
                    value={settings.imageModel}
                    onChange={(e) => update('imageModel', e.target.value)}
                    className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-[#D99B26]/60"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-slate-400">Çözünürlük</label>
                  <select
                    value={settings.imageResolution}
                    onChange={(e) => update('imageResolution', e.target.value as ImageResolution)}
                    className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-[#D99B26]/60"
                  >
                    <option value="1K">1K</option>
                    <option value="2K">2K (Varsayılan)</option>
                    <option value="4K">4K</option>
                  </select>
                </div>
              </div>
            </div>
          </section>

          <hr className="border-slate-800/80" />

          {/* SECTION 3: TTS & Metin İşleme */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Volume2 className="w-4 h-4 text-[#D99B26]" />
              <h3>Türkçe TTS &amp; Ses Birleştirme Kuralları</h3>
            </div>

            {/* CRITICAL TOGGLE: excludeChapterPrefix */}
            <div className="p-4 rounded-xl bg-[#161D2B] border border-[#D99B26]/35 space-y-2.5">
              <label className="flex items-start justify-between gap-4 cursor-pointer">
                <div>
                  <div className="text-sm font-semibold text-slate-100">
                    Bölüm ön eklerini seslendirmeden çıkar (Exclude &quot;BÖLÜM X:&quot;)
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    Açıkken hem rakamlı (&quot;### BÖLÜM 2:&quot;) hem yazıyla yazılmış (&quot;BÖLÜM
                    iki:&quot;) ön ekler silinir ve seslendirme yalnızca başlığı okur. Kapalıyken
                    sıra sayısına dönüştürülür.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.excludeChapterPrefix}
                  onChange={(e) => update('excludeChapterPrefix', e.target.checked)}
                  className="mt-1 h-4 w-4 accent-[#D99B26] rounded cursor-pointer shrink-0"
                />
              </label>

              <div className="text-xs font-mono bg-[#0B0F17] border border-slate-800 rounded-lg p-3 space-y-1">
                <div className="text-slate-500">
                  Girdi: BÖLÜM iki: KAVRAM KARMAŞASI — HANGİ KİTAPTAN BAHSEDİYORUZ?
                </div>
                <div className="text-emerald-400">
                  TTS Çıktısı:{' '}
                  {settings.excludeChapterPrefix
                    ? 'KAVRAM KARMAŞASI — HANGİ KİTAPTAN BAHSEDİYORUZ? <short pause>'
                    : 'İkinci Bölüm: KAVRAM KARMAŞASI — HANGİ KİTAPTAN BAHSEDİYORUZ? <short pause>'}
                </div>
              </div>
            </div>

            {/* OPTIONAL TOGGLE: speakBolumTag */}
            <div className="p-4 rounded-xl bg-[#0E131D] border border-slate-800 space-y-2.5">
              <label className="flex items-start justify-between gap-4 cursor-pointer">
                <div>
                  <div className="text-sm font-medium text-slate-100">
                    [[BOLUM]] etiketindeki başlığı seslendir
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    Açıkken <code className="font-mono text-slate-300">[[BOLUM: Başlık]]</code>{' '}
                    etiketinin çerçevesi kaldırılır; başlık hem ekran alt bandı olarak kaydedilir hem
                    de seslendirilir. Bitişik satırda aynı başlık tekrar ediyorsa iki kez okunmaz.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.speakBolumTag ?? true}
                  onChange={(e) => update('speakBolumTag', e.target.checked)}
                  className="mt-1 h-4 w-4 accent-[#D99B26] rounded cursor-pointer shrink-0"
                />
              </label>

              <div className="text-xs font-mono bg-[#0B0F17] border border-slate-800 rounded-lg p-2.5 space-y-1">
                <div className="text-slate-500">
                  Girdi: [[BOLUM: GİRİŞ — ÇÖLÜN SESSİZ TANIKLARI]]
                </div>
                <div className="text-emerald-400">
                  TTS Çıktısı:{' '}
                  {(settings.speakBolumTag ?? true)
                    ? 'GİRİŞ — ÇÖLÜN SESSİZ TANIKLARI. <short pause>'
                    : '(Seslendirilmez — yalnızca bölüm görsel alt bandı eklenir)'}
                </div>
              </div>
            </div>

            {/* MAX_CHUNK_SIZE */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <label className="font-medium text-slate-300">
                  Maksimum Parça Uzunluğu (MAX_CHUNK_SIZE)
                </label>
                <span className="font-mono tabular-nums text-[#F3C669]">
                  {settings.maxChunkSize} karakter
                </span>
              </div>
              <input
                type="range"
                min={600}
                max={4500}
                step={100}
                value={settings.maxChunkSize}
                onChange={(e) => update('maxChunkSize', Number(e.target.value))}
                className="w-full accent-[#D99B26] cursor-pointer"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">
                  Normal Parça Arası Sessizlik (ms)
                </label>
                <input
                  type="number"
                  min={0}
                  max={5000}
                  step={50}
                  value={settings.normalPauseMs}
                  onChange={(e) => update('normalPauseMs', Math.max(0, Number(e.target.value) || 0))}
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono tabular-nums text-slate-100 focus:outline-none focus:border-[#D99B26]/60"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">
                  Bölüm Geçiş Sessizliği (ms)
                </label>
                <input
                  type="number"
                  min={0}
                  max={8000}
                  step={100}
                  value={settings.chapterPauseMs}
                  onChange={(e) => update('chapterPauseMs', Math.max(0, Number(e.target.value) || 0))}
                  className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg px-3 py-2 text-sm font-mono tabular-nums text-slate-100 focus:outline-none focus:border-[#D99B26]/60"
                />
              </div>
            </div>

            <label className="flex items-start justify-between gap-4 p-3.5 rounded-xl bg-[#0E131D] border border-slate-800 cursor-pointer">
              <div>
                <div className="text-sm font-medium text-slate-200">
                  Nazik Ses Normalizasyonu (GENTLE_NORMALIZE)
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  Yerel FFmpeg birleştirmede -16 LUFS yayın ses seviyesi ve 10ms kenar fade-in/out
                  uygular.
                </p>
              </div>
              <input
                type="checkbox"
                checked={settings.gentleNormalize}
                onChange={(e) => update('gentleNormalize', e.target.checked)}
                className="mt-1 h-4 w-4 accent-[#D99B26] rounded cursor-pointer shrink-0"
              />
            </label>
          </section>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-800 bg-[#0E131D] flex items-center justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 text-sm font-medium text-[#0B0F17] bg-[#D99B26] hover:bg-[#E8AF3C] rounded-lg transition-colors cursor-pointer"
          >
            Ayarları Kaydet ve Kapat
          </button>
        </div>
      </div>
    </div>
  );
};
